import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import {
  createPostgresSchedulerStorage,
  createScheduler,
  initializePostgresSchedulerStorage,
  moduleId,
  simTime,
  workItemId,
} from "../src/index.ts";
import type { PostgresQueryable, ScheduledWork, SchedulerStorage, SimTime, StoredWork } from "../src/index.ts";
import { parseStoredInteger } from "../src/postgres-scheduler-storage.ts";
import { describeSchedulerStorageContract } from "./scheduler-storage-contract.ts";

// Opt-in: runs only against a separate, disposable database named by this variable.
const databaseUrl = process.env.REALMLIB_TEST_DATABASE_URL;
const repoRoot = await realpath(join(import.meta.dir, ".."));
const MAX = Number.MAX_SAFE_INTEGER;

/** Bypasses static types to exercise runtime validation. */
function loose<T>(value: unknown): T {
  return value as T;
}

function request(payload: StoredWork["request"]["payload"] = { n: 1 }): StoredWork["request"] {
  return { moduleId: moduleId("module-a"), operation: "op-x", payloadVersion: 1, payload };
}

function stored(id: string, at: number, sequence: number, payload?: StoredWork["request"]["payload"]): StoredWork {
  return { id: workItemId(id), at: simTime(at), sequence, request: request(payload) };
}

function work(id: string, at: number): ScheduledWork {
  return { id: workItemId(id), at: simTime(at), request: request() };
}

/** A client that records every statement and never touches a database. */
function stubClient(rows: unknown[] = []): PostgresQueryable & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async query(text) {
      calls.push(text);
      return { rows };
    },
  };
}

