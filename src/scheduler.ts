/**
 * Manually advanced scheduler of operation requests over a storage boundary.
 *
 * Nothing runs on its own: there are no timers and no wall-clock reads. Work
 * executes only inside `advanceTo()`, through the callback supplied to that call.
 * The scheduler owns ordering and advancement policy; the clock, ordering
 * sequence, queue, and work-ID history live in a {@link SchedulerStorage}.
 * There is no handler registry, dispatch, or cancellation here; storage may run
 * each item as a transaction (see {@link SchedulerStorage.runWork}).
 */

import { moduleId as toModuleId, textStorageProblem, workItemId as toWorkItemId } from "./identifiers.ts";
import type { WorkItemId } from "./identifiers.ts";
import { copyState, sameState } from "./in-memory-state.ts";
import type { StateValue } from "./in-memory-state.ts";
import type { OperationRequest } from "./module-registry.ts";
import { simTime as toSimTime } from "./sim-time.ts";
import type { SimTime } from "./sim-time.ts";

/** An operation request to run at a simulation time. */
export interface ScheduledWork {
  readonly id: WorkItemId;
  readonly at: SimTime;
  readonly request: OperationRequest;
}

/** A validated work item as held by {@link SchedulerStorage}. */
export interface StoredWork {
  readonly id: WorkItemId;
  readonly at: SimTime;
  /** Insertion order, used to break ties between equal times. Never reused. */
  readonly sequence: number;
  readonly request: OperationRequest & { readonly payload: StateValue };
}

/** Whether a work ID is occupied by pending work, by a completion receipt, or not at all. */
export type WorkIdStatus = "pending" | "completed" | undefined;

/** The work stored under an occupied ID: pending work, or the original work of a completion receipt. */
export interface WorkRecord {
  readonly status: Exclude<WorkIdStatus, undefined>;
  readonly work: StoredWork;
}

/**
 * How `schedule()` treated a request: `"accepted"` queued it as new work;
 * `"already-pending"` and `"already-completed"` found an identical request
 * already stored under its ID and changed nothing.
 */
export type ScheduleOutcome = "accepted" | "already-pending" | "already-completed";

/**
 * `schedule()` was given a work ID that is already pending or completed with a
 * different request. Nothing was changed. Work IDs are never reused.
 */
export class WorkIdConflictError extends Error {
  override readonly name = "WorkIdConflictError";
  /** Whether the stored work with this ID is pending or completed. */
  readonly status: Exclude<WorkIdStatus, undefined>;

  constructor(message: string, status: Exclude<WorkIdStatus, undefined>) {
    super(message);
    this.status = status;
  }
}

/** @internal The {@link WorkIdConflictError} for different work submitted under the occupied ID `id`. */
export function workIdConflict(id: WorkItemId, status: Exclude<WorkIdStatus, undefined>): WorkIdConflictError {
  return new WorkIdConflictError(
    status === "pending"
      ? `Work item ${JSON.stringify(id)} is already pending with a different request`
      : `Work item ${JSON.stringify(id)} has already completed with a different request; work IDs cannot be reused`,
    status,
  );
}

/**
 * Storage for one scheduler's clock, ordering sequence, pending work, and
 * completion receipts (each keeping its original work). It provides data access and mutation only: ordering and
 * advancement policy belong to {@link createScheduler}.
 *
 * Every method returns a Promise so implementations may perform asynchronous
 * I/O. Inputs are validated by the scheduler before they reach storage, and
 * storage must return validated values. Returned objects belong to the caller.
 */
export interface SchedulerStorage {
  /** The current simulation time. */
  readClock(): Promise<SimTime>;

  /** Sets the current simulation time. */
  writeClock(now: SimTime): Promise<void>;

  /** The sequence number to assign to the next inserted work item. */
  readNextSequence(): Promise<number>;

  /**
   * Adds `work` as pending and sets the next sequence to `nextSequence`, together.
   *
   * @throws if `work.id` is already pending or completed, or the sequences do
   *   not increase (`work.sequence` below the stored next sequence, or
   *   `nextSequence` not above `work.sequence`).
   */
  insertPending(work: StoredWork, nextSequence: number): Promise<void>;

