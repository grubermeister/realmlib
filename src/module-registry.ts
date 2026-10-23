/**
 * Registry of simulation modules and the operation types they accept.
 *
 * The registry only answers whether an incoming operation request is addressed
 * to a registered module, at a supported version, with an acceptable payload.
 * It does not execute operations, mutate state, or create work items.
 */

import { moduleId as toModuleId, textStorageProblem } from "./identifiers.ts";
import type { ModuleId } from "./identifiers.ts";

/** One operation type accepted by a module, at exactly one payload version. */
export interface OperationDefinition {
  readonly name: string;
  readonly version: number;
  readonly validatePayload: (payload: unknown) => boolean;
}

/** A module and the complete set of operations it accepts. */
export interface ModuleDefinition {
  readonly id: ModuleId;
  readonly operations: readonly OperationDefinition[];
}

/** An operation envelope addressed to a module. */
export interface OperationRequest {
  readonly moduleId: ModuleId;
  readonly operation: string;
  readonly payloadVersion: number;
  readonly payload: unknown;
}

export type OperationValidationResult =
  | { readonly ok: true; readonly request: OperationRequest }
  | {
      readonly ok: false;
      readonly reason:
        | "malformed-request"
        | "unknown-module"
        | "unknown-operation"
        | "unsupported-version"
        | "invalid-payload";
    };

export interface ModuleRegistry {
  /**
   * Registers a module and its operations. Registration is atomic: an invalid
   * definition throws and leaves the registry unchanged.
   *
   * @throws {TypeError | RangeError} if the module ID is invalid.
   * @throws {Error} if the definition is malformed, contains duplicate operation
   *   names, or the module ID is already registered.
   */
  register(definition: ModuleDefinition): void;

  /**
   * Checks an untrusted operation envelope against the registered modules.
   * Calls the matching operation's payload validator at most once.
   *
   * @throws whatever the payload validator throws.
   * @throws {TypeError} if the payload validator returns a nonboolean value.
   */
  validate(input: unknown): OperationValidationResult;
}

interface RegisteredOperation {
  readonly version: number;
  readonly validatePayload: (payload: unknown) => boolean;
}

function isOperationName(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && textStorageProblem(value) === undefined;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isPlainObject(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(reason: Extract<OperationValidationResult, { ok: false }>["reason"]): OperationValidationResult {
  return { ok: false, reason };
}

/** Creates a new, empty registry. Instances share no state. */
export function createModuleRegistry(): ModuleRegistry {
  const modules = new Map<string, Map<string, RegisteredOperation>>();

  function register(definition: ModuleDefinition): void {
    if (!isPlainObject(definition)) {
      throw new TypeError("Module definition must be an object");
    }
    const id: string = toModuleId(definition.id);
    if (modules.has(id)) {
      throw new Error(`Module ${JSON.stringify(id)} is already registered`);
    }

    const operations: unknown = definition.operations;
    if (!Array.isArray(operations)) {
      throw new TypeError(`Module ${JSON.stringify(id)}: operations must be an array`);
    }

    // Copy each descriptor's fields so later caller mutation cannot affect the registry.
    const registered = new Map<string, RegisteredOperation>();
    for (let index = 0; index < operations.length; index++) {
      const where = `Module ${JSON.stringify(id)}, operation ${index}`;
      const operation: unknown = operations[index];
      if (!isPlainObject(operation)) {
        throw new TypeError(`${where}: definition must be an object`);
      }
      const { name, version, validatePayload } = operation;
      if (!isOperationName(name)) {
        throw new TypeError(
          `${where}: name must be a nonempty, non-whitespace-only string without U+0000 or unpaired surrogates`,
        );
      }
      if (!isPositiveSafeInteger(version)) {
        throw new RangeError(`${where} (${JSON.stringify(name)}): version must be a positive safe integer`);
      }
      if (typeof validatePayload !== "function") {
        throw new TypeError(`${where} (${JSON.stringify(name)}): validatePayload must be a function`);
      }
      if (registered.has(name)) {
        throw new Error(`Module ${JSON.stringify(id)}: duplicate operation name ${JSON.stringify(name)}`);
      }
      registered.set(name, { version, validatePayload: validatePayload as RegisteredOperation["validatePayload"] });
    }

    modules.set(id, registered);
  }

  function validate(input: unknown): OperationValidationResult {
    if (!isPlainObject(input)) return fail("malformed-request");
    for (const field of ["moduleId", "operation", "payloadVersion", "payload"]) {
      if (!Object.hasOwn(input, field)) return fail("malformed-request");
    }

    // Read each field once so accessors cannot yield different values between checks.
    const { moduleId, operation, payloadVersion, payload } = input;
    let id: ModuleId;
    try {
      id = toModuleId(moduleId as string);
    } catch {
      return fail("malformed-request");
    }
    if (!isOperationName(operation) || !isPositiveSafeInteger(payloadVersion)) {
      return fail("malformed-request");
    }

    const operations = modules.get(id);
    if (operations === undefined) return fail("unknown-module");
    const registered = operations.get(operation);
    if (registered === undefined) return fail("unknown-operation");
    if (registered.version !== payloadVersion) return fail("unsupported-version");

    const validatePayload = registered.validatePayload;
    const accepted: unknown = validatePayload(payload);
    if (typeof accepted !== "boolean") {
      throw new TypeError(
        `Payload validator for ${JSON.stringify(id)}/${JSON.stringify(operation)} must return a boolean, received ${typeof accepted}`,
      );
    }
    if (!accepted) return fail("invalid-payload");

    return { ok: true, request: { moduleId: id, operation, payloadVersion, payload } };
  }

  return { register, validate };
}
