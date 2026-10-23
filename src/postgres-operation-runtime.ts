/**
 * Scheduled operations whose effects commit to PostgreSQL, one transaction per
 * successfully executed work item.
 *
 * The caller supplies and owns one dedicated connection. Loading reads the
 * committed module state and random snapshot into memory, because handlers read
 * state synchronously; those in-memory copies change only after a confirmed
 * `COMMIT`. If a `COMMIT`'s outcome is unknown, the runtime reads the work
 * item's durable receipt before going on. Nothing here opens connections,
 * applies migrations, retries, or coordinates concurrent drivers.
 */

import { stageOperation } from "./execute-in-memory-operation.ts";
import type { OperationHandler, StagedOperation } from "./execute-in-memory-operation.ts";
import { moduleId as toModuleId } from "./identifiers.ts";
import type { ModuleId } from "./identifiers.ts";
import { createInMemoryStateStore } from "./in-memory-state.ts";
import type { InMemoryStateStore, StateValue } from "./in-memory-state.ts";
import type { ModuleRegistry, OperationValidationResult } from "./module-registry.ts";
import {
  createPostgresSchedulerStorage,
  missingRuntimeState,
  persisted,
  query,
  readPersistedWork,
  readRuntimeText,
  validateClient,
} from "./postgres-scheduler-storage.ts";
import type { PersistedWork, PostgresQueryable } from "./postgres-scheduler-storage.ts";
import { createScheduler, sameWork } from "./scheduler.ts";
import type { Scheduler, SchedulerStorage, StoredWork } from "./scheduler.ts";
import { createSeededRandom } from "./seeded-random.ts";
import type { RandomSnapshot, SeededRandom } from "./seeded-random.ts";

/**
 * `COMMIT` failed in a way that does not show whether the transaction committed,
 * for example because the connection was lost, and reading the work item's
 * durable record afterwards did not settle it: the read failed, or the record
 * was missing, unreadable, or not the work being executed. The runtime that
 * threw it is unusable afterwards; nothing is retried.
 */
export class CommitOutcomeUnknownError extends Error {
  override readonly name = "CommitOutcomeUnknownError";
}

/**
 * `COMMIT` failed without showing whether it committed, and the durable record
 * then showed that it did not: the work item is still pending with its original
 * request and has no receipt. Nothing of the attempt was kept, including its
 * clock change. The item is not executed again automatically; a later
 * `advanceTo()` runs it. The runtime stays usable.
 */
export class CommitNotConfirmedError extends Error {
  override readonly name = "CommitNotConfirmedError";
}

export interface PostgresOperationRuntime {
  /**
   * Scheduler storage over the runtime's connection. It is the PostgreSQL
   * scheduler storage plus a `runWork()` that runs each item in a transaction.
   */
  readonly storage: SchedulerStorage;

  /** `createScheduler(storage)`. */
  readonly scheduler: Scheduler;

  /**
   * Validates `input` and runs `handler` like `executeInMemoryOperation()`,
   * against the committed state and random stream, for the work item whose
   * `advanceTo()` callback is running. Its changes and draws become part of that
   * item's transaction and are published here only once it commits.
   *
   * @throws {Error} if no callback of this runtime's scheduler is running, or
   *   this work item has already executed an operation.
   * @throws whatever `executeInMemoryOperation()` would throw; nothing is kept.
   */
  execute(registry: ModuleRegistry, input: unknown, handler: OperationHandler): OperationValidationResult;

  /** A copy of the committed record at (`owner`, `key`), or `undefined` if none. */
  read(owner: ModuleId, key: string): StateValue | undefined;

  /** The committed random stream position, or `undefined` if none is configured. */
  randomSnapshot(): RandomSnapshot | undefined;
}

/** SQLSTATE classes after which a failed `COMMIT` may still have committed. */
const AMBIGUOUS_CLASSES = new Set(["08", "53", "57", "58", "XX"]);