  /**
   * Up to `limit` pending items due at or before `until`, in order of time and
   * then sequence. Does not change anything.
   */
  readDue(until: SimTime, limit: number): Promise<readonly StoredWork[]>;

  /** Number of pending items. */
  countPending(): Promise<number>;

  /** Whether `id` belongs to pending work, to completed work, or to neither. */
  readWorkIdStatus(id: WorkItemId): Promise<WorkIdStatus>;

  /**
   * The pending work stored under `id`, or the original work of its completion
   * receipt, exactly as inserted; `undefined` if `id` is unused.
   */
  readWork(id: WorkItemId): Promise<WorkRecord | undefined>;

  /**
   * Removes the pending item `id` and records its ID as completed, permanently.
   *
   * @throws if `id` is not pending.
   */
  markCompleted(id: WorkItemId): Promise<void>;

  /**
   * Optional. Runs one due item as a unit, for storage that commits an item's
   * effects together with its bookkeeping. It must set the clock to `work.at`,
   * call `run()` once, and, if `run()` returns, mark `work` completed together
   * with anything it collected during `run()`. If `run()` throws, it must keep
   * `work` pending, leave the clock at `work.at`, discard what it collected,
   * and reject with that error. Without it, the scheduler calls `writeClock()`
   * before `run()` and `markCompleted()` after it.
   */
  runWork?(work: StoredWork, run: () => void): Promise<void>;
}

export interface AdvanceResult {
  /** The scheduler's clock after the call. */
  readonly now: SimTime;
  /** Number of callbacks that returned successfully during the call. */
  readonly executed: number;
  /** `true` if no work remains due at or before the target and the clock is at the target. */
  readonly reachedTarget: boolean;
}

export interface Scheduler {
  /** The current simulation time, read from storage. Changes only during `advanceTo()`. */
  now(): Promise<SimTime>;

  /** Number of scheduled items that have not yet executed successfully. */
  pendingCount(): Promise<number>;

  /**
   * Queues a snapshot of `work`, taken when called, and resolves to
   * `"accepted"`. Its request envelope is checked structurally only; the
   * operation need not be registered. The payload must be a {@link StateValue}.
   * Invalid input changes nothing. Calls take effect one at a time, in call order.
   *
   * Resubmitting the work stored under an ID (same time, module, operation,
   * payload version, and structurally equal payload) is harmless: it changes
   * nothing and resolves to `"already-pending"` or `"already-completed"`.
   *
   * @throws {TypeError | RangeError} if the ID, time, or request is invalid.
   * @throws {WorkIdConflictError} if different work with the same ID is pending or has completed.
   * @throws {RangeError} if the ID is new and `work.at` is earlier than `now()`.
   * @throws {Error} if `advanceTo()` is running.
   */
  schedule(work: ScheduledWork): Promise<ScheduleOutcome>;

  /**
   * Runs pending items due at or before `target`, in order of time and then
   * insertion, calling `execute` with a copy of each at most `maxOperations`
   * times. The clock is set to each item's time before its callback runs. An
   * item is removed only when its callback returns without throwing.
   *
   * @throws {TypeError} if `execute` is not a function, or it returns a Promise
   *   or thenable (the item stays pending).
   * @throws {TypeError | RangeError} if `target` or `maxOperations` is invalid.
   * @throws {RangeError} if `target` is earlier than `now()`.
   * @throws {Error} if called while `advanceTo()` is already running.
   * @throws whatever `execute` throws; the item stays pending and the clock stays at its time.
   */
  advanceTo(target: SimTime, maxOperations: number, execute: (work: ScheduledWork) => void): Promise<AdvanceResult>;
}

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

