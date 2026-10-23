/**
 * PostgreSQL {@link SchedulerStorage} over the tables of
 * `migrations/001_initial_persistence.sql`.
 *
 * Data access and validation only. The caller supplies and owns the database
 * connection; nothing here opens connections, reads the environment, applies
 * migrations, or runs work. Each method is one SQL statement, so each is atomic
 * by itself, but nothing makes a whole operation (its state, random, queue, and
 * clock changes) commit together. One scheduler should drive the database at a
 * time; that is assumed, not enforced.
 */

import { moduleId as toModuleId, workItemId as toWorkItemId } from "./identifiers.ts";
import type { WorkItemId } from "./identifiers.ts";
import { copyState } from "./in-memory-state.ts";
import { validateOperationName, validatePositiveCount, validateRequest, validateSequence } from "./scheduler.ts";
import type { SchedulerStorage, StoredWork, WorkIdStatus } from "./scheduler.ts";
import { simTime as toSimTime } from "./sim-time.ts";
import type { SimTime } from "./sim-time.ts";

/**
 * Anything that runs one parameterized SQL statement and resolves to its rows,
 * such as a `pg` `Client`, `Pool`, or `PoolClient`. Each storage method issues
 * exactly one statement, so a pool is safe to use.
 */
export interface PostgresQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** The `runtime_state.format_version` this adapter reads and writes. */
const FORMAT_VERSION = 1;

/** The only encoding whose accepted text the identifier validation matches. */
const REQUIRED_ENCODING = "UTF8";

const unsignedInteger = /^(?:0|[1-9][0-9]*)$/;

/**
 * @internal Converts BIGINT text from the database to a number, rejecting
 * anything that is not a plain decimal integer in `[min, MAX_SAFE_INTEGER]`
 * before conversion could round it.
 */
