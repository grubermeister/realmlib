/**
 * Atomic execution of one validated operation against an in-memory store.
 *
 * The caller supplies the handler for each invocation; there is no handler
 * registry, dispatch, queue, or scheduling here.
 */

import { workItemId as toWorkItemId } from "./identifiers.ts";
import type { ModuleId } from "./identifiers.ts";
import { stagingFor } from "./in-memory-state.ts";
import type { InMemoryStateStore, ModuleStateAccess, StateValue } from "./in-memory-state.ts";
import type { ModuleRegistry, OperationRequest, OperationValidationResult } from "./module-registry.ts";
import { sameWork, validateRequest, WorkIdConflictError } from "./scheduler.ts";
import type { ScheduledWork, StoredWork } from "./scheduler.ts";
import { randomDrawsFor } from "./seeded-random.ts";
import type { RandomDraws, RandomSnapshot, RandomSource, SeededRandom } from "./seeded-random.ts";
import { simTime as toSimTime } from "./sim-time.ts";
import type { SimTime } from "./sim-time.ts";

/** Lets an operation handler queue follow-up work as one of the operation's effects. */
export interface WorkEmitter {
  /** The simulation time of the work item the operation runs for. Emitted work is due no earlier. */
  readonly now: SimTime;

  /**
   * Queues a snapshot of `work`, validated like `Scheduler.schedule()`. It is
   * held with the operation's other effects and stored only if the operation
   * commits. The destination may be any module.
   *
   * @throws {TypeError | RangeError} if the ID, time, or request is invalid, or
   *   `work.at` is earlier than `now`; nothing is queued.
   * @throws {WorkIdConflictError} if this operation already emitted different work with the same ID.
   * @throws {Error} once the handler has returned.
   */
  emit(work: ScheduledWork): void;
}

/**
 * Applies one validated operation. Must be synchronous. `state` is a staged
 * view bound to `request.moduleId` that is valid only during this call.
 * `random` is present only if the caller supplied a stream; its draws come from
 * a private working copy, are kept only if the operation commits, and it too is
 * valid only during this call. `emitter` is present only when the operation
 * runs for a scheduled work item of an operation runtime; it too is valid only
 * during this call.
 */
export type OperationHandler = (
  request: OperationRequest,
  state: ModuleStateAccess,
  random?: RandomSource,
  emitter?: WorkEmitter,
) => void;

