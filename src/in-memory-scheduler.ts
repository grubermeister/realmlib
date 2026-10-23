/**
 * Manually advanced, in-memory scheduler of operation requests.
 *
 * Nothing runs on its own: there are no timers and no wall-clock reads. Work
 * executes only inside `advanceTo()`, through the callback supplied to that call.
 * There is no handler registry, dispatch, persistence, or cancellation here.
 */

import { moduleId as toModuleId, workItemId as toWorkItemId } from "./identifiers.ts";
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

export interface AdvanceResult {
  /** The scheduler's clock after the call. */
  readonly now: SimTime;
  /** Number of callbacks that returned successfully during the call. */
  readonly executed: number;
  /** `true` if no work remains due at or before the target and the clock is at the target. */
  readonly reachedTarget: boolean;
}

export interface InMemoryScheduler {
  /** The current simulation time. Changes only during `advanceTo()`. */
  now(): SimTime;

  /** Number of scheduled items that have not yet executed successfully. */
  pendingCount(): number;

  /**
   * Queues a snapshot of `work`. Its request envelope is checked structurally
   * only; the operation need not be registered. The payload must be a
   * {@link StateValue}. Invalid input changes nothing.
   *
   * @throws {TypeError | RangeError} if the ID, time, or request is invalid.
   * @throws {RangeError} if `work.at` is earlier than `now()`.
   * @throws {Error} if an item with the same ID is pending or has completed, or `advanceTo()` is running.
   */
  schedule(work: ScheduledWork): void;

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
  advanceTo(target: SimTime, maxOperations: number, execute: (work: ScheduledWork) => void): AdvanceResult;
}

/** A validated, privately owned snapshot of scheduled work. */
interface QueuedWork {
  readonly id: WorkItemId;
  readonly at: SimTime;
  /** Insertion order, used to break ties between equal times. */
  readonly sequence: number;
  readonly request: OperationRequest & { readonly payload: StateValue };
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

function validateRequest(input: unknown): QueuedWork["request"] {
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
  if (typeof operation !== "string") {
    throw new TypeError(`Scheduled request operation must be a string, received ${typeof operation}`);
  }
  if (operation.trim() === "") {
    throw new RangeError("Scheduled request operation must not be empty or whitespace-only");
  }
  if (typeof payloadVersion !== "number") {
    throw new TypeError(`Scheduled request payloadVersion must be a number, received ${typeof payloadVersion}`);
  }
  if (!Number.isSafeInteger(payloadVersion) || payloadVersion < 1) {
    throw new RangeError(
      `Scheduled request payloadVersion must be a positive safe integer, received ${Object.is(payloadVersion, -0) ? "-0" : payloadVersion}`,
    );
  }
  return { moduleId: id, operation, payloadVersion, payload: copyState(payload, "payload") };
}

function validateMaxOperations(value: unknown): number {
  if (typeof value !== "number") {
    throw new TypeError(`maxOperations must be a number, received ${typeof value}`);
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`maxOperations must be a positive safe integer, received ${Object.is(value, -0) ? "-0" : value}`);
  }
  return value;
}

/** A fresh copy of queued work for a callback, so the callback cannot alter the queue. */
function copyForCallback(work: QueuedWork): ScheduledWork {
  const { moduleId, operation, payloadVersion, payload } = work.request;
  return { id: work.id, at: work.at, request: { moduleId, operation, payloadVersion, payload: copyState(payload) } };
}

function precedes(x: QueuedWork, y: QueuedWork): boolean {
  return x.at < y.at || (x.at === y.at && x.sequence < y.sequence);
}

/** Binary min-heap ordered by (at, sequence). */
class WorkQueue {
  readonly #items: QueuedWork[] = [];

  get size(): number {
    return this.#items.length;
  }

  peek(): QueuedWork | undefined {
    return this.#items[0];
  }

  push(work: QueuedWork): void {
    const items = this.#items;
    let index = items.push(work) - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!precedes(work, items[parent]!)) break;
      items[index] = items[parent]!;
      index = parent;
    }
    items[index] = work;
  }

  pop(): QueuedWork | undefined {
    const items = this.#items;
    const top = items[0];
    const last = items.pop();
    if (top === undefined || last === undefined || items.length === 0) return top;
    let index = 0;
    for (;;) {
      const left = 2 * index + 1;
      if (left >= items.length) break;
      const right = left + 1;
      const child = right < items.length && precedes(items[right]!, items[left]!) ? right : left;
      if (!precedes(items[child]!, last)) break;
      items[index] = items[child]!;
      index = child;
    }
    items[index] = last;
    return top;
  }
}

/**
 * Creates a new, empty scheduler whose clock starts at `initialTime`
 * (default `simTime(0)`). Instances share no state.
 *
 * @throws {TypeError | RangeError} if `initialTime` is not a valid {@link SimTime}.
 */
export function createInMemoryScheduler(initialTime: SimTime = toSimTime(0)): InMemoryScheduler {
  let current = toSimTime(initialTime);
  const queue = new WorkQueue();
  const pendingIds = new Set<string>();
  // Work IDs are unique for the scheduler's lifetime, so completed IDs are never forgotten.
  const completedIds = new Set<string>();
  let nextSequence = 0;
  let dispatching = false;

  function now(): SimTime {
    return current;
  }

  function pendingCount(): number {
    return queue.size;
  }

  function schedule(work: ScheduledWork): void {
    if (dispatching) {
      throw new Error("Cannot schedule work while advanceTo() is dispatching");
    }
    if (!isObject(work)) {
      throw new TypeError("Scheduled work must be an object");
    }
    const { id: rawId, at: rawAt, request: rawRequest } = work;
    const id = toWorkItemId(rawId);
    const at = toSimTime(rawAt);
    if (at < current) {
      throw new RangeError(`Cannot schedule work at ${at}, earlier than the current time ${current}`);
    }
    const request = validateRequest(rawRequest);
    if (pendingIds.has(id)) {
      throw new Error(`Work item ${JSON.stringify(id)} is already pending`);
    }
    if (completedIds.has(id)) {
      throw new Error(`Work item ${JSON.stringify(id)} has already completed; work IDs cannot be reused`);
    }
    queue.push({ id, at, sequence: nextSequence++, request });
    pendingIds.add(id);
  }

  function advanceTo(target: SimTime, maxOperations: number, execute: (work: ScheduledWork) => void): AdvanceResult {
    if (dispatching) {
      throw new Error("advanceTo() is already dispatching; nested advancement is not supported");
    }
    if (typeof execute !== "function") {
      throw new TypeError(`execute must be a function, received ${typeof execute}`);
    }
    const to = toSimTime(target);
    if (to < current) {
      throw new RangeError(`Cannot advance to ${to}, earlier than the current time ${current}`);
    }
    const limit = validateMaxOperations(maxOperations);

    dispatching = true;
    try {
      let executed = 0;
      for (let next = queue.peek(); next !== undefined && next.at <= to; next = queue.peek()) {
        if (executed === limit) return { now: current, executed, reachedTarget: false };
        current = next.at;
        const returned: unknown = execute(copyForCallback(next));
        if (isThenable(returned)) {
          throw new TypeError("execute must be synchronous, but it returned a Promise or thenable");
        }
        // schedule() is blocked while dispatching, so `next` is still the head.
        queue.pop();
        pendingIds.delete(next.id);
        completedIds.add(next.id);
        executed++;
      }
      current = to;
      return { now: current, executed, reachedTarget: true };
    } finally {
      dispatching = false;
    }
  }

  return { now, pendingCount, schedule, advanceTo };
}
