/**
 * Scheduled operations over in-memory state and scheduler storage, committing
 * each successfully executed work item's effects together: its state changes,
 * random draws, emitted work, clock, and completion receipt.
 *
 * The in-memory counterpart of `loadPostgresOperationRuntime()`, without
 * persistence or driver ownership. Nothing is persisted; everything lives as
 * long as the runtime.
 */

import { stageOperation } from "./execute-in-memory-operation.ts";
import type { OperationHandler, StagedOperation, WorkEmitter } from "./execute-in-memory-operation.ts";
import type { ModuleId } from "./identifiers.ts";
import { createInMemoryStateStore } from "./in-memory-state.ts";
import type { StateValue } from "./in-memory-state.ts";
import { createInMemorySchedulerStorageWithWrites } from "./in-memory-scheduler.ts";
import type { ModuleRegistry, OperationValidationResult } from "./module-registry.ts";
import { admitEmittedWork, createScheduler } from "./scheduler.ts";
import type { Scheduler, SchedulerStorage, StoredWork } from "./scheduler.ts";
import { createSeededRandom } from "./seeded-random.ts";
import type { RandomSnapshot } from "./seeded-random.ts";
import { simTime as toSimTime } from "./sim-time.ts";
import type { SimTime } from "./sim-time.ts";

export interface InMemoryOperationRuntime {
  /**
   * In-memory scheduler storage plus a `runWork()` that commits each item's
   * effects together. `insertPending()`, `writeClock()`, and `markCompleted()`
   * reject while an item is running.
   */
  readonly storage: SchedulerStorage;

  /** `createScheduler(storage)`. */
  readonly scheduler: Scheduler;

  /**
   * Validates `input` and runs `handler` like `executeInMemoryOperation()`,
   * against the committed state and random stream, for the work item whose
   * `advanceTo()` callback is running. The handler also receives an
   * {@link WorkEmitter} for work due at or after the item's time. The changes,
   * draws, and emitted work are committed with the item's receipt once the
   * callback returns, or not at all.
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

/**
 * Creates a runtime over new, empty in-memory state and scheduler storage, with
 * the clock at `initialTime` (default `simTime(0)`) and, if `random` is given,
 * a random stream restored from it (default none). Its scheduler commits each
 * successful work item as a unit: if the callback throws, or the emitted work
 * cannot be stored, nothing of the item is kept except the clock, which stays
 * at the item's time, and the item stays pending. Readers of the storage, state,
 * or random stream never observe part of an item's commit.
 *
 * @throws {TypeError | RangeError} if `initialTime` or `random` is invalid.
 */
export function createInMemoryOperationRuntime(
  initialTime: SimTime = toSimTime(0),
  random?: RandomSnapshot,
): InMemoryOperationRuntime {
  const { storage: base, writes } = createInMemorySchedulerStorageWithWrites(initialTime);
  const store = createInMemoryStateStore();
  const stream = random === undefined ? undefined : createSeededRandom(random);
  /** Set only while a work item is running. */
  let transacting = false;
  /** Set only while a work item's callback is running. */
  let current: { at: SimTime; staged: StagedOperation | undefined } | undefined;

  /** Wraps a storage write so it rejects while a work item is running. */
  function idleWrite<A extends unknown[]>(method: (...args: A) => Promise<void>) {
    return async (...args: A): Promise<void> => {
      if (transacting) throw new Error("Cannot change scheduler storage while a work item is running");
      return method(...args);
    };
  }

  async function runWork(work: StoredWork, run: () => void): Promise<void> {
    if (transacting) throw new Error("A work item is already running");
    transacting = true;
    let staged: StagedOperation | undefined;
    try {
      // As for any failed item, the clock stays at the item's time if anything below throws.
      await base.writeClock(work.at);
      current = { at: work.at, staged: undefined };
      try {
        run();
      } finally {
        staged = current.staged;
        current = undefined;
      }
      let emitted: StoredWork[] = [];
      if (staged !== undefined && staged.emitted.length > 0) {
        const admission = await admitEmittedWork(base, staged.emitted);
        if ("rejected" in admission) throw admission.rejected;
        emitted = admission.admitted;
      }
      // The commit runs synchronously, so no reader sees part of it. Nothing in it can fail: the
      // emitted IDs are distinct and unused, their sequences start at the stored next sequence and
      // stay safe, `work` is pending, and no other write runs meanwhile.
      for (const item of emitted) writes.insertPending(item, item.sequence + 1);
      writes.markCompleted(work.id);
      staged?.publish();
    } finally {
      staged?.end();
      transacting = false;
    }
  }

  const storage: SchedulerStorage = {
    ...base,
    insertPending: idleWrite(base.insertPending),
    writeClock: idleWrite(base.writeClock),
    markCompleted: idleWrite(base.markCompleted),
    runWork,
  };

  function execute(registry: ModuleRegistry, input: unknown, handler: OperationHandler): OperationValidationResult {
    if (current === undefined) {
      throw new Error("execute() can only run inside an advanceTo() callback of this runtime's scheduler");
    }
    if (current.staged !== undefined) {
      throw new Error("This work item has already executed an operation; only one operation per work item is supported");
    }
    const staged = stageOperation(registry, store, input, handler, stream, current.at);
    if (!staged.ok) return staged;
    current.staged = staged;
    return staged.result;
  }

  function read(owner: ModuleId, key: string): StateValue | undefined {
    return store.forModule(owner).get(owner, key);
  }

  function randomSnapshot(): RandomSnapshot | undefined {
    return stream?.snapshot();
  }

  return { storage, scheduler: createScheduler(storage), execute, read, randomSnapshot };
}
