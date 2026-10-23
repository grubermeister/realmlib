/**
 * Opaque identifier types for simulation objects.
 *
 * Identifier values are supplied by callers. These factories only validate and
 * brand a string; they do not generate, register, or check uniqueness of IDs.
 */

declare const entityIdBrand: unique symbol;
declare const moduleIdBrand: unique symbol;
declare const workItemIdBrand: unique symbol;

/** Caller-supplied identifier in the entity namespace. */
export type EntityId = string & { readonly [entityIdBrand]: true };

/** Caller-supplied identifier in the module namespace. */
export type ModuleId = string & { readonly [moduleIdBrand]: true };

/** Caller-supplied identifier in the work-item namespace. */
export type WorkItemId = string & { readonly [workItemIdBrand]: true };

/**
 * @internal Why `value` cannot be stored as PostgreSQL text and read back
 * unchanged, or `undefined` if it can. PostgreSQL rejects U+0000, and an
 * unpaired UTF-16 surrogate has no UTF-8 encoding (`pg` silently replaces it
 * with U+FFFD). Applies to identifiers, operation names, and state keys.
 */
export function textStorageProblem(value: string): string | undefined {
  if (value.includes("\u0000")) return "must not contain U+0000";
  if (!value.isWellFormed()) return "must not contain unpaired UTF-16 surrogates";
  return undefined;
}

function validateId(value: unknown, typeName: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${typeName} must be a string, received ${typeof value}`);
  }
  if (value.trim() === "") {
    throw new RangeError(`${typeName} must not be empty or whitespace-only`);
  }
  const problem = textStorageProblem(value);
  if (problem !== undefined) throw new RangeError(`${typeName} ${problem}`);
  return value;
}

/**
 * Brands a nonempty, non-whitespace-only string as an {@link EntityId}.
 * The value is returned unchanged.
 *
 * @throws {TypeError} if `value` is not a string.
 * @throws {RangeError} if `value` is empty or whitespace-only, or contains
 *   U+0000 or an unpaired UTF-16 surrogate.
 */
export function entityId(value: string): EntityId {
  return validateId(value, "EntityId") as EntityId;
}

/**
 * Brands a nonempty, non-whitespace-only string as a {@link ModuleId}.
 * The value is returned unchanged.
 *
 * @throws {TypeError} if `value` is not a string.
 * @throws {RangeError} if `value` is empty or whitespace-only, or contains
 *   U+0000 or an unpaired UTF-16 surrogate.
 */
export function moduleId(value: string): ModuleId {
  return validateId(value, "ModuleId") as ModuleId;
}

/**
 * Brands a nonempty, non-whitespace-only string as a {@link WorkItemId}.
 * The value is returned unchanged.
 *
 * @throws {TypeError} if `value` is not a string.
 * @throws {RangeError} if `value` is empty or whitespace-only, or contains
 *   U+0000 or an unpaired UTF-16 surrogate.
 */
export function workItemId(value: string): WorkItemId {
  return validateId(value, "WorkItemId") as WorkItemId;
}
