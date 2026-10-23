/**
 * In-memory {@link SchedulerStorage}, and a scheduler over a fresh one.
 *
 * Nothing here is persisted: the storage lives exactly as long as the object.
 */

import type { WorkItemId } from "./identifiers.ts";
import { copyState } from "./in-memory-state.ts";
import { createScheduler, validatePositiveCount, validateSequence } from "./scheduler.ts";
import type { Scheduler, SchedulerStorage, StoredWork, WorkIdStatus } from "./scheduler.ts";
import { simTime as toSimTime } from "./sim-time.ts";
import type { SimTime } from "./sim-time.ts";

function copyWork(work: StoredWork): StoredWork {
  const { moduleId, operation, payloadVersion, payload } = work.request;
  return {
    id: work.id,
    at: work.at,
    sequence: work.sequence,
    request: { moduleId, operation, payloadVersion, payload: copyState(payload) },
  };
}

function precedes(x: StoredWork, y: StoredWork): boolean {
  return x.at < y.at || (x.at === y.at && x.sequence < y.sequence);
}

/** Binary min-heap. */
class MinHeap<T> {
  readonly #items: T[] = [];
  readonly #precedes: (x: T, y: T) => boolean;

  constructor(precedesFn: (x: T, y: T) => boolean) {
    this.#precedes = precedesFn;
  }

  get size(): number {
    return this.#items.length;
  }

  push(item: T): void {
    this.#siftUp(this.#items.push(item) - 1, item);
  }

  pop(): T | undefined {
    return this.removeAt(0);
  }

  indexOf(match: (item: T) => boolean): number {
    return this.#items.findIndex(match);
  }

  removeAt(index: number): T | undefined {
    const items = this.#items;
    const removed = items[index];
    const last = items.pop();
    if (removed === undefined || last === undefined || index === items.length) return removed;
    if (index > 0 && this.#precedes(last, items[(index - 1) >> 1]!)) {
      this.#siftUp(index, last);
    } else {
      this.#siftDown(index, last);
    }
    return removed;
  }

  /** Yields items in heap order without removing them. */
  *ordered(): Generator<T> {
    const items = this.#items;
    if (items.length === 0) return;
    const frontier = new MinHeap<number>((i, j) => this.#precedes(items[i]!, items[j]!));
    frontier.push(0);
    for (let index = frontier.pop(); index !== undefined; index = frontier.pop()) {
      yield items[index]!;
      const left = 2 * index + 1;
      if (left < items.length) frontier.push(left);
      if (left + 1 < items.length) frontier.push(left + 1);
    }
  }

  #siftUp(index: number, item: T): void {
    const items = this.#items;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!this.#precedes(item, items[parent]!)) break;
      items[index] = items[parent]!;
      index = parent;
    }
    items[index] = item;
  }

  #siftDown(index: number, item: T): void {
    const items = this.#items;
    for (;;) {
      const left = 2 * index + 1;
      if (left >= items.length) break;
      const right = left + 1;
      const child = right < items.length && this.#precedes(items[right]!, items[left]!) ? right : left;
      if (!this.#precedes(items[child]!, item)) break;
      items[index] = items[child]!;
      index = child;
    }
    items[index] = item;
  }
}

/**
 * Creates new, empty in-memory scheduler storage whose clock starts at
 * `initialTime` (default `simTime(0)`) and whose next sequence is `0`.
 * Instances share no state.
 *
 * @throws {TypeError | RangeError} if `initialTime` is not a valid {@link SimTime}.
 */
export function createInMemorySchedulerStorage(initialTime: SimTime = toSimTime(0)): SchedulerStorage {
  let clock = toSimTime(initialTime);
  let nextSequence = 0;
  const queue = new MinHeap<StoredWork>(precedes);
  const pendingIds = new Set<string>();
  // Work IDs are unique for the storage's lifetime, so completed IDs are never forgotten.
  const completedIds = new Set<string>();

  function status(id: string): WorkIdStatus {
    if (pendingIds.has(id)) return "pending";
    if (completedIds.has(id)) return "completed";
    return undefined;
  }

  return {
    async readClock() {
      return clock;
    },

    async writeClock(now) {
      clock = toSimTime(now);
    },

    async readNextSequence() {
      return nextSequence;
    },

    async insertPending(work, next) {
      const stored = copyWork(work);
      if (status(stored.id) !== undefined) {
        throw new Error(`Work item ${JSON.stringify(stored.id)} is already ${status(stored.id)}`);
      }
      // validateSequence() also rejects -0, which `<` would let through at sequence 0.
      if (validateSequence(stored.sequence, "Work sequence") < nextSequence) {
        throw new RangeError(`Work sequence ${stored.sequence} is below the next sequence ${nextSequence}`);
      }
      if (validateSequence(next, "Next sequence") <= stored.sequence) {
        throw new RangeError(`Next sequence ${next} must be a safe integer above ${stored.sequence}`);
      }
      queue.push(stored);
      pendingIds.add(stored.id);
      nextSequence = next;
    },

    async readDue(until, limit) {
      const to = toSimTime(until);
      const max = validatePositiveCount(limit, "limit");
      const due: StoredWork[] = [];
      for (const work of queue.ordered()) {
        if (work.at > to || due.length === max) break;
        due.push(copyWork(work));
      }
      return due;
    },

    async countPending() {
      return queue.size;
    },

    async readWorkIdStatus(id: WorkItemId) {
      return status(id);
    },

    async markCompleted(id: WorkItemId) {
      if (!pendingIds.has(id)) {
        throw new Error(`Work item ${JSON.stringify(id)} is not pending`);
      }
      queue.removeAt(queue.indexOf((work) => work.id === id));
      pendingIds.delete(id);
      completedIds.add(id);
    },
  };
}

/**
 * Creates a scheduler over new in-memory storage whose clock starts at
 * `initialTime` (default `simTime(0)`). Equivalent to
 * `createScheduler(createInMemorySchedulerStorage(initialTime))`.
 *
 * @throws {TypeError | RangeError} if `initialTime` is not a valid {@link SimTime}.
 */
export function createInMemoryScheduler(initialTime: SimTime = toSimTime(0)): Scheduler {
  return createScheduler(createInMemorySchedulerStorage(initialTime));
}
