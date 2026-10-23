/**
 * Manually advanced scheduler of operation requests over a storage boundary.
 *
 * Nothing runs on its own: there are no timers and no wall-clock reads. Work
 * executes only inside `advanceTo()`, through the callback supplied to that call.
 * The scheduler owns ordering and advancement policy; the clock, ordering
 * sequence, queue, and work-ID history live in a {@link SchedulerStorage}.
 * There is no handler registry, dispatch, transaction layer, or cancellation here.
 */

import { moduleId as toModuleId, textStorageProblem, workItemId as toWorkItemId } from "./identifiers.ts";
import type { WorkItemId } from "./identifiers.ts";
import { copyState } from "./in-memory-state.ts";
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

/**
 * Storage for one scheduler's clock, ordering sequence, pending work, and
 * completed work IDs. It provides data access and mutation only: ordering and
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
   * Removes the pending item `id` and records its ID as completed, permanently.
   *
   * @throws if `id` is not pending.
   */
  markCompleted(id: WorkItemId): Promise<void>;
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
   * Queues a snapshot of `work`, taken when called. Its request envelope is
   * checked structurally only; the operation need not be registered. The
   * payload must be a {@link StateValue}. Invalid input changes nothing.
   * Calls take effect one at a time, in call order.
   *
   * @throws {TypeError | RangeError} if the ID, time, or request is invalid.
   * @throws {RangeError} if `work.at` is earlier than `now()`.
   * @throws {Error} if an item with the same ID is pending or has completed, or `advanceTo()` is running.
   */
  schedule(work: ScheduledWork): Promise<void>;

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

  function schedule(work: ScheduledWork): Promise<void> {
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
    return exclusive(async () => {
      const current = await storage.readClock();
      if (at < current) {
        throw new RangeError(`Cannot schedule work at ${at}, earlier than the current time ${current}`);
      }
      const status = await storage.readWorkIdStatus(id);
      if (status === "pending") {
        throw new Error(`Work item ${JSON.stringify(id)} is already pending`);
      }
      if (status === "completed") {
        throw new Error(`Work item ${JSON.stringify(id)} has already completed; work IDs cannot be reused`);
      }
      const sequence = await storage.readNextSequence();
      await storage.insertPending({ id, at, sequence, request }, sequence + 1);
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
          await storage.writeClock(current);
          const returned: unknown = execute(copyForCallback(next));
          if (isThenable(returned)) {
            throw new TypeError("execute must be synchronous, but it returned a Promise or thenable");
          }
          await storage.markCompleted(next.id);
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
