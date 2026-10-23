/**
 * In-memory state store with per-module namespaces.
 *
 * Records are addressed by (module ID, key). Any module may read any record,
 * but writes go through an access object bound to a single owning module.
 * Ownership is an API boundary for trusted code, not a security mechanism.
 * Direct access has no persistence, multi-record atomicity, or rollback; a
 * private staging path (see {@link stagingFor}) supports atomic operations.
 */

import { moduleId as toModuleId } from "./identifiers.ts";
import type { ModuleId } from "./identifiers.ts";

/** Ordinary JSON-compatible data. Numbers must be finite and not -0. */
export type StateValue =
  | null
  | boolean
  | number
  | string
  | readonly StateValue[]
  | { readonly [key: string]: StateValue };

/** State access bound to one owning module. */
export interface ModuleStateAccess {
  /**
   * Reads a record from any module's namespace. Returns a copy of the stored
   * value, or `undefined` if no record exists.
   *
   * @throws {TypeError | RangeError} if `owner` or `key` is invalid.
   */
  get(owner: ModuleId, key: string): StateValue | undefined;

  /**
   * Creates or replaces a record in the bound module's namespace, storing a
   * copy of `value`. An invalid value leaves any existing record unchanged.
   *
   * @throws {TypeError | RangeError} if `key` is invalid.
   * @throws {TypeError} if `value` is not a valid {@link StateValue}.
   */
  set(key: string, value: StateValue): void;

  /**
   * Removes a record from the bound module's namespace.
   * Returns `true` if a record existed.
   *
   * @throws {TypeError | RangeError} if `key` is invalid.
   */
  delete(key: string): boolean;
}

export interface InMemoryStateStore {
  /**
   * Returns an access object bound to `owner`. Access objects for the same
   * owner share the same records. Does not register or create anything.
   *
   * @throws {TypeError | RangeError} if `owner` is not a valid module ID.
   */
  forModule(owner: ModuleId): ModuleStateAccess;
}

function validateKey(key: unknown): string {
  if (typeof key !== "string") {
    throw new TypeError(`State key must be a string, received ${typeof key}`);
  }
  if (key.trim() === "") {
    throw new RangeError("State key must not be empty or whitespace-only");
  }
  return key;
}

function invalid(path: string, problem: string): TypeError {
  return new TypeError(`Invalid state value at ${path}: ${problem}`);
}

/**
 * Returns a deep copy of `value`, throwing TypeError if any part of it is not
 * plain JSON-compatible data. `ancestors` holds the containers currently being
 * copied so cycles are detected; shared non-cyclic references are allowed.
 */
