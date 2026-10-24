/**
 * Scheduled operations whose effects commit to PostgreSQL, one transaction per
 * successfully executed work item.
 *
 * The caller supplies and owns one dedicated connection. Loading reads the
 * committed module state and random snapshot into memory, because handlers read
 * state synchronously; those in-memory copies change only after a confirmed
 * `COMMIT`. If a `COMMIT`'s outcome is unknown, the runtime reads the work
 * item's durable receipt to settle it.
 *
 * Advancing requires ownership: a PostgreSQL session-level advisory lock held
 * on that same connection, so only one driver advances the database's
 * simulation at a time. Acquiring and releasing it are explicit; a lost or
 * uncertain connection loses ownership for good. Nothing here opens
 * connections, applies migrations, retries, waits for the lock, or reconnects.
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
 * clock change. The item is not executed again automatically. The runtime can
 * still be read, but it has lost ownership; a later `advanceTo()` by a new
 * owner runs the item.
 */
export class CommitNotConfirmedError extends Error {
  override readonly name = "CommitNotConfirmedError";
}

/**
 * The session-level advisory lock key held by the one driver of a database's
 * simulation: the ASCII bytes of `"realmlib"` read as a big-endian 64-bit
 * integer. PostgreSQL scopes advisory locks to the current database, and the
 * `realmlib` schema holds one simulation, so this key covers that simulation.
 * In `pg_locks` it appears as locktype `advisory`, classid 1919246700, objid
 * 1835821410, objsubid 1.
 */
export const POSTGRES_DRIVER_LOCK_KEY = 8_243_101_811_291_744_610n;

/** SQL that is true if this session holds {@link POSTGRES_DRIVER_LOCK_KEY}. */
const HOLDS_LOCK = `EXISTS (
  SELECT FROM pg_locks
  WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
    AND classid = ${POSTGRES_DRIVER_LOCK_KEY >> 32n} AND objid = ${POSTGRES_DRIVER_LOCK_KEY & 0xffff_ffffn} AND objsubid = 1
    AND pid = pg_backend_pid() AND granted
)`;

/**
 * Whether a runtime may advance its simulation: `"owned"` while it holds the
 * driver lock; `"unowned"` before acquiring, after releasing, and while either
 * is in progress; `"lost"` once its connection failed or ended, or ownership
 * otherwise became uncertain, after which it never owns again.
 */
export type DriverOwnership = "owned" | "unowned" | "lost";

/**
 * Advancing or a driver write was refused because the runtime does not own its
 * simulation. Nothing was run or changed by the refused call.
 */
export class NotOwnerError extends Error {
  override readonly name = "NotOwnerError";
  /** Why: never acquired or released (`"unowned"`), or lost (`"lost"`). */
  readonly ownership: Exclude<DriverOwnership, "owned">;

  constructor(message: string, ownership: Exclude<DriverOwnership, "owned">, options?: ErrorOptions) {
    super(message, options);
    this.ownership = ownership;
  }
}

export interface PostgresOperationRuntime {
  /**
   * Scheduler storage over the runtime's connection. It is the PostgreSQL
   * scheduler storage plus a `runWork()` that runs each item in a transaction.
   * `runWork()`, `writeClock()`, and `markCompleted()` reject with
   * {@link NotOwnerError} unless the runtime owns its simulation.
   */
  readonly storage: SchedulerStorage;

  /**
   * `createScheduler(storage)`, except that `advanceTo()` rejects with
   * {@link NotOwnerError}, before reading anything or calling `execute`,
   * unless the runtime owns its simulation. `schedule()` and reads need no
   * ownership.
   */
  readonly scheduler: Scheduler;

  /**
   * Tries once to make this runtime its simulation's driver by taking
   * {@link POSTGRES_DRIVER_LOCK_KEY} with `pg_try_advisory_lock` on its
   * connection. Resolves `true` once it holds the lock and has reloaded the
   * committed state and random stream, or `false`, changing nothing, if another
   * session holds it. It never waits or retries.
   *
   * @throws {NotOwnerError} if ownership was lost.
   * @throws {Error} if this runtime already owns, an acquire or release is in
   *   progress, the runtime is unusable, or this connection's session already
   *   holds the lock (for example through another runtime).
   * @throws a database error from the attempt, after which ownership is
   *   `"lost"`; or a failure to reload, after which the lock is released again.
   */
  tryAcquireOwnership(): Promise<boolean>;

  /**
   * Releases the driver lock with `pg_advisory_unlock`, refusing advancement
   * from the moment it is called. Resolves at once if the runtime does not own.
   *
   * @throws {Error} while `advanceTo()` or a driver write is running, or an
   *   acquire or release is in progress; ownership is kept.
   * @throws {NotOwnerError} if ownership was lost, or the session no longer
   *   held the lock: the connection must then be ended, not reused.
   * @throws a database error from the unlock, after which ownership is `"lost"`.
   */
  releaseOwnership(): Promise<void>;