/**
 * Whether `error` is the server reporting that `COMMIT` failed, which means the
 * transaction rolled back. A server error carries a SQLSTATE and a severity;
 * errors without them (such as a lost connection) are ambiguous.
 */
function commitDefinitelyFailed(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, severity } = error as { code?: unknown; severity?: unknown };
  return (
    typeof severity === "string" &&
    typeof code === "string" &&
    /^[0-9A-Z]{5}$/.test(code) &&
    !AMBIGUOUS_CLASSES.has(code.slice(0, 2))
  );
}

/**
 * Reads the committed module state and random stream. The caller must hold a
 * transaction so both come from one snapshot.
 */
async function readCommittedViews(
  db: PostgresQueryable,
): Promise<{ store: InMemoryStateStore; random: SeededRandom | undefined }> {
  const store = createInMemoryStateStore();
  let random: SeededRandom | undefined;
  const snapshot = await readRuntimeText(db, "random_snapshot");
  if (snapshot !== null) {
    random = persisted("runtime_state.random_snapshot", () => {
      if (typeof snapshot !== "string") throw new TypeError(`expected JSON text, received ${typeof snapshot}`);
      const parsed: unknown = JSON.parse(snapshot);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new TypeError("expected a JSON object");
      }
      return createSeededRandom(parsed as RandomSnapshot);
    });
  }
  const rows = await query(
    db,
    "SELECT module_id, record_key, value::text AS value FROM realmlib.state_records ORDER BY module_id, record_key",
    [],
  );
  for (const row of rows) {
    const where = `state record ${JSON.stringify(row.module_id)}/${JSON.stringify(row.record_key)}`;
    persisted(where, () => {
      if (typeof row.value !== "string") throw new TypeError(`expected JSON text, received ${typeof row.value}`);
      // set() validates the module ID, key, and value (rejecting -0) and copies it.
      const owner = toModuleId(row.module_id as string);
      store.forModule(owner).set(row.record_key as string, JSON.parse(row.value));
    });
  }
  return { store, random };
}