function copyStateValue(value: unknown, path: string, ancestors: Set<object>): StateValue {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) throw invalid(path, `non-finite number ${value}`);
      // JSON would silently turn -0 into 0.
      if (Object.is(value, -0)) throw invalid(path, "negative zero");
      return value;
    case "object":
      break;
    default:
      throw invalid(path, `unsupported type ${typeof value}`);
  }
  if (value === null) return null;
  if (ancestors.has(value)) throw invalid(path, "cyclic structure");

  ancestors.add(value);
  try {
    return Array.isArray(value) ? copyArray(value, path, ancestors) : copyObject(value, path, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function copyArray(source: unknown[], path: string, ancestors: Set<object>): StateValue[] {
  if (Object.getPrototypeOf(source) !== Array.prototype) {
    throw invalid(path, "array subclass");
  }
  const length = source.length;
  // Own keys of a dense array without extra properties are its indices plus "length".
  if (Reflect.ownKeys(source).length !== length + 1) {
    throw invalid(path, "sparse array or array with extra properties");
  }
  const copy: StateValue[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(source, index);
    if (descriptor === undefined) throw invalid(path, `sparse array (missing index ${index})`);
    if (!("value" in descriptor)) throw invalid(`${path}[${index}]`, "accessor property");
    copy.push(copyStateValue(descriptor.value, `${path}[${index}]`, ancestors));
  }
  return copy;
}

function copyObject(source: object, path: string, ancestors: Set<object>): { [key: string]: StateValue } {
  const prototype: unknown = Object.getPrototypeOf(source);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalid(path, "not a plain object");
  }
  const copy = Object.create(prototype) as { [key: string]: StateValue };
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key === "symbol") throw invalid(path, "symbol-keyed property");
    const where = `${path}[${JSON.stringify(key)}]`;
    const descriptor = Object.getOwnPropertyDescriptor(source, key)!;
    if (!("value" in descriptor)) throw invalid(where, "accessor property");
    if (!descriptor.enumerable) throw invalid(where, "non-enumerable property");
    // defineProperty, not assignment, so a "__proto__" key stays an ordinary own property.
    Object.defineProperty(copy, key, {
      value: copyStateValue(descriptor.value, where, ancestors),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return copy;
}

/**
 * Returns a validated deep copy of `value` as a {@link StateValue}. `path` names
 * the value in error messages. Package-internal: not exported from the package root.
 *
 * @throws {TypeError} if `value` is not a valid {@link StateValue}.
 */
export function copyState(value: unknown, path = "value"): StateValue {
  return copyStateValue(value, path, new Set());
}

/**
 * A staged, single-module view of a store. Writes through `access` go to a
 * private overlay until `commit()` publishes them; `end()` invalidates `access`.
 * Package-internal: not exported from the package root.
 */
export interface StagedState {
  readonly access: ModuleStateAccess;
  /** Publishes every staged change at once. */
  commit(): void;
  /** Invalidates `access` and releases the store. Discards uncommitted changes. */
  end(): void;
}

/** Starts staging changes for `owner`. Throws if the store is already staging. */
export type BeginStagedState = (owner: ModuleId) => StagedState;

const stagingByStore = new WeakMap<InMemoryStateStore, BeginStagedState>();

/**
 * Returns the private staging entry point of a store created by
 * {@link createInMemoryStateStore}. Package-internal.
 *
 * @throws {TypeError} if `store` was not created by `createInMemoryStateStore`.
 */
export function stagingFor(store: InMemoryStateStore): BeginStagedState {
  const begin = typeof store === "object" && store !== null ? stagingByStore.get(store) : undefined;
  if (begin === undefined) {
    throw new TypeError("Store must be created by createInMemoryStateStore()");
  }
  return begin;
}

/** Marks a staged deletion in an overlay. */
const DELETED: unique symbol = Symbol("deleted");

/** Creates a new, empty store. Instances share no state. */
export function createInMemoryStateStore(): InMemoryStateStore {
  const namespaces = new Map<string, Map<string, StateValue>>();
  let staging = false;

  function readCommitted(owner: ModuleId, key: string): StateValue | undefined {
    const id: string = toModuleId(owner);
    const k = validateKey(key);
    const records = namespaces.get(id);
    if (records === undefined || !records.has(k)) return undefined;
    return copyState(records.get(k));
  }

  function forModule(owner: ModuleId): ModuleStateAccess {
    const bound: string = toModuleId(owner);

    function get(owner: ModuleId, key: string): StateValue | undefined {
      return readCommitted(owner, key);
    }

    function set(key: string, value: StateValue): void {
      const k = validateKey(key);
      // Copy (and validate) before touching storage so a failure changes nothing.
      const copy = copyState(value);
      let records = namespaces.get(bound);
      if (records === undefined) {
        records = new Map();
        namespaces.set(bound, records);
      }
      records.set(k, copy);
    }

    function deleteRecord(key: string): boolean {
      const k = validateKey(key);
      const records = namespaces.get(bound);
      if (records === undefined || !records.delete(k)) return false;
      if (records.size === 0) namespaces.delete(bound);
      return true;
    }

    return { get, set, delete: deleteRecord };
  }

  function beginStaged(owner: ModuleId): StagedState {
    const bound: string = toModuleId(owner);
    if (staging) {
      throw new Error("Store is already executing an operation; nested execution is not supported");
    }
    staging = true;
    let active = true;
    // Staged changes to the bound module's records. Values are validated copies.
    const overlay = new Map<string, StateValue | typeof DELETED>();

    function assertActive(): void {
      if (!active) throw new Error("Staged state access is no longer valid: its operation has ended");
    }

    function get(owner: ModuleId, key: string): StateValue | undefined {
      assertActive();
      const id: string = toModuleId(owner);
      const k = validateKey(key);
      if (id === bound && overlay.has(k)) {
        const staged = overlay.get(k)!;
        return staged === DELETED ? undefined : copyState(staged);
      }
      return readCommitted(owner, k);
    }

    function set(key: string, value: StateValue): void {
      assertActive();
      const k = validateKey(key);
      overlay.set(k, copyState(value));
    }

    function deleteRecord(key: string): boolean {
      assertActive();
      const k = validateKey(key);
      const staged = overlay.get(k);
      const exists = staged === undefined ? namespaces.get(bound)?.has(k) === true : staged !== DELETED;
      if (exists) overlay.set(k, DELETED);
      return exists;
    }

    function commit(): void {
      assertActive();
      if (overlay.size === 0) return;
      // Build the module's next namespace privately, then publish it with one swap.
      const next = new Map(namespaces.get(bound));
      for (const [k, staged] of overlay) {
        if (staged === DELETED) next.delete(k);
        else next.set(k, staged);
      }
      if (next.size === 0) namespaces.delete(bound);
      else namespaces.set(bound, next);
      overlay.clear();
    }

    function end(): void {
      if (!active) return;
      active = false;
      overlay.clear();
      staging = false;
    }

    return { access: { get, set, delete: deleteRecord }, commit, end };
  }

  const store: InMemoryStateStore = { forModule };
  stagingByStore.set(store, beginStaged);
  return store;
}
