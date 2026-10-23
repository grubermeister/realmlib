import { describe, expect, mock, test } from "bun:test";
import { createModuleRegistry, moduleId } from "../src/index.ts";
import type { ModuleDefinition, OperationDefinition, OperationRequest } from "../src/index.ts";

const accept = () => true;

function op(name: string, version = 1, validatePayload: (payload: unknown) => boolean = accept): OperationDefinition {
  return { name, version, validatePayload };
}

function request(overrides: Partial<Record<keyof OperationRequest, unknown>> = {}): Record<string, unknown> {
  return { moduleId: "mod-a", operation: "op-x", payloadVersion: 1, payload: 7, ...overrides };
}

function registryWith(...definitions: ModuleDefinition[]) {
  const registry = createModuleRegistry();
  for (const definition of definitions) registry.register(definition);
  return registry;
}

describe("registries", () => {
  test("a new registry has no modules", () => {
    expect(createModuleRegistry().validate(request())).toEqual({ ok: false, reason: "unknown-module" });
  });

  test("registrations do not leak between instances", () => {
    const first = createModuleRegistry();
    const second = createModuleRegistry();
    first.register({ id: moduleId("mod-a"), operations: [op("op-x")] });

    expect(first.validate(request()).ok).toBe(true);
    expect(second.validate(request())).toEqual({ ok: false, reason: "unknown-module" });
    // The same ID can be registered independently in another instance.
    expect(() => second.register({ id: moduleId("mod-a"), operations: [] })).not.toThrow();
  });
});