function isThenable(value: unknown): boolean {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * @internal Validates an operation name: a nonempty, non-whitespace-only string
 * without U+0000 or unpaired surrogates. `name` labels it in error messages.
 */
export function validateOperationName(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string, received ${typeof value}`);
  }
  if (value.trim() === "") {
    throw new RangeError(`${name} must not be empty or whitespace-only`);
  }
  const problem = textStorageProblem(value);
  if (problem !== undefined) throw new RangeError(`${name} ${problem}`);
  return value;
}

/** @internal Validates and copies a request envelope whose payload must be a {@link StateValue}. */
export function validateRequest(input: unknown): StoredWork["request"] {
  if (!isObject(input) || Array.isArray(input)) {
    throw new TypeError("Scheduled request must be an object");
  }
  for (const field of ["moduleId", "operation", "payloadVersion", "payload"]) {
    if (!Object.hasOwn(input, field)) {
      throw new TypeError(`Scheduled request is missing its own ${JSON.stringify(field)} field`);
    }
  }
  // Read each field once so accessors cannot yield different values between checks.
  const { moduleId, operation, payloadVersion, payload } = input;
  const id = toModuleId(moduleId as string);
  validateOperationName(operation, "Scheduled request operation");
  if (typeof payloadVersion !== "number") {
    throw new TypeError(`Scheduled request payloadVersion must be a number, received ${typeof payloadVersion}`);
  }
  if (!Number.isSafeInteger(payloadVersion) || payloadVersion < 1) {
    throw new RangeError(
      `Scheduled request payloadVersion must be a positive safe integer, received ${Object.is(payloadVersion, -0) ? "-0" : payloadVersion}`,
    );
  }
  return { moduleId: id, operation: operation as string, payloadVersion, payload: copyState(payload, "payload") };
}

/** @internal Validates a work sequence number: a nonnegative safe integer other than -0. */
export function validateSequence(value: unknown, name: string): number {
  if (typeof value !== "number") {
    throw new TypeError(`${name} must be a number, received ${typeof value}`);
  }
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new RangeError(`${name} must be a nonnegative safe integer, received ${Object.is(value, -0) ? "-0" : value}`);
  }
  return value;
}

/** @internal Validates a positive safe integer such as `maxOperations`. */
export function validatePositiveCount(value: unknown, name: string): number {
  if (typeof value !== "number") {
    throw new TypeError(`${name} must be a number, received ${typeof value}`);
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer, received ${Object.is(value, -0) ? "-0" : value}`);
  }
  return value;
}

/**
 * @internal Whether two validated work items are the same request: equal ID,
 * time, module, operation, payload version, and structurally equal payload.
 * The sequence is assigned by storage, not requested, so it is not compared.
 */
export function sameWork(x: Omit<StoredWork, "sequence">, y: Omit<StoredWork, "sequence">): boolean {
  return (
    x.id === y.id &&
    x.at === y.at &&
    x.request.moduleId === y.request.moduleId &&
    x.request.operation === y.request.operation &&
    x.request.payloadVersion === y.request.payloadVersion &&
    sameState(x.request.payload, y.request.payload)
  );
}

/**
 * @internal Assigns sequences to work an operation emitted, in emission order,
 * starting at the stored next sequence, without inserting anything. An item
 * identical to work already stored under its ID (pending or completed) is
 * left out and consumes no sequence. Emitted IDs must be distinct.
 *
 * Resolves to `{ rejected }` instead if the emitted work cannot be stored: a
 * {@link WorkIdConflictError} if different work is stored under an emitted ID,
 * or a `RangeError` if the sequences would pass `Number.MAX_SAFE_INTEGER`.
 * Storage errors reject.
 */
export async function admitEmittedWork(
  storage: Pick<SchedulerStorage, "readWork" | "readNextSequence">,
  emitted: readonly Omit<StoredWork, "sequence">[],
): Promise<{ readonly admitted: StoredWork[] } | { readonly rejected: Error }> {
  const fresh: Omit<StoredWork, "sequence">[] = [];
  for (const work of emitted) {
    const existing = await storage.readWork(work.id);
    if (existing === undefined) fresh.push(work);
    else if (!sameWork(existing.work, work)) return { rejected: workIdConflict(work.id, existing.status) };
  }
  if (fresh.length === 0) return { admitted: [] };
  const first = await storage.readNextSequence();
  // Each item also needs a next sequence above its own.
  if (first > Number.MAX_SAFE_INTEGER - fresh.length) {
    return {
      rejected: new RangeError(`Cannot emit ${fresh.length} work item(s): work sequences are exhausted at ${first}`),
    };
  }
  return { admitted: fresh.map((work, index) => ({ ...work, sequence: first + index })) };
}