function isThenable(value: unknown): boolean {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** Work emitted by one operation, held until it commits. */
interface Emission {
  readonly emitter: WorkEmitter;
  /** Invalidates `emitter`. */
  close(): void;
  /** The distinct emitted items, in emission order. */
  emitted(): Omit<StoredWork, "sequence">[];
}

function beginEmission(now: SimTime): Emission {
  let open = true;
  // Keyed by ID; a Map keeps emission order.
  const emitted = new Map<string, Omit<StoredWork, "sequence">>();

  function emit(work: ScheduledWork): void {
    if (!open) throw new Error("Work emitter is no longer valid: its operation's handler has returned");
    if (typeof work !== "object" || work === null) {
      throw new TypeError("Emitted work must be an object");
    }
    // Read each field once, then validate in the same order as schedule().
    const { id: rawId, at: rawAt, request: rawRequest } = work;
    const id = toWorkItemId(rawId);
    const at = toSimTime(rawAt);
    const request = validateRequest(rawRequest);
    if (at < now) {
      throw new RangeError(`Cannot emit work at ${at}, earlier than the operation's time ${now}`);
    }
    const item = { id, at, request };
    const earlier = emitted.get(id);
    if (earlier !== undefined) {
      // The same request again is one work item, as for schedule().
      if (sameWork(earlier, item)) return;
      throw new WorkIdConflictError(
        `Work item ${JSON.stringify(id)} was already emitted by this operation with a different request`,
        "pending",
      );
    }
    emitted.set(id, item);
  }

  return {
    emitter: Object.freeze({ now, emit }),
    close() {
      open = false;
    },
    emitted: () => [...emitted.values()],
  };
}

/**
 * Validates `input` with `registry`, then runs `handler` against a staged view
 * of `store` bound to the request's module. The handler's changes are committed
 * together only if it returns synchronously without throwing.
 *
 * If `random` is supplied, the handler draws from a working copy of it, which
 * is published to `random` together with the state changes; on any failure
 * `random` keeps its pre-operation position.
 *
 * Returns the registry's validation result. On a validation failure the handler
 * is not called and neither the store nor `random` changes.
 *
 * @throws {TypeError} if `handler` is not a function, `store` was not created by
 *   `createInMemoryStateStore()`, `random` was not created by
 *   `createSeededRandom()`, or the handler returns a Promise or thenable.
 * @throws {Error} if an operation is already executing against `store` or holds `random`.
 * @throws whatever the payload validator or handler throws; no changes are committed.
 */
export function executeInMemoryOperation(
  registry: ModuleRegistry,
  store: InMemoryStateStore,
  input: unknown,
  handler: OperationHandler,
  random?: SeededRandom,
): OperationValidationResult {
  const staged = stageOperation(registry, store, input, handler, random);
  if (!staged.ok) return staged;
  try {
    staged.publish();
  } finally {
    staged.end();
  }
  return staged.result;
}

/**
 * An operation whose handler has returned but whose changes are not yet
 * published. It keeps `store` and `random` held until `end()`.
 * Package-internal: not exported from the package root.
 */
export interface StagedOperation {
  readonly ok: true;
  readonly result: OperationValidationResult & { readonly ok: true };
  /** The module whose records the changes belong to. */
  readonly owner: ModuleId;
  /** Staged record changes in staging order; `undefined` marks a deletion. */
  readonly changes: readonly (readonly [string, StateValue | undefined])[];
  /** The stream's position after the handler's draws, if a stream was supplied. */
  readonly random: RandomSnapshot | undefined;
  /** Validated work the handler emitted, distinct by ID, in emission order. */
  readonly emitted: readonly Omit<StoredWork, "sequence">[];
  /** Publishes the state changes and draws together. Does not throw. */
  publish(): void;
  /** Releases `store` and `random`, discarding anything not published. */
  end(): void;
}

/**
 * @internal Like {@link executeInMemoryOperation}, but on success returns the
 * staged changes instead of publishing them, so the caller can make them
 * durable first. The caller must call `end()`. On a validation failure, or if
 * the handler throws or returns a thenable, nothing stays held.
 *
 * If `emitAt` is given, the handler receives a {@link WorkEmitter} whose `now`
 * is `emitAt`, and the staged operation carries what it emitted; the
 * caller stores that. Otherwise the handler's `emitter` is `undefined`.
 */
export function stageOperation(
  registry: ModuleRegistry,
  store: InMemoryStateStore,
  input: unknown,
  handler: OperationHandler,
  random?: SeededRandom,
  emitAt?: SimTime,
): StagedOperation | (OperationValidationResult & { readonly ok: false }) {
  if (typeof handler !== "function") {
    throw new TypeError(`Operation handler must be a function, received ${typeof handler}`);
  }
  const beginStaged = stagingFor(store);
  const beginDraws = random === undefined ? undefined : randomDrawsFor(random);

  const result = registry.validate(input);
  if (!result.ok) return result;

  const staged = beginStaged(result.request.moduleId);
  let draws: RandomDraws | undefined;
  const emission = emitAt === undefined ? undefined : beginEmission(emitAt);
  try {
    draws = beginDraws?.();
    let returned: unknown;
    try {
      returned = handler(result.request, staged.access, draws?.source, emission?.emitter);
    } finally {
      emission?.close();
    }
    if (isThenable(returned)) {
      throw new TypeError("Operation handler must be synchronous, but it returned a Promise or thenable");
    }
    const changes = staged.changes();
    const snapshot = draws?.snapshot();
    const held = draws;
    return {
      ok: true,
      result,
      owner: staged.owner,
      changes,
      random: snapshot,
      emitted: emission?.emitted() ?? [],
      publish() {
        // Both publications are single swaps that cannot throw, so they land together.
        staged.commit();
        held?.commit();
      },
      end() {
        held?.end();
        staged.end();
      },
    };
  } catch (error) {
    draws?.end();
    staged.end();
    throw error;
  }
}