  /** This runtime's current {@link DriverOwnership}. */
  ownership(): DriverOwnership;

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
 * Whether `error` is the server reporting that a statement failed on a session
 * that is still usable, which for `COMMIT` means the transaction rolled back.
 * A server error carries a SQLSTATE and a severity; errors without them (such
 * as a lost connection) are ambiguous.
 */
function serverReported(error: unknown): boolean {
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
 * receipt counts as committed, a matching pending item rejects with
 * {@link CommitNotConfirmedError}, and anything else with
 * {@link CommitOutcomeUnknownError}; in every case the runtime loses ownership.
 *
 * `client` must be one dedicated connection, such as a `pg` `Client` or a
 * `PoolClient` held for the runtime's lifetime, not in a transaction, and not
 * used by anything else meanwhile. The schema must be migrated and initialized.
 * Loading reads in one read-only transaction, writes nothing, and does not
 * acquire ownership; advancing needs `tryAcquireOwnership()` first. If `client`
 * has `on()` and `removeListener()`, as `pg` clients do, its `"end"` event is
 * watched while the runtime owns.
 *
 * @throws {TypeError} if `client` has no `query` method or is a `pg` `Pool`.
 * @throws {TypeError} if persisted state or the random snapshot is invalid.
 * @throws if runtime state is missing or the database reports an error.
 */
export async function loadPostgresOperationRuntime(client: PostgresQueryable): Promise<PostgresOperationRuntime> {
  const connection = validateClient(client);
  if (looksLikePool(connection)) {
    throw new TypeError("client must be one dedicated connection, such as a pg Client or PoolClient, not a Pool");
  }

  /** Internal steps of acquiring and releasing count as not owned. */
  let state: "unowned" | "acquiring" | "owned" | "releasing" | "lost" = "unowned";
  let lossReason: unknown;
  /** The backend that took the lock; every ownership check requires the same one. */
  let ownerPid: unknown;
  /** advanceTo() calls and driver writes running; release waits for none of them, it refuses. */
  let active = 0;

  /** Ownership becomes uncertain, permanently, if it was held or being changed. */
  function lose(reason: unknown): void {
    if (state === "unowned" || state === "lost") return;
    state = "lost";
    lossReason = reason;
    unwatch();
  }

  const onEnd = (): void => lose(new Error("The driver connection ended"));
  type Events = { on(event: "end", listener: () => void): unknown; removeListener(event: "end", listener: () => void): unknown };
  const events = connection as Partial<Record<keyof Events, unknown>>;
  const emitter =
    typeof events.on === "function" && typeof events.removeListener === "function" ? (connection as unknown as Events) : undefined;
  function watch(): void {
    emitter?.on("end", onEnd);
  }
  function unwatch(): void {
    emitter?.removeListener("end", onEnd);
  }

  // Every statement goes through here: a failure the server did not report leaves the session in doubt.
  const db: PostgresQueryable = {
    async query(text, values) {
      try {
        return await connection.query(text, values);
      } catch (error) {
        if (!serverReported(error)) lose(error);
        throw error;
      }
    },
  };

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

  /** The runtime can no longer be trusted, and neither can its session's ownership. */
  function breakRuntime(error: Error): Error {
    broken = error;
    lose(error);
    return error;
  }

  function assertOwned(): void {
    assertUsable();
    if (state === "owned") return;
    if (state === "lost") {
      throw new NotOwnerError(
        "This runtime has lost ownership of its simulation; end its connection and use a new one",
        "lost",
        { cause: lossReason },
      );
    }
    throw new NotOwnerError("This runtime does not own its simulation; call tryAcquireOwnership() first", "unowned");
  }

  /** Confirms on the connection that its session is the one that took the lock, and still holds it. */
  async function verifyOwnership(): Promise<void> {
    let row: Record<string, unknown> | undefined;
    try {
      [row] = await query(db, `SELECT pg_backend_pid() AS pid, ${HOLDS_LOCK} AS held`, []);
    } catch (error) {
      lose(error);
      throw error;
    }
    if (row?.pid !== ownerPid || row?.held !== true) {
      const error = new NotOwnerError(
        "This runtime's session no longer holds the driver lock; end its connection and use a new one",
        "lost",
      );
      lose(error);
      throw error;
    }
  }

  async function unlock(): Promise<void> {
    let row: Record<string, unknown> | undefined;
    try {
      [row] = await query(db, `SELECT pg_advisory_unlock(${POSTGRES_DRIVER_LOCK_KEY}) AS released`, []);
    } catch (error) {
      lose(error);
      throw error;
    }
    if (row?.released !== true) {
      const error = new NotOwnerError(
        "This runtime's session did not hold the driver lock it was releasing; end its connection",
        "lost",
      );
      lose(error);
      throw error;
    }
    state = "unowned";
    ownerPid = undefined;
  }

  async function tryAcquireOwnership(): Promise<boolean> {
    assertUsable();
    if (state === "lost") assertOwned();
    if (state === "owned") throw new Error("This runtime already owns its simulation");
    if (state !== "unowned") throw new Error("An ownership change is already in progress");
    state = "acquiring";
    let row: Record<string, unknown> | undefined;
    try {
      // Advisory locks are reentrant; a session that already holds this one is not locked again.
      [row] = await query(
        db,
        `SELECT pg_backend_pid() AS pid, ${HOLDS_LOCK} AS held,
                CASE WHEN ${HOLDS_LOCK} THEN NULL ELSE pg_try_advisory_lock(${POSTGRES_DRIVER_LOCK_KEY}) END AS acquired`,
        [],
      );
    } catch (error) {
      // The lock may have been taken even though the statement failed.
      lose(error);
      throw error;
    }
    if (row?.held === true) {
      state = "unowned";
      throw new Error(
        "This connection's session already holds the driver lock; use one runtime per connection and release it there",
      );
    }
    if (row?.acquired === false) {
      state = "unowned";
      return false;
    }
    if (row?.acquired !== true || typeof row.pid !== "number") {
      const error = new Error("pg_try_advisory_lock returned an unexpected result");
      lose(error);
      throw error;
    }
    ownerPid = row.pid;
    try {
      // A previous owner may have committed since this runtime loaded; continue from the database.
      ({ store, random } = await readOnly(db, () => readCommittedViews(db)));
    } catch (error) {
      // Gives the lock back unless the failure already left ownership in doubt.
      if (state === "acquiring") {
        state = "releasing";
        await unlock().catch(() => {});
      }
      throw error;
    }
    watch();
    state = "owned";
    return true;
  }

  async function releaseOwnership(): Promise<void> {
    if (state === "unowned") return;
    if (state === "lost") assertOwned();
    if (state !== "owned") throw new Error("An ownership change is already in progress");
    if (active > 0) throw new Error("Cannot release ownership while advanceTo() or a driver write is running");
    state = "releasing";
    unwatch();
    await unlock();
  }

  function ownership(): DriverOwnership {
    return state === "owned" || state === "lost" ? state : "unowned";
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
      breakRuntime(new Error("ROLLBACK failed; the connection's transaction state is unknown", { cause: error }));
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
    assertOwned();
    if (transacting) throw new Error("A work item's transaction is already open");
    transacting = true;
    active++;
    try {
      await transact(work, run);
    } finally {
      transacting = false;
      active--;
    }
  }

  /** Wraps a storage write so it runs only while owned, after confirming the lock on the connection. */
  function ownedWrite<A extends unknown[]>(method: (...args: A) => Promise<void>) {
    return async (...args: A): Promise<void> => {
      assertOwned();
      if (transacting) {
        throw new Error("Cannot change scheduler storage while a work item's transaction is open");
      }
      active++;
      try {
        await verifyOwnership();
        await method(...args);
      } finally {
        active--;
      }
    };
  }

  async function transact(work: StoredWork, run: () => void): Promise<void> {
    await query(db, "BEGIN", []);
    let staged: StagedOperation | undefined;
    let handlerFailed = false;
    try {
      // The item commits only from the session that holds the lock.
      await verifyOwnership();
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
      // A failure of any of these statements is a database error, and propagates instead.
      await rollback();
      // The established exception to atomicity: a failed item leaves the clock at its time.
      await verifyOwnership();
      await base.writeClock(work.at);
      throw error;
    }

    try {
      await query(db, "COMMIT", []);
    } catch (error) {
      // Staged values are never published after an uncertain COMMIT; the durable record decides.
      staged?.end();
      if (serverReported(error)) throw error;
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
   * the in-memory views are first replaced by what is committed. The `COMMIT`
   * failure has already cost the runtime its ownership, so settling the outcome
   * never lets it continue advancing.
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
      throw breakRuntime(new CommitOutcomeUnknownError(
        `${label} failed without showing whether it committed, and its durable record could not be read ` +
          `(${(error as Error)?.message ?? String(error)}); check the database before continuing with a new runtime`,
        { cause: commitError },
      ));
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
    throw breakRuntime(new CommitOutcomeUnknownError(
      `${label} failed without showing whether it committed, and the database holds ${found}; ` +
        "check the database before continuing with a new runtime",
      { cause: commitError },
    ));
  }

  const storage: SchedulerStorage = {
    readClock: guarded(false, base.readClock),
    writeClock: ownedWrite(base.writeClock),
    readNextSequence: guarded(false, base.readNextSequence),
    insertPending: guarded(true, base.insertPending),
    readDue: guarded(false, base.readDue),
    countPending: guarded(false, base.countPending),
    readWorkIdStatus: guarded(false, base.readWorkIdStatus),
    readWork: guarded(false, base.readWork),
    markCompleted: ownedWrite(base.markCompleted),
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

  const unguarded = createScheduler(storage);
  const scheduler: Scheduler = {
    now: unguarded.now,
    pendingCount: unguarded.pendingCount,
    schedule: unguarded.schedule,
    advanceTo(target, maxOperations, execute) {
      try {
        assertOwned();
      } catch (error) {
        return Promise.reject(error);
      }
      active++;
      return unguarded.advanceTo(target, maxOperations, execute).finally(() => {
        active--;
      });
    },
  };

  return {
    storage,
    scheduler,
    execute,
    read,
    randomSnapshot,
    tryAcquireOwnership,
    releaseOwnership,
    ownership,
  };
}