describe("register", () => {
  test("accepts a module with no operations", () => {
    const registry = registryWith({ id: moduleId("mod-a"), operations: [] });
    expect(registry.validate(request())).toEqual({ ok: false, reason: "unknown-operation" });
  });

  test("accepts multiple operations with working validators", () => {
    const registry = registryWith({
      id: moduleId("mod-a"),
      operations: [op("op-x", 1, (p) => p === 7), op("op-y", 3, (p) => typeof p === "string")],
    });
    expect(registry.validate(request()).ok).toBe(true);
    expect(registry.validate(request({ operation: "op-y", payloadVersion: 3, payload: "s" })).ok).toBe(true);
  });

  test("preserves operation names exactly and treats them case-sensitively", () => {
    const registry = registryWith({ id: moduleId("mod-a"), operations: [op(" Op-X "), op("op-x")] });
    expect(registry.validate(request({ operation: " Op-X " })).ok).toBe(true);
    expect(registry.validate(request({ operation: "op-x" })).ok).toBe(true);
    expect(registry.validate(request({ operation: "Op-X" }))).toEqual({ ok: false, reason: "unknown-operation" });
  });

  test("accepts Number.MAX_SAFE_INTEGER as a version", () => {
    const registry = registryWith({ id: moduleId("mod-a"), operations: [op("op-x", Number.MAX_SAFE_INTEGER)] });
    expect(registry.validate(request({ payloadVersion: Number.MAX_SAFE_INTEGER })).ok).toBe(true);
  });

  test("rejects invalid module IDs", () => {
    const registry = createModuleRegistry();
    for (const id of ["", "  ", "\t\n", undefined, null, 1, {}, []]) {
      expect(() => registry.register({ id, operations: [] } as unknown as ModuleDefinition)).toThrow(Error);
    }
  });

  test("rejects non-object definitions and non-array operations", () => {
    const registry = createModuleRegistry();
    for (const definition of [undefined, null, "mod-a", [], 1]) {
      expect(() => registry.register(definition as unknown as ModuleDefinition)).toThrow(Error);
    }
    for (const operations of [undefined, null, {}, "op-x", op("op-x")]) {
      expect(() =>
        registry.register({ id: moduleId("mod-a"), operations } as unknown as ModuleDefinition),
      ).toThrow(Error);
    }
  });

  test("rejects non-object operation descriptors", () => {
    const registry = createModuleRegistry();
    for (const descriptor of [undefined, null, "op-x", [], 1]) {
      expect(() =>
        registry.register({ id: moduleId("mod-a"), operations: [descriptor] } as unknown as ModuleDefinition),
      ).toThrow(Error);
    }
  });

  test("rejects blank, non-string, or unstorable operation names", () => {
    const registry = createModuleRegistry();
    for (const name of ["", " ", "\t\n", "op\u0000", "op\ud800", undefined, null, 1, {}]) {
      expect(() => registry.register({ id: moduleId("mod-a"), operations: [op(name as string)] })).toThrow(
        /name must be/,
      );
    }
  });

  test("rejects versions that are not positive safe integers", () => {
    const registry = createModuleRegistry();
    const invalid = [0, -0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "1", 1n, null];
    for (const version of invalid) {
      expect(() => registry.register({ id: moduleId("mod-a"), operations: [op("op-x", version as number)] })).toThrow(
        /version must be/,
      );
    }
  });

  test("rejects validators that are not functions", () => {
    const registry = createModuleRegistry();
    for (const validatePayload of [undefined, null, true, "fn", {}]) {
      expect(() =>
        registry.register({
          id: moduleId("mod-a"),
          operations: [{ name: "op-x", version: 1, validatePayload } as unknown as OperationDefinition],
        }),
      ).toThrow(/validatePayload must be a function/);
    }
  });

  test("rejects duplicate operation names within a module, regardless of version", () => {
    const registry = createModuleRegistry();
    expect(() => registry.register({ id: moduleId("mod-a"), operations: [op("op-x", 1), op("op-x", 2)] })).toThrow(
      /duplicate operation name "op-x"/,
    );
  });

  test("rejects re-registration of a module ID without changing the existing definition", () => {
    const registry = registryWith({ id: moduleId("mod-a"), operations: [op("op-x", 1)] });
    const identical = { id: moduleId("mod-a"), operations: [op("op-x", 1)] };
    const different = { id: moduleId("mod-a"), operations: [op("op-x", 2), op("op-y", 1)] };

    expect(() => registry.register(identical)).toThrow(/already registered/);
    expect(() => registry.register(different)).toThrow(/already registered/);

    expect(registry.validate(request()).ok).toBe(true);
    expect(registry.validate(request({ payloadVersion: 2 }))).toEqual({ ok: false, reason: "unsupported-version" });
    expect(registry.validate(request({ operation: "op-y" }))).toEqual({ ok: false, reason: "unknown-operation" });
  });

  test("is atomic: a definition with one invalid operation registers nothing", () => {
    const registry = createModuleRegistry();
    expect(() => registry.register({ id: moduleId("mod-a"), operations: [op("op-x"), op("op-y", 0)] })).toThrow(Error);
    expect(registry.validate(request())).toEqual({ ok: false, reason: "unknown-module" });

    // The module ID remains available for a corrected definition.
    registry.register({ id: moduleId("mod-a"), operations: [op("op-x"), op("op-y", 1)] });
    expect(registry.validate(request()).ok).toBe(true);
  });

  test("is unaffected by later mutation of caller-owned definitions", () => {
    const first: { name: string; version: number; validatePayload: (p: unknown) => boolean } = op("op-x", 1);
    const operations: OperationDefinition[] = [first];
    const definition: { id: ModuleDefinition["id"]; operations: OperationDefinition[] } = {
      id: moduleId("mod-a"),
      operations,
    };
    const registry = registryWith(definition);

    operations.push(op("op-y"));
    operations.length = 0;
    first.name = "op-renamed";
    first.version = 2;
    definition.id = moduleId("mod-b");
    definition.operations = [op("op-z")];

    expect(registry.validate(request()).ok).toBe(true);
    expect(registry.validate(request({ payloadVersion: 2 }))).toEqual({ ok: false, reason: "unsupported-version" });
    expect(registry.validate(request({ operation: "op-y" }))).toEqual({ ok: false, reason: "unknown-operation" });
    expect(registry.validate(request({ operation: "op-renamed" }))).toEqual({ ok: false, reason: "unknown-operation" });
    expect(registry.validate(request({ moduleId: "mod-b", operation: "op-z" }))).toEqual({
      ok: false,
      reason: "unknown-module",
    });
  });
});

