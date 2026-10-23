/**
 * Atomic execution of one validated operation against an in-memory store.
 *
 * The caller supplies the handler for each invocation; there is no handler
 * registry, dispatch, queue, or scheduling here.
 */

import { stagingFor } from "./in-memory-state.ts";
import type { InMemoryStateStore, ModuleStateAccess } from "./in-memory-state.ts";
import type { ModuleRegistry, OperationRequest, OperationValidationResult } from "./module-registry.ts";
import { randomDrawsFor } from "./seeded-random.ts";
import type { RandomDraws, RandomSource, SeededRandom } from "./seeded-random.ts";

/**
 * Applies one validated operation. Must be synchronous. `state` is a staged
 * view bound to `request.moduleId` that is valid only during this call.
 * `random` is present only if the caller supplied a stream; its draws come from
 * a private working copy, are kept only if the operation commits, and it too is
 * valid only during this call.
 */
export type OperationHandler = (request: OperationRequest, state: ModuleStateAccess, random?: RandomSource) => void;

function isThenable(value: unknown): boolean {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
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
  if (typeof handler !== "function") {
    throw new TypeError(`Operation handler must be a function, received ${typeof handler}`);
  }
  const beginStaged = stagingFor(store);
  const beginDraws = random === undefined ? undefined : randomDrawsFor(random);

  const result = registry.validate(input);
  if (!result.ok) return result;

  const staged = beginStaged(result.request.moduleId);
  let draws: RandomDraws | undefined;
  try {
    draws = beginDraws?.();
    const returned: unknown = handler(result.request, staged.access, draws?.source);
    if (isThenable(returned)) {
      throw new TypeError("Operation handler must be synchronous, but it returned a Promise or thenable");
    }
    // Both publications are single swaps that cannot throw, so they land together.
    staged.commit();
    draws?.commit();
  } finally {
    draws?.end();
    staged.end();
  }
  return result;
}