describe("PostgreSQL scheduler storage without a database", () => {
  test("BIGINT text converts only within the field's safe-integer range", () => {
    expect(parseStoredInteger("0")).toBe(0);
    expect(parseStoredInteger(String(MAX))).toBe(MAX);
    expect(parseStoredInteger("1", 1)).toBe(1);
    for (const text of ["9007199254740992", "9007199254740993", "99999999999999999999", "-1", "-0", "1.5", "01", "1e3", " 1", "", "0x10"]) {
      expect(() => parseStoredInteger(text)).toThrow(RangeError);
    }
    expect(() => parseStoredInteger("0", 1)).toThrow(RangeError);
    for (const value of [5, null, undefined, 5n]) {
      expect(() => parseStoredInteger(value)).toThrow(TypeError);
    }
  });

  test("creating storage runs no queries, and src never imports pg", async () => {
    const client = stubClient();
    createPostgresSchedulerStorage(client);
    expect(client.calls).toEqual([]);
    for (const value of [undefined, null, {}, { query: 1 }]) {
      expect(() => createPostgresSchedulerStorage(loose<PostgresQueryable>(value))).toThrow(TypeError);
    }

    const sourceDir = join(repoRoot, "src");
    for (const name of await readdir(sourceDir)) {
      const source = await Bun.file(join(sourceDir, name)).text();
      expect({ name, importsPg: /\bfrom\s+["']pg["']|\b(?:require|import)\s*\(\s*["']pg["']/.test(source) }).toEqual({
        name,
        importsPg: false,
      });
    }
  });

  test("invalid input is rejected before any query, including -0 and JavaScript-only whitespace", async () => {
    const client = stubClient();
    const storage = createPostgresSchedulerStorage(client);
    const rejected: [Promise<unknown>, ErrorConstructor | RangeErrorConstructor | TypeErrorConstructor][] = [
      [storage.writeClock(loose<SimTime>(-0)), RangeError],
      [storage.readDue(simTime(0), -0), RangeError],
      [storage.insertPending(stored("w", 0, loose<number>(-0)), 1), RangeError],
      [storage.insertPending(stored("w", 0, 0), -0), RangeError],
      [storage.insertPending(stored("w", 0, 0), 0), RangeError],
      [storage.insertPending(stored("w", 0, 0, { nested: [1, -0] }), 1), TypeError],
      [storage.insertPending({ ...stored("w", 0, 0), request: { ...request(), payloadVersion: -0 } }, 1), RangeError],
      [storage.insertPending({ ...stored("w", 0, 0), id: loose(" ") }, 1), RangeError],
      [storage.insertPending({ ...stored("w", 0, 0), request: { ...request(), moduleId: loose("﻿") } }, 1), RangeError],
      [storage.insertPending({ ...stored("w", 0, 0), request: { ...request(), operation: " \t" } }, 1), RangeError],
      [storage.readWorkIdStatus(loose("\u3000")), RangeError],
      [storage.insertPending({ ...stored("w", 0, 0), id: loose("w\u0000") }, 1), RangeError],
      [storage.insertPending({ ...stored("w", 0, 0), id: loose("w\ud800") }, 1), RangeError],
      [storage.insertPending({ ...stored("w", 0, 0), request: { ...request(), moduleId: loose("m\u0000") } }, 1), RangeError],
      [storage.insertPending({ ...stored("w", 0, 0), request: { ...request(), operation: "op\udfff" } }, 1), RangeError],
      [storage.readWorkIdStatus(loose("w\u0000")), RangeError],
      [storage.markCompleted(loose("w\ud800")), RangeError],
      [storage.markCompleted(loose(" ")), RangeError],
      [initializePostgresSchedulerStorage(client, loose<SimTime>(-0)), RangeError],
    ];
    for (const [promise, error] of rejected) await expect(promise).rejects.toThrow(error);
    expect(client.calls).toEqual([]);
  });

  test("initialization refuses a non-UTF8 server or client encoding before writing", async () => {
    for (const [server, client] of [["SQL_ASCII", "UTF8"], ["LATIN1", "UTF8"], ["UTF8", "LATIN1"], [undefined, undefined]]) {
      const stub = stubClient(server === undefined ? [] : [{ server, client }]);
      await expect(initializePostgresSchedulerStorage(stub)).rejects.toThrow(/encoding is .*requires UTF8/);
      expect(stub.calls).toHaveLength(1);
    }
  });

  test("client errors and malformed results propagate instead of reporting success", async () => {
    const failure = new Error("connection lost");
    const failing = createPostgresSchedulerStorage({ query: () => Promise.reject(failure) });
    await expect(failing.readClock()).rejects.toBe(failure);
    await expect(failing.insertPending(stored("w", 0, 0), 1)).rejects.toBe(failure);
    await expect(failing.markCompleted(workItemId("w"))).rejects.toBe(failure);

    const malformed = createPostgresSchedulerStorage(loose<PostgresQueryable>({ query: async () => ({}) }));
    await expect(malformed.countPending()).rejects.toThrow(TypeError);

    // An empty result is never mistaken for a successful write.
    const empty = createPostgresSchedulerStorage(stubClient());
    await expect(empty.writeClock(simTime(1))).rejects.toThrow("has no row");
    await expect(empty.insertPending(stored("w", 0, 0), 1)).rejects.toThrow("no result row");
    await expect(empty.markCompleted(workItemId("w"))).rejects.toThrow("has no row");
  });
});

if (!databaseUrl) {
  test.skip("PostgreSQL scheduler storage NOT RUN: set REALMLIB_TEST_DATABASE_URL to a disposable database", () => {});
} else {
  definePostgresTests(databaseUrl);
}

function definePostgresTests(url: string): void {
  const client = new pg.Client({ connectionString: url });
  let migrated = false;

  beforeAll(async () => {
    await client.connect();
    const { rows } = await client.query("SELECT EXISTS (SELECT FROM pg_namespace WHERE nspname = 'realmlib') AS present");
    if (rows[0].present) {
      throw new Error("refusing to run: schema realmlib already exists; use a separate disposable database");
    }
    // Explicit setup: apply the repository's migration, unchanged, in one transaction.
    const migration = await Bun.file(join(repoRoot, "migrations", "001_initial_persistence.sql")).text();
    await client.query("BEGIN");
    try {
      await client.query(migration);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    migrated = true;
  });

  afterAll(async () => {
    // Only drop the schema this file created.
    if (migrated) await client.query("DROP SCHEMA realmlib CASCADE");
    await client.end();
  });

  async function reset(): Promise<void> {
    await client.query("TRUNCATE realmlib.work_items, realmlib.runtime_state");
  }

  async function fresh(initialTime = 0): Promise<SchedulerStorage> {
    await reset();
    await initializePostgresSchedulerStorage(client, simTime(initialTime));
    return createPostgresSchedulerStorage(client);
  }

  async function runtimeRow(): Promise<Record<string, unknown>> {
    const { rows } = await client.query(
      "SELECT now_ms::text, next_sequence::text, random_snapshot::text, format_version FROM realmlib.runtime_state",
    );
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  async function workRow(id: string): Promise<Record<string, unknown> | undefined> {
    const { rows } = await client.query(
      `SELECT work_id, at_ms::text, sequence::text, module_id, operation, payload_version::text, payload::text,
              status, completed_at_ms::text
       FROM realmlib.work_items WHERE work_id = $1`,
      [id],
    );
    return rows[0];
  }

  /** Inserts a work_items row directly, bypassing the adapter's validation. */
  async function insertRaw(row: Partial<Record<"work_id" | "at_ms" | "module_id" | "operation" | "payload", string>>) {
    await client.query(
      `INSERT INTO realmlib.work_items (work_id, at_ms, sequence, module_id, operation, payload_version, payload, status)
       VALUES ($1, $2, 0, $3, $4, 1, $5::json, 'pending')`,
      [row.work_id ?? "raw", row.at_ms ?? "0", row.module_id ?? "module-a", row.operation ?? "op-x", row.payload ?? "null"],
    );
    await client.query("UPDATE realmlib.runtime_state SET next_sequence = 1");
  }

  describeSchedulerStorageContract("PostgreSQL", (initialTime) => fresh(initialTime));

  describe("PostgreSQL scheduler storage", () => {
    test("initialization writes the starting row explicitly and never overwrites", async () => {
      await fresh(1_500);
      expect(await runtimeRow()).toEqual({ now_ms: "1500", next_sequence: "0", random_snapshot: null, format_version: 1 });
      await expect(initializePostgresSchedulerStorage(client, simTime(0))).rejects.toThrow();
      expect((await runtimeRow()).now_ms).toBe("1500");

      // Work without runtime state is inconsistent, not fresh: initialization refuses it.
      await insertRaw({});
      await client.query("DELETE FROM realmlib.runtime_state");
      await expect(initializePostgresSchedulerStorage(client)).rejects.toThrow("already has rows");
    });

    test("initialization checks this connection's client_encoding", async () => {
      await reset();
      await client.query("SET client_encoding = 'LATIN1'");
      try {
        await expect(initializePostgresSchedulerStorage(client)).rejects.toThrow('client_encoding is "LATIN1"');
      } finally {
        await client.query("RESET client_encoding");
      }
      expect((await client.query("SELECT count(*)::int AS n FROM realmlib.runtime_state")).rows[0].n).toBe(0);
      await initializePostgresSchedulerStorage(client);
    });

    test("a new adapter on another connection sees the same clock, sequence, work, and completions", async () => {
      const first = await fresh(100);
      const scheduler = createScheduler(first);
      await scheduler.schedule({ ...work("w1", 200), request: request({ list: [1, "x", null], ok: true }) });
      await scheduler.schedule(work("w2", 300));
      await scheduler.schedule(work("w3", 300));
      expect(await scheduler.advanceTo(simTime(250), 10, () => {})).toEqual({ now: simTime(250), executed: 1, reachedTarget: true });

      const pool = new pg.Pool({ connectionString: url, max: 2 });
      try {
        const second = createPostgresSchedulerStorage(pool);
        expect(await second.readClock()).toBe(simTime(250));
        expect(await second.readNextSequence()).toBe(3);
        expect(await second.countPending()).toBe(2);
        expect(await second.readDue(simTime(MAX), 10)).toEqual([stored("w2", 300, 1), stored("w3", 300, 2)]);
        expect(await second.readWorkIdStatus(workItemId("w1"))).toBe("completed");

        expect(await createScheduler(second).advanceTo(simTime(400), 10, () => {})).toEqual({
          now: simTime(400),
          executed: 2,
          reachedTarget: true,
        });
        expect(await first.countPending()).toBe(0);
      } finally {
        await pool.end();
      }

      // The receipt keeps the original request and its simulation-time completion.
      expect(await workRow("w1")).toEqual({
        work_id: "w1",
        at_ms: "200",
        sequence: "0",
        module_id: "module-a",
        operation: "op-x",
        payload_version: "1",
        payload: '{"list":[1,"x",null],"ok":true}',
        status: "completed",
        completed_at_ms: "200",
      });
    });

    test("completed_at_ms is the stored clock when completion is marked", async () => {
      const storage = await fresh();
      await storage.insertPending(stored("w1", 10, 0), 1);
      await storage.writeClock(simTime(75));
      await storage.markCompleted(workItemId("w1"));
      expect(await workRow("w1")).toMatchObject({ at_ms: "10", status: "completed", completed_at_ms: "75" });
    });

    test("due reads are ordered numerically by (at_ms, sequence) and limited in SQL", async () => {
      const storage = await fresh();
      const inserts: [string, number][] = [["t10-a", 10], ["t9", 9], ["max", MAX], ["t10-b", 10], ["t100", 100], ["t10-c", 10]];
      for (const [index, [id, at]] of inserts.entries()) await storage.insertPending(stored(id, at, index), index + 1);

      const seen: { text: string; values: unknown[] | undefined; returned: number }[] = [];
      const recording = createPostgresSchedulerStorage({
        async query(text, values) {
          const result = await client.query(text, values);
          seen.push({ text, values, returned: result.rows.length });
          return result;
        },
      });

      expect((await recording.readDue(simTime(MAX), 100)).map((w): string => w.id)).toEqual(["t9", "t10-a", "t10-b", "t10-c", "t100", "max"]);
      expect((await recording.readDue(simTime(10), 3)).map((w): string => w.id)).toEqual(["t9", "t10-a", "t10-b"]);
      expect((await recording.readDue(simTime(MAX), 2)).map((w): string => w.id)).toEqual(["t9", "t10-a"]);
      // The database itself returned only `limit` rows: nothing was sliced in JavaScript.
      expect(seen.map(({ values, returned }) => [values, returned])).toEqual([
        [[String(MAX), "100"], 6],
        [["10", "3"], 3],
        [[String(MAX), "2"], 2],
      ]);
      expect(seen[0]!.text).toMatch(/ORDER BY w\.at_ms, w\.sequence\s+LIMIT \$2/);
    });

    test("duplicate IDs are rejected pending and completed without consuming a sequence or touching the receipt", async () => {
      const storage = await fresh();
      await storage.insertPending(stored("pending", 10, 0), 1);
      await storage.insertPending(stored("done", 10, 1, { v: 1 }), 2);
      await storage.writeClock(simTime(10));
      await storage.markCompleted(workItemId("done"));
      const receipt = await workRow("done");

      await expect(storage.insertPending(stored("pending", 20, 2), 3)).rejects.toThrow("is already pending");
      await expect(storage.insertPending(stored("done", 20, 2, { v: 2 }), 3)).rejects.toThrow("is already completed");
      const scheduler = createScheduler(storage);
      await expect(scheduler.schedule(work("pending", 20))).rejects.toThrow("is already pending");
      await expect(scheduler.schedule(work("done", 20))).rejects.toThrow("has already completed");

      expect((await runtimeRow()).next_sequence).toBe("2");
      expect(await workRow("done")).toEqual(receipt!);
      expect(receipt).toMatchObject({ sequence: "1", payload: '{"v":1}', status: "completed", completed_at_ms: "10" });
    });

    test("failed statements and missing runtime state never report success or change the sequence", async () => {
      const storage = await fresh();
      await storage.insertPending(stored("w1", 10, 0), 1);

      // A row already holding sequence 5 makes the insert violate work_items_sequence_key:
      // the database error propagates and neither the row nor the sequence change is written.
      await client.query(
        `INSERT INTO realmlib.work_items (work_id, at_ms, sequence, module_id, operation, payload_version, payload, status)
         VALUES ('stray', 10, 5, 'module-a', 'op-x', 1, 'null', 'pending')`,
      );
      await expect(storage.insertPending(stored("w2", 10, 5), 6)).rejects.toMatchObject({
        constraint: "work_items_sequence_key",
      });
      expect((await runtimeRow()).next_sequence).toBe("1");
      expect(await workRow("w2")).toBeUndefined();
      await client.query("DELETE FROM realmlib.work_items WHERE work_id = 'stray'");

      await expect(storage.markCompleted(workItemId("unknown"))).rejects.toThrow("is not pending");

      await client.query("DELETE FROM realmlib.runtime_state");
      for (const call of [
        () => storage.readClock(),
        () => storage.writeClock(simTime(5)),
        () => storage.readNextSequence(),
        () => storage.insertPending(stored("w2", 10, 1), 2),
        () => storage.markCompleted(workItemId("w1")),
      ]) {
        await expect(call()).rejects.toThrow("has no row");
      }
      expect(await workRow("w1")).toMatchObject({ status: "pending" });
      expect(await workRow("w2")).toBeUndefined();
      // Nothing reinitialized the missing row.
      expect((await client.query("SELECT count(*)::int AS n FROM realmlib.runtime_state")).rows[0].n).toBe(0);
    });

    test("an unsupported format_version is rejected rather than read", async () => {
      const storage = await fresh();
      await client.query("UPDATE realmlib.runtime_state SET format_version = 2");
      await expect(storage.readClock()).rejects.toThrow("Unsupported");
      await expect(storage.readNextSequence()).rejects.toThrow("Unsupported");
    });

    test("BIGINT values at the safe-integer boundary round-trip", async () => {
      const storage = await fresh(MAX - 1);
      expect(await storage.readClock()).toBe(simTime(MAX - 1));
      await storage.insertPending(
        { ...stored("edge", MAX, MAX - 1), request: { ...request(), payloadVersion: MAX } },
        MAX,
      );
      expect(await storage.readNextSequence()).toBe(MAX);
      await storage.writeClock(simTime(MAX));
      expect(await storage.readClock()).toBe(simTime(MAX));
      expect(await storage.readDue(simTime(MAX), 1)).toEqual([
        { ...stored("edge", MAX, MAX - 1), request: { ...request(), payloadVersion: MAX } },
      ]);
      await storage.markCompleted(workItemId("edge"));
      expect(await workRow("edge")).toMatchObject({ completed_at_ms: String(MAX), payload_version: String(MAX) });
    });

    test("persisted BIGINT values beyond the safe-integer range or negative are rejected", async () => {
      const storage = await fresh();
      await storage.insertPending(stored("w1", 10, 0), 1);
      // Remove the schema's range backstops inside a transaction that is rolled back.
      await client.query("BEGIN");
      try {
        await client.query(`ALTER TABLE realmlib.runtime_state
          DROP CONSTRAINT runtime_state_now_ms_check, DROP CONSTRAINT runtime_state_next_sequence_check`);
        await client.query(`ALTER TABLE realmlib.work_items
          DROP CONSTRAINT work_items_at_ms_check, DROP CONSTRAINT work_items_sequence_check,
          DROP CONSTRAINT work_items_payload_version_check`);

        for (const value of ["9007199254740992", "9223372036854775807", "-1"]) {
          await client.query("UPDATE realmlib.runtime_state SET now_ms = $1, next_sequence = $1", [value]);
          await expect(storage.readClock()).rejects.toThrow(TypeError);
          await expect(storage.readNextSequence()).rejects.toThrow(TypeError);
        }
        await client.query("UPDATE realmlib.runtime_state SET now_ms = 0, next_sequence = 1");

        for (const [column, value] of [
          // An at_ms above the safe range is never due before a valid target, so test a negative one.
          ["at_ms", "-1"],
          ["sequence", "9007199254740993"],
          ["sequence", "-1"],
          ["payload_version", "0"],
          ["payload_version", "9007199254740992"],
        ] as const) {
          await client.query("SAVEPOINT s");
          await client.query(`UPDATE realmlib.work_items SET ${column} = $1`, [value]);
          await expect(storage.readDue(simTime(MAX), 10)).rejects.toThrow(`Invalid persisted ${column}`);
          await client.query("ROLLBACK TO SAVEPOINT s");
        }
        expect(await storage.readDue(simTime(MAX), 10)).toEqual([stored("w1", 10, 0)]);
      } finally {
        await client.query("ROLLBACK");
      }
    });

    test("persisted values that are not valid realmlib values are rejected on read", async () => {
      const malformed: [Parameters<typeof insertRaw>[0], string][] = [
        [{ payload: "-0" }, "payload"],
        [{ payload: '{"a":[1,-0]}' }, "payload"],
        [{ payload: "[1e400]" }, "payload"],
        [{ work_id: " " }, "work_id"],
        [{ module_id: "﻿" }, "module_id"],
        [{ operation: " 　" }, "operation"],
      ];
      for (const [row, field] of malformed) {
        const storage = await fresh();
        await insertRaw(row);
        await expect(storage.readDue(simTime(MAX), 10)).rejects.toThrow(new RegExp(`^Invalid persisted ${field}`));
      }

      // Legitimate stored JSON round-trips, including key order, escapes, and a "__proto__" key.
      const storage = await fresh();
      await insertRaw({ payload: '{"z":1,"a":[-1.5,"\\u0000",true,null],"__proto__":{"x":0}}' });
      const [due] = await storage.readDue(simTime(0), 1);
      expect(JSON.stringify(due!.request.payload)).toBe('{"z":1,"a":[-1.5,"\\u0000",true,null],"__proto__":{"x":0}}');
      expect(Object.getPrototypeOf(due!.request.payload)).toBe(Object.prototype);
    });
  });
}