describe("validate", () => {
  test("returns a fresh request envelope with the original payload on success", () => {
    const payload = { nested: [1, 2] };
    const registry = registryWith({ id: moduleId("mod-a"), operations: [op("op-x")] });
    const input = request({ payload, extra: "ignored" } as Record<string, unknown>);

    const result = registry.validate(input);

    expect(result).toEqual({ ok: true, request: { moduleId: moduleId("mod-a"), operation: "op-x", payloadVersion: 1, payload } });
    if (!result.ok) throw new Error("expected success");
    expect(result.request).not.toBe(input);
    expect(Object.keys(result.request).sort()).toEqual(["moduleId", "operation", "payload", "payloadVersion"]);
    expect(result.request.payload).toBe(payload);
    expect(Object.isFrozen(payload)).toBe(false);
  });

  test("accepts any payload value, including undefined, when the validator does", () => {
    const registry = registryWith({ id: moduleId("mod-a"), operations: [op("op-x")] });
    for (const payload of [undefined, null, 0, "", false, Symbol("s"), 1n, [], {}]) {
      const result = registry.validate(request({ payload }));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.request.payload).toBe(payload);
    }
  });

  test("returns malformed-request for non-object input", () => {
    const registry = registryWith({ id: moduleId("mod-a"), operations: [op("op-x")] });
    for (const input of [undefined, null, "mod-a", 1, true, [], [request()], () => request()]) {
      expect(registry.validate(input)).toEqual({ ok: false, reason: "malformed-request" });
    }
  });

  test("returns malformed-request when a field is missing or inherited", () => {
    const registry = registryWith({ id: moduleId("mod-a"), operations: [op("op-x")] });
    for (const field of ["moduleId", "operation", "payloadVersion", "payload"]) {
      const missing = request();
      delete missing[field];
      expect(registry.validate(missing)).toEqual({ ok: false, reason: "malformed-request" });

      const inherited = Object.create(request());
      for (const own of Object.keys(request())) if (own !== field) inherited[own] = request()[own];
      expect(registry.validate(inherited)).toEqual({ ok: false, reason: "malformed-request" });
    }
  });

  test("returns malformed-request for invalid field values", () => {
    const registry = registryWith({ id: moduleId("mod-a"), operations: [op("op-x")] });
    const invalid: Partial<Record<keyof OperationRequest, unknown>>[] = [
      ...["", "  ", undefined, null, 1, {}, new String("mod-a")].map((moduleId) => ({ moduleId })),
      ...["", " \t", "op-x\u0000", "\udc00", undefined, null, 1, {}].map((operation) => ({ operation })),
      ...[0, -0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "1", null, 1n].map(
        (payloadVersion) => ({ payloadVersion }),
      ),
    ];
    for (const overrides of invalid) {
      expect(registry.validate(request(overrides))).toEqual({ ok: false, reason: "malformed-request" });
    }
  });

  test("returns unknown-module and unknown-operation for unregistered targets", () => {
    const registry = registryWith({ id: moduleId("mod-a"), operations: [op("op-x")] });
    expect(registry.validate(request({ moduleId: "mod-b" }))).toEqual({ ok: false, reason: "unknown-module" });
    expect(registry.validate(request({ moduleId: "MOD-A" }))).toEqual({ ok: false, reason: "unknown-module" });
    expect(registry.validate(request({ operation: "op-y" }))).toEqual({ ok: false, reason: "unknown-operation" });
    expect(registry.validate(request({ operation: "toString" }))).toEqual({ ok: false, reason: "unknown-operation" });
    expect(registry.validate(request({ operation: "__proto__" }))).toEqual({ ok: false, reason: "unknown-operation" });
  });

  test("identical operation names in different modules do not collide", () => {
    const validateA = mock((p: unknown) => p === "a");
    const validateB = mock((p: unknown) => p === "b");
    const registry = registryWith(
      { id: moduleId("mod-a"), operations: [op("op-x", 1, validateA)] },
      { id: moduleId("mod-b"), operations: [op("op-x", 2, validateB)] },
    );

    expect(registry.validate(request({ payload: "a" })).ok).toBe(true);
    expect(registry.validate(request({ moduleId: "mod-b", payloadVersion: 2, payload: "b" })).ok).toBe(true);
    expect(registry.validate(request({ moduleId: "mod-b", payloadVersion: 1, payload: "b" }))).toEqual({
      ok: false,
      reason: "unsupported-version",
    });
    expect(registry.validate(request({ payload: "b" }))).toEqual({ ok: false, reason: "invalid-payload" });
    expect(validateA).toHaveBeenCalledTimes(2);
    expect(validateB).toHaveBeenCalledTimes(1);
  });

  test("same operation name and version may be registered by different modules", () => {
    const registry = registryWith(
      { id: moduleId("mod-a"), operations: [op("op-x", 1)] },
      { id: moduleId("mod-b"), operations: [op("op-x", 1)] },
    );
    expect(registry.validate(request()).ok).toBe(true);
    expect(registry.validate(request({ moduleId: "mod-b" })).ok).toBe(true);
  });

  test("returns unsupported-version without calling the validator", () => {
    const validatePayload = mock(() => true);
    const registry = registryWith({ id: moduleId("mod-a"), operations: [op("op-x", 2, validatePayload)] });
    for (const payloadVersion of [1, 3, Number.MAX_SAFE_INTEGER]) {
      expect(registry.validate(request({ payloadVersion }))).toEqual({ ok: false, reason: "unsupported-version" });
    }
    expect(validatePayload).not.toHaveBeenCalled();
  });

  test("does not call the validator for malformed requests or unknown targets", () => {
    const validatePayload = mock(() => true);
    const registry = registryWith({ id: moduleId("mod-a"), operations: [op("op-x", 1, validatePayload)] });
    registry.validate(request({ payloadVersion: 0 }));
    registry.validate(request({ moduleId: "mod-b" }));
    registry.validate(request({ operation: "op-y" }));
    expect(validatePayload).not.toHaveBeenCalled();
  });

  test("calls the validator exactly once with the original payload", () => {
    const payload = { value: 1 };
    const validatePayload = mock((_p: unknown) => true);
    const registry = registryWith({ id: moduleId("mod-a"), operations: [op("op-x", 1, validatePayload)] });

    expect(registry.validate(request({ payload })).ok).toBe(true);
    expect(validatePayload).toHaveBeenCalledTimes(1);
    expect(validatePayload.mock.calls[0]?.[0]).toBe(payload);
  });

  test("returns invalid-payload when the validator returns false", () => {
    const validatePayload = mock(() => false);
    const registry = registryWith({ id: moduleId("mod-a"), operations: [op("op-x", 1, validatePayload)] });
    expect(registry.validate(request())).toEqual({ ok: false, reason: "invalid-payload" });
    expect(validatePayload).toHaveBeenCalledTimes(1);
  });

  test("propagates errors thrown by the validator", () => {
    const failure = new Error("validator failure");
    const registry = registryWith({
      id: moduleId("mod-a"),
      operations: [
        op("op-x", 1, () => {
          throw failure;
        }),
      ],
    });
    expect(() => registry.validate(request())).toThrow(failure);
  });

  test("throws TypeError when the validator returns a nonboolean", () => {
    for (const returned of [undefined, null, 0, 1, "true", {}, Promise.resolve(true)]) {
      const validatePayload = mock(() => returned);
      const registry = registryWith({
        id: moduleId("mod-a"),
        operations: [op("op-x", 1, validatePayload as unknown as OperationDefinition["validatePayload"])],
      });
      expect(() => registry.validate(request())).toThrow(TypeError);
      expect(validatePayload).toHaveBeenCalledTimes(1);
    }
  });
});