/** Runs `read` in one read-only snapshot transaction, rolling back if it fails. */
async function readOnly<T>(db: PostgresQueryable, read: () => Promise<T>): Promise<T> {
  await query(db, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", []);
  try {
    const result = await read();
    await query(db, "COMMIT", []);
    return result;
  } catch (error) {
    // The original error matters more than a failed cleanup.
    await query(db, "ROLLBACK", []).catch(() => {});
    throw error;
  }
}

/** A `pg` `Pool` sends each statement to any idle connection, so it cannot hold a transaction. */
function looksLikePool(client: object): boolean {
  return "totalCount" in client && "idleCount" in client;
}

/**
 * Loads the committed module state and random snapshot through `client` and
 * returns a runtime whose scheduler commits each successful work item in one
 * transaction: its clock, state-record changes, random stream position, and
 * completion receipt. A handler failure rolls that back, then sets the clock to
 * the item's time on its own, leaving the item pending. A `COMMIT` with an
 * unknown outcome is settled from the item's durable record: a matching
 * receipt continues, a matching pending item rejects with
 * {@link CommitNotConfirmedError}, and anything else with
 * {@link CommitOutcomeUnknownError}.
 *
 * `client` must be one dedicated connection, such as a `pg` `Client` or a
 * `PoolClient` held for the runtime's lifetime, not in a transaction, and not
 * used by anything else meanwhile. The schema must be migrated and initialized.
 * Loading reads in one read-only transaction and writes nothing.
 *
 * @throws {TypeError} if `client` has no `query` method or is a `pg` `Pool`.
 * @throws {TypeError} if persisted state or the random snapshot is invalid.
 * @throws if runtime state is missing or the database reports an error.
 */
export async function loadPostgresOperationRuntime(client: PostgresQueryable): Promise<PostgresOperationRuntime> {
  const db = validateClient(client);
  if (looksLikePool(db)) {
    throw new TypeError("client must be one dedicated connection, such as a pg Client or PoolClient, not a Pool");
  }

  // In-memory copies of committed values, replaced wholesale when reconciliation reloads them.
  let { store, random } = await readOnly(db, () => readCommittedViews(db));

  const base = createPostgresSchedulerStorage(db);
  /** Why the runtime can no longer be trusted, once it cannot. */
  let broken: Error | undefined;
  /** Set only while a work item's transaction is open. */
  let transacting = false;
  /** Set only while a work item's callback is running. */
  let current: { staged: StagedOperation | undefined } | undefined;

  function assertUsable(): void {
    if (broken !== undefined) {
      throw new Error("PostgreSQL operation runtime is unusable; load a new runtime", { cause: broken });
    }
  }

  /** Wraps a storage method so it rejects once broken, or (if `writes`) during a transaction. */
  function guarded<A extends unknown[], R>(writes: boolean, method: (...args: A) => Promise<R>) {
    return async (...args: A): Promise<R> => {
      assertUsable();
      if (writes && transacting) {
        throw new Error("Cannot change scheduler storage while a work item's transaction is open");
      }
      return method(...args);
    };
  }

  async function rollback(): Promise<void> {
    try {
      await query(db, "ROLLBACK", []);
    } catch (error) {
      broken = new Error("ROLLBACK failed; the connection's transaction state is unknown", { cause: error });
      throw error;
    }
  }

  async function writeEffects(staged: StagedOperation): Promise<void> {
    for (const [key, value] of staged.changes) {
      if (value === undefined) {
        await query(db, "DELETE FROM realmlib.state_records WHERE module_id = $1 AND record_key = $2", [
          staged.owner,
          key,
        ]);
      } else {
        // Staged values are validated copies, so serializing cannot drop -0 or other invalid data.
        await query(
          db,
          `INSERT INTO realmlib.state_records (module_id, record_key, value) VALUES ($1, $2, $3::json)
           ON CONFLICT (module_id, record_key) DO UPDATE SET value = EXCLUDED.value`,
          [staged.owner, key, JSON.stringify(value)],
        );
      }
    }
    if (staged.random !== undefined) {
      const rows = await query(
        db,
        "UPDATE realmlib.runtime_state SET random_snapshot = $1::json WHERE singleton_id = 1 RETURNING 1",
        [JSON.stringify(staged.random)],
      );
      if (rows.length !== 1) throw missingRuntimeState();
    }
  }

  async function runWork(work: StoredWork, run: () => void): Promise<void> {
    assertUsable();
    if (transacting) throw new Error("A work item's transaction is already open");
    transacting = true;
    try {
      await transact(work, run);
    } finally {
      transacting = false;
    }
  }

  async function transact(work: StoredWork, run: () => void): Promise<void> {
    await query(db, "BEGIN", []);
    let staged: StagedOperation | undefined;
    let handlerFailed = false;
    try {
      // Inside the transaction, so it commits with the effects and completed_at_ms reads it.
      await base.writeClock(work.at);
      current = { staged: undefined };
      try {
        run();
      } catch (error) {
        handlerFailed = true;
        throw error;
      } finally {
        staged = current.staged;
        current = undefined;
      }
      if (staged !== undefined) await writeEffects(staged);
      await base.markCompleted(work.id);
    } catch (error) {
      staged?.end();
      if (!handlerFailed) {
        // A database failure: the original error propagates even if cleanup fails too.
        await rollback().catch(() => {});
        throw error;
      }
      // A failure of either statement is a database error, and propagates instead.
      await rollback();
      // The established exception to atomicity: a failed item leaves the clock at its time.
      await base.writeClock(work.at);
      throw error;
    }

    try {
      await query(db, "COMMIT", []);
    } catch (error) {
      // Staged values are never published after an uncertain COMMIT; the durable record decides.
      staged?.end();
      if (commitDefinitelyFailed(error)) throw error;
      await reconcile(work, error);
      return;
    }
    staged?.publish();
    staged?.end();
  }

  /**
   * Settles a `COMMIT` whose outcome is unknown from the durable record of
   * `work`, read on this connection after its transaction has ended. Returns
   * if the matching receipt shows it committed; otherwise throws. Either way
   * the in-memory views are first replaced by what is committed.
   */
  async function reconcile(work: StoredWork, commitError: unknown): Promise<void> {
    const label = `COMMIT of work item ${JSON.stringify(work.id)}`;
    let durable: Awaited<ReturnType<typeof readCommittedViews>> & { record: PersistedWork | undefined };
    try {
      // Not a retry: ROLLBACK never commits. If COMMIT never arrived, it ends the item's
      // transaction. If it fails, the connection's transaction state is unknown, and a
      // read could see the item's own uncommitted writes, so nothing is read.
      await query(db, "ROLLBACK", []);
      durable = await readOnly(db, async () => {
        // Backstop: a transaction that has written anything has an ID, so this is not the item's.
        const [own] = await query(db, "SELECT pg_current_xact_id_if_assigned()::text AS xid", []);
        if (own === undefined || own.xid !== null) {
          throw new Error("the read is not in a fresh read-only transaction");
        }
        const record = await readPersistedWork(db, work.id);
        return { record, ...(await readCommittedViews(db)) };
      });
    } catch (error) {
      broken = new CommitOutcomeUnknownError(
        `${label} failed without showing whether it committed, and its durable record could not be read ` +
          `(${(error as Error)?.message ?? String(error)}); check the database before continuing with a new runtime`,
        { cause: commitError },
      );
      throw broken;
    }

    const { record } = durable;
    const same = record !== undefined && record.work.sequence === work.sequence && sameWork(record.work, work);
    if (same && record.status === "completed" && record.completedAt === work.at) {
      ({ store, random } = durable);
      return;
    }
    if (same && record.status === "pending") {
      ({ store, random } = durable);
      throw new CommitNotConfirmedError(
        `${label} failed, and the item is still pending without a receipt, so it did not commit; ` +
          "it was not executed again",
        { cause: commitError },
      );
    }
    const found =
      record === undefined
        ? "no work item with that ID"
        : same
          ? `a receipt completed at ${record.completedAt}, not ${work.at}`
          : `${record.status} work with a different request or sequence`;
    broken = new CommitOutcomeUnknownError(
      `${label} failed without showing whether it committed, and the database holds ${found}; ` +
        "check the database before continuing with a new runtime",
      { cause: commitError },
    );
    throw broken;
  }

  const storage: SchedulerStorage = {
    readClock: guarded(false, base.readClock),
    writeClock: guarded(true, base.writeClock),
    readNextSequence: guarded(false, base.readNextSequence),
    insertPending: guarded(true, base.insertPending),
    readDue: guarded(false, base.readDue),
    countPending: guarded(false, base.countPending),
    readWorkIdStatus: guarded(false, base.readWorkIdStatus),
    readWork: guarded(false, base.readWork),
    markCompleted: guarded(true, base.markCompleted),
    runWork,
  };

  function execute(registry: ModuleRegistry, input: unknown, handler: OperationHandler): OperationValidationResult {
    assertUsable();
    if (current === undefined) {
      throw new Error("execute() can only run inside an advanceTo() callback of this runtime's scheduler");
    }
    if (current.staged !== undefined) {
      throw new Error("This work item has already executed an operation; only one operation per work item is supported");
    }
    const staged = stageOperation(registry, store, input, handler, random);
    if (!staged.ok) return staged;
    current.staged = staged;
    return staged.result;
  }

  function read(owner: ModuleId, key: string): StateValue | undefined {
    assertUsable();
    return store.forModule(owner).get(owner, key);
  }

  function randomSnapshot(): RandomSnapshot | undefined {
    assertUsable();
    return random?.snapshot();
  }

  return { storage, scheduler: createScheduler(storage), execute, read, randomSnapshot };
}