/** A fresh copy of stored work for a callback, so the callback cannot alter the queue. */
function copyForCallback(work: StoredWork): ScheduledWork {
  const { moduleId, operation, payloadVersion, payload } = work.request;
  return { id: work.id, at: work.at, request: { moduleId, operation, payloadVersion, payload: copyState(payload) } };
}

/**
 * Creates a scheduler over `storage`, continuing from the clock, sequence,
 * pending work, and completed IDs already stored there. Only one scheduler
 * should use a storage instance at a time.
 */
export function createScheduler(storage: SchedulerStorage): Scheduler {
  let advancing = false;
  // schedule() and advanceTo() run one at a time, in call order.
  let tail: Promise<unknown> = Promise.resolve();

  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task);
    tail = run.catch(() => {});
    return run;
  }

  function now(): Promise<SimTime> {
    return storage.readClock();
  }

  function pendingCount(): Promise<number> {
    return storage.countPending();
  }

  function schedule(work: ScheduledWork): Promise<ScheduleOutcome> {
    let id: WorkItemId;
    let at: SimTime;
    let request: StoredWork["request"];
    try {
      if (advancing) {
        throw new Error("Cannot schedule work while advanceTo() is dispatching");
      }
      if (!isObject(work)) {
        throw new TypeError("Scheduled work must be an object");
      }
      const { id: rawId, at: rawAt, request: rawRequest } = work;
      id = toWorkItemId(rawId);
      at = toSimTime(rawAt);
      request = validateRequest(rawRequest);
    } catch (error) {
      return Promise.reject(error);
    }
    return exclusive(async (): Promise<ScheduleOutcome> => {
      // Before the time check: an identical retry of completed work is usually in the past.
      const existing = await storage.readWork(id);
      if (existing !== undefined) {
        if (sameWork(existing.work, { id, at, request })) {
          return existing.status === "pending" ? "already-pending" : "already-completed";
        }
        throw workIdConflict(id, existing.status);
      }
      const current = await storage.readClock();
      if (at < current) {
        throw new RangeError(`Cannot schedule work at ${at}, earlier than the current time ${current}`);
      }
      const sequence = await storage.readNextSequence();
      // insertPending() still rejects an occupied ID itself; the read above only classifies retries.
      await storage.insertPending({ id, at, sequence, request }, sequence + 1);
      return "accepted";
    });
  }

  function advanceTo(
    target: SimTime,
    maxOperations: number,
    execute: (work: ScheduledWork) => void,
  ): Promise<AdvanceResult> {
    if (advancing) {
      return Promise.reject(new Error("advanceTo() is already dispatching; nested advancement is not supported"));
    }
    advancing = true;
    return exclusive(async () => {
      try {
        if (typeof execute !== "function") {
          throw new TypeError(`execute must be a function, received ${typeof execute}`);
        }
        const to = toSimTime(target);
        let current = await storage.readClock();
        if (to < current) {
          throw new RangeError(`Cannot advance to ${to}, earlier than the current time ${current}`);
        }
        const limit = validatePositiveCount(maxOperations, "maxOperations");

        let executed = 0;
        for (;;) {
          const [next] = await storage.readDue(to, 1);
          if (next === undefined) break;
          if (executed === limit) return { now: current, executed, reachedTarget: false };
          current = next.at;
          const run = (): void => {
            const returned: unknown = execute(copyForCallback(next));
            if (isThenable(returned)) {
              throw new TypeError("execute must be synchronous, but it returned a Promise or thenable");
            }
          };
          if (storage.runWork !== undefined) {
            await storage.runWork(next, run);
          } else {
            await storage.writeClock(current);
            run();
            await storage.markCompleted(next.id);
          }
          executed++;
        }
        current = to;
        await storage.writeClock(current);
        return { now: current, executed, reachedTarget: true };
      } finally {
        advancing = false;
      }
    });
  }

  return { now, pendingCount, schedule, advanceTo };
}