export function parseStoredInteger(text: unknown, min = 0): number {
  if (typeof text !== "string") {
    throw new TypeError(`expected integer text, received ${text === null ? "null" : typeof text}`);
  }
  if (!unsignedInteger.test(text)) {
    throw new RangeError(`expected a nonnegative decimal integer, received ${JSON.stringify(text)}`);
  }
  const value = BigInt(text);
  if (value < BigInt(min) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${text} is outside ${min} through ${Number.MAX_SAFE_INTEGER}`);
  }
  return Number(value);
}

/** Runs `read` on database-derived data, labelling any validation failure. */
function persisted<T>(what: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw new TypeError(`Invalid persisted ${what}: ${(error as Error).message}`, { cause: error });
  }
}

function validateClient(client: unknown): PostgresQueryable {
  if (typeof client !== "object" || client === null || typeof (client as PostgresQueryable).query !== "function") {
    throw new TypeError("client must be an object with a query(text, values) method, such as a pg Client or Pool");
  }
  return client as PostgresQueryable;
}

async function query(client: PostgresQueryable, text: string, values: unknown[]): Promise<Record<string, unknown>[]> {
  const result = await client.query(text, values);
  if (typeof result !== "object" || result === null || !Array.isArray(result.rows)) {
    throw new TypeError("client.query() must resolve to a result with a rows array");
  }
  return result.rows as Record<string, unknown>[];
}

function missingRuntimeState(): Error {
  return new Error("realmlib.runtime_state has no row; call initializePostgresSchedulerStorage() first");
}

function workIdStatus(value: unknown): Exclude<WorkIdStatus, undefined> {
  if (value !== "pending" && value !== "completed") {
    throw new RangeError(`unknown status ${JSON.stringify(value)}`);
  }
  return value;
}

/** Validates one `work_items` row (BIGINT and JSON columns selected as text). */
function storedWorkFromRow(row: Record<string, unknown>): StoredWork {
  const id = persisted("work_id", () => toWorkItemId(row.work_id as string));
  const where = `work item ${JSON.stringify(id)}`;
  return {
    id,
    at: persisted(`at_ms of ${where}`, () => toSimTime(parseStoredInteger(row.at_ms))),
    sequence: persisted(`sequence of ${where}`, () => parseStoredInteger(row.sequence)),
    request: {
      moduleId: persisted(`module_id of ${where}`, () => toModuleId(row.module_id as string)),
      operation: persisted(`operation of ${where}`, () => validateOperationName(row.operation, "operation")),
      payloadVersion: persisted(`payload_version of ${where}`, () => parseStoredInteger(row.payload_version, 1)),
      payload: persisted(`payload of ${where}`, () => {
        if (typeof row.payload !== "string") throw new TypeError(`expected JSON text, received ${typeof row.payload}`);
        return copyState(JSON.parse(row.payload), "payload");
      }),
    },
  };
}

/**
 * Creates the `realmlib.runtime_state` row for fresh scheduler storage: clock at
 * `initialTime` (default `simTime(0)`), next sequence `0`, no random snapshot,
 * and format version 1. It never overwrites.
 *
 * It first requires the database's `server_encoding` and this connection's
 * `client_encoding` to be UTF8, the encoding the text validation assumes. The
 * server encoding is fixed when a database is created, so this check holds for
 * the database's lifetime. Later connections keep the default client encoding
 * (UTF8 on a UTF8 database) unless the caller overrides it, for example with
 * `client_encoding` or `PGCLIENTENCODING`; keeping them at UTF8 is the caller's
 * responsibility.
 *
 * @throws {TypeError | RangeError} if `client` or `initialTime` is invalid.
 * @throws if either encoding is not UTF8, the row already exists,
 *   `realmlib.work_items` is not empty, or the database reports an error.
 */
export async function initializePostgresSchedulerStorage(
  client: PostgresQueryable,
  initialTime: SimTime = toSimTime(0),
): Promise<void> {
  const db = validateClient(client);
  const now = toSimTime(initialTime);
  const [encodings] = await query(
    db,
    "SELECT current_setting('server_encoding') AS server, current_setting('client_encoding') AS client",
    [],
  );
  for (const [setting, value] of [["server_encoding", encodings?.server], ["client_encoding", encodings?.client]]) {
    if (value !== REQUIRED_ENCODING) {
      throw new Error(
        `Cannot initialize scheduler storage: ${setting} is ${JSON.stringify(value)}, but realmlib requires ${REQUIRED_ENCODING}`,
      );
    }
  }
  const rows = await query(
    db,
    `INSERT INTO realmlib.runtime_state (singleton_id, now_ms, next_sequence, random_snapshot, format_version)
     SELECT 1, $1, 0, NULL, $2
     WHERE NOT EXISTS (SELECT FROM realmlib.work_items)
     RETURNING 1`,
    [String(now), FORMAT_VERSION],
  );
  if (rows.length !== 1) {
    throw new Error("Cannot initialize scheduler storage: realmlib.work_items already has rows");
  }
}

/**
 * Creates {@link SchedulerStorage} that reads and writes the `realmlib` schema
 * through `client`. Creating it runs no queries. The schema must already be
 * migrated and initialized (see {@link initializePostgresSchedulerStorage}).
 *
 * Mapping: the clock and next sequence are `runtime_state.now_ms` and
 * `next_sequence`; work is a `work_items` row whose `status` is `'pending'`,
 * then `'completed'` with `completed_at_ms` set to the stored clock when
 * `markCompleted()` runs. Completed rows are never deleted.
 *
 * Database errors propagate. Missing runtime state or invalid persisted data
 * rejects rather than being reinitialized; invalid persisted data rejects with
 * `TypeError`.
 *
 * @throws {TypeError} if `client` has no `query` method.
 */
export function createPostgresSchedulerStorage(client: PostgresQueryable): SchedulerStorage {
  const db = validateClient(client);

  async function readRuntime(column: "now_ms" | "next_sequence"): Promise<number> {
    const [row] = await query(
      db,
      `SELECT ${column}::text AS value, format_version::text AS format_version
       FROM realmlib.runtime_state WHERE singleton_id = 1`,
      [],
    );
    if (row === undefined) throw missingRuntimeState();
    const version = persisted("runtime_state.format_version", () => parseStoredInteger(row.format_version, 1));
    if (version !== FORMAT_VERSION) {
      throw new Error(`Unsupported realmlib.runtime_state.format_version ${version}; expected ${FORMAT_VERSION}`);
    }
    return persisted(`runtime_state.${column}`, () => parseStoredInteger(row.value));
  }

  return {
    async readClock() {
      // readRuntime() has already range-checked the value.
      return toSimTime(await readRuntime("now_ms"));
    },

    async writeClock(now) {
      const at = toSimTime(now);
      const rows = await query(db, "UPDATE realmlib.runtime_state SET now_ms = $1 WHERE singleton_id = 1 RETURNING 1", [
        String(at),
      ]);
      if (rows.length !== 1) throw missingRuntimeState();
    },

    async readNextSequence() {
      return readRuntime("next_sequence");
    },

    async insertPending(work, next) {
      if (typeof work !== "object" || work === null) {
        throw new TypeError("Stored work must be an object");
      }
      const { id: rawId, at: rawAt, sequence: rawSequence, request: rawRequest } = work;
      const id = toWorkItemId(rawId);
      const at = toSimTime(rawAt);
      const sequence = validateSequence(rawSequence, "Work sequence");
      const request = validateRequest(rawRequest);
      const nextSequence = validateSequence(next, "Next sequence");
      if (nextSequence <= sequence) {
        throw new RangeError(`Next sequence ${nextSequence} must be a safe integer above ${sequence}`);
      }
      // Validated before serializing, so JSON cannot normalize away -0 or other invalid data.
      const payload = JSON.stringify(request.payload);

      // One statement: the insert and the sequence update happen together or not at all.
      let rows: Record<string, unknown>[];
      try {
        rows = await query(
          db,
          `WITH state AS (
             SELECT next_sequence FROM realmlib.runtime_state WHERE singleton_id = 1
           ), occupant AS (
             SELECT status FROM realmlib.work_items WHERE work_id = $1
           ), advanced AS (
             UPDATE realmlib.runtime_state SET next_sequence = $8
             WHERE singleton_id = 1 AND next_sequence <= $3 AND NOT EXISTS (SELECT FROM occupant)
             RETURNING 1
           ), inserted AS (
             INSERT INTO realmlib.work_items
               (work_id, at_ms, sequence, module_id, operation, payload_version, payload, status)
             SELECT $1, $2, $3, $4, $5, $6, $7::json, 'pending' FROM advanced
             RETURNING 1
           )
           SELECT (SELECT next_sequence::text FROM state) AS next_sequence,
                  (SELECT status FROM occupant) AS occupant,
                  EXISTS (SELECT FROM inserted) AS inserted`,
          [
            id,
            String(at),
            String(sequence),
            request.moduleId,
            request.operation,
            String(request.payloadVersion),
            payload,
            String(nextSequence),
          ],
        );
      } catch (error) {
        // A concurrent insert of the same ID can pass the occupant check and then hit the key.
        if ((error as { constraint?: unknown }).constraint === "work_items_pkey") {
          throw new Error(`Work item ${JSON.stringify(id)} is already pending or completed`, { cause: error });
        }
        throw error;
      }

      const [row] = rows;
      if (row?.inserted === true) return;
      if (row === undefined) throw new Error("insertPending query returned no result row");
      if (row.occupant !== null) {
        const status = persisted("work_items.status", () => workIdStatus(row.occupant));
        throw new Error(`Work item ${JSON.stringify(id)} is already ${status}`);
      }
      if (row.next_sequence === null) throw missingRuntimeState();
      const stored = persisted("runtime_state.next_sequence", () => parseStoredInteger(row.next_sequence));
      throw new RangeError(`Work sequence ${sequence} is below the next sequence ${stored}`);
    },

    async readDue(until, limit) {
      const to = toSimTime(until);
      const max = validatePositiveCount(limit, "limit");
      // Ordered and limited in SQL, served by work_items_pending_order_idx.
      const rows = await query(
        db,
        // Qualified so ORDER BY uses the BIGINT columns, not the same-named text output columns.
        `SELECT w.work_id, w.at_ms::text AS at_ms, w.sequence::text AS sequence, w.module_id, w.operation,
                w.payload_version::text AS payload_version, w.payload::text AS payload
         FROM realmlib.work_items AS w
         WHERE w.status = 'pending' AND w.at_ms <= $1
         ORDER BY w.at_ms, w.sequence
         LIMIT $2`,
        [String(to), String(max)],
      );
      if (rows.length > max) {
        throw new Error(`readDue query returned ${rows.length} rows, more than its limit ${max}`);
      }
      return rows.map(storedWorkFromRow);
    },

    async countPending() {
      const [row] = await query(
        db,
        "SELECT count(*)::text AS pending FROM realmlib.work_items WHERE status = 'pending'",
        [],
      );
      return persisted("pending count", () => parseStoredInteger(row?.pending));
    },

    async readWorkIdStatus(id: WorkItemId) {
      const workId = toWorkItemId(id);
      const [row] = await query(db, "SELECT status FROM realmlib.work_items WHERE work_id = $1", [workId]);
      if (row === undefined) return undefined;
      return persisted("work_items.status", () => workIdStatus(row.status));
    },

    async markCompleted(id: WorkItemId) {
      const workId = toWorkItemId(id);
      // completed_at_ms is the stored simulation clock, not wall-clock time.
      const [row] = await query(
        db,
        `WITH clock AS (
           SELECT now_ms FROM realmlib.runtime_state WHERE singleton_id = 1
         ), completed AS (
           UPDATE realmlib.work_items SET status = 'completed', completed_at_ms = clock.now_ms
           FROM clock
           WHERE work_id = $1 AND status = 'pending'
           RETURNING 1
         )
         SELECT EXISTS (SELECT FROM clock) AS initialized, EXISTS (SELECT FROM completed) AS completed`,
        [workId],
      );
      if (row?.completed === true) return;
      if (row?.initialized !== true) throw missingRuntimeState();
      throw new Error(`Work item ${JSON.stringify(workId)} is not pending`);
    },
  };
}
