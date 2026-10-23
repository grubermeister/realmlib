/**
 * Atomic execution of one validated operation against an in-memory store.
 *
 * The caller supplies the handler for each invocation; there is no handler
 * registry, dispatch, queue, or scheduling here.
 */

import { stagingFor } from "./in-memory-state.ts";
import type { InMemoryStateStore, ModuleStateAccess } from "./in-memory-state.ts";
import type { ModuleRegistry, OperationRequest, OperationValidationResult } from "./module-registry.ts";

/**
 * Applies one validated operation. Must be synchronous. `state` is a staged
 * view bound to `request.moduleId` that is valid only during this call.
 */
export type OperationHandler = (request: OperationRequest, state: ModuleStateAccess) => void;

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
 * Returns the registry's validation result. On a validation failure the handler
 * is not called and the store is unchanged.
 *
 * @throws {TypeError} if `handler` is not a function, `store` was not created by
 *   `createInMemoryStateStore()`, or the handler returns a Promise or thenable.
 * @throws {Error} if an operation is already executing against `store`.
 * @throws whatever the payload validator or handler throws; no changes are committed.
 */
export function executeInMemoryOperation(
  registry: ModuleRegistry,
  store: InMemoryStateStore,
  input: unknown,
  handler: OperationHandler,
): OperationValidationResult {
  if (typeof handler !== "function") {
    throw new TypeError(`Operation handler must be a function, received ${typeof handler}`);
  }
  const beginStaged = stagingFor(store);

  const result = registry.validate(input);
  if (!result.ok) return result;

  const staged = beginStaged(result.request.moduleId);
  try {
    const returned: unknown = handler(result.request, staged.access);
    if (isThenable(returned)) {
      throw new TypeError("Operation handler must be synchronous, but it returned a Promise or thenable");
    }
    staged.commit();
  } finally {
    staged.end();
  }
  return result;
}
