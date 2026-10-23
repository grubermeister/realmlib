import { describe, expect, mock, test } from "bun:test";
import { createInMemoryStateStore, createModuleRegistry, executeInMemoryOperation, moduleId, simTime } from "../src/index.ts";
import type {
  InMemoryStateStore,
  ModuleStateAccess,
  OperationHandler,
  OperationRequest,
  OperationValidationResult,
  StateValue,
} from "../src/index.ts";

const a = moduleId("module-a");
const b = moduleId("module-b");

/** Accepts finite numbers other than -0. */
function isNumericPayload(payload: unknown): boolean {
  return typeof payload === "number" && Number.isFinite(payload) && !Object.is(payload, -0);
}

function setup() {
  const registry = createModuleRegistry();
  registry.register({
    id: a,
    operations: [
      { name: "op-x", version: 1, validatePayload: isNumericPayload },
      { name: "op-any", version: 2, validatePayload: () => true },
    ],
  });
  registry.register({ id: b, operations: [{ name: "op-x", version: 1, validatePayload: isNumericPayload }] });
  const store = createInMemoryStateStore();
  const direct = store.forModule(a);
  direct.set("k1", 1);
  direct.set("k2", { list: [1, 2] });
  store.forModule(b).set("k1", "b");
  return { registry, store, direct };
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { moduleId: "module-a", operation: "op-x", payloadVersion: 1, payload: 5, ...overrides };
}

/** Snapshot of the records the tests touch, read through a fresh ordinary accessor. */
function snapshot(store: InMemoryStateStore): (StateValue | undefined)[] {
  const access = store.forModule(a);
  return [a, b].flatMap((owner) => ["k1", "k2", "k3"].map((key) => access.get(owner, key)));
}

describe("validation before execution", () => {
  test("validation failures are returned unchanged without invoking the handler", () => {
    const { registry, store } = setup();
    const before = snapshot(store);
    const cases: [unknown, string][] = [
      [null, "malformed-request"],
      ["text", "malformed-request"],
      [{ moduleId: "module-a", operation: "op-x", payloadVersion: 1 }, "malformed-request"],
      [request({ moduleId: " " }), "malformed-request"],
      [request({ payloadVersion: -0 }), "malformed-request"],
      [request({ moduleId: "module-z" }), "unknown-module"],
      [request({ operation: "op-z" }), "unknown-operation"],
      [request({ payloadVersion: 2 }), "unsupported-version"],
      [request({ payload: "5" }), "invalid-payload"],
      [request({ payload: -0 }), "invalid-payload"],
    ];
    for (const [input, reason] of cases) {
      const handler = mock<OperationHandler>((_request, state) => state.set("k1", 99));
      expect(executeInMemoryOperation(registry, store, input, handler)).toEqual({ ok: false, reason } as OperationValidationResult);
      expect(handler).not.toHaveBeenCalled();
      expect(snapshot(store)).toEqual(before);
    }
  });

  test("validation failures match the registry's own result", () => {
    const { registry, store } = setup();
    const input = request({ operation: "op-z" });
    expect(executeInMemoryOperation(registry, store, input, () => {})).toEqual(registry.validate(input));
  });

  test("validates the input exactly once", () => {
    const validatePayload = mock(() => true);
    const registry = createModuleRegistry();
    registry.register({ id: a, operations: [{ name: "op-x", version: 1, validatePayload }] });
    executeInMemoryOperation(registry, createInMemoryStateStore(), request(), () => {});
    expect(validatePayload).toHaveBeenCalledTimes(1);
  });

  test("errors thrown by the payload validator propagate without invoking the handler", () => {
    const registry = createModuleRegistry();
    const error = new Error("validator failed");
    registry.register({
      id: a,
      operations: [
        {
          name: "op-x",
          version: 1,
          validatePayload: () => {
            throw error;
          },
        },
      ],
    });
    const handler = mock(() => {});
    expect(() => executeInMemoryOperation(registry, createInMemoryStateStore(), request(), handler)).toThrow(error);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("successful operations", () => {
  test("invokes the handler once with the validated request and commits its writes", () => {
    const { registry, store, direct } = setup();
    const handler = mock<OperationHandler>((_request, state) => {
      state.set("k1", 2);
      state.set("k3", { nested: ["x"] });
    });
    const result = executeInMemoryOperation(registry, store, request(), handler);

    expect(result).toEqual({
      ok: true,
      request: { moduleId: a, operation: "op-x", payloadVersion: 1, payload: 5 },
    });
    expect(handler).toHaveBeenCalledTimes(1);
    const [received] = handler.mock.calls[0]!;
    expect(result.ok && result.request).toBe(received);
    // Accessors acquired before execution observe the committed result.
    expect(direct.get(a, "k1")).toBe(2);
    expect(direct.get(a, "k3")).toEqual({ nested: ["x"] });
    expect(direct.get(a, "k2")).toEqual({ list: [1, 2] });
  });

  test("passes the accepted payload through unchanged", () => {
    const { registry, store } = setup();
    const payload = { nested: { values: [1] }, fn: () => 1 };
    let seen: unknown;
    executeInMemoryOperation(registry, store, request({ operation: "op-any", payloadVersion: 2, payload }), (req) => {
      seen = req.payload;
    });
    expect(seen).toBe(payload);
    expect(Object.isFrozen(payload)).toBe(false);
  });

  test("the state view is bound to the addressed module", () => {
    const { registry, store } = setup();
    executeInMemoryOperation(registry, store, request({ moduleId: "module-b" }), (_request, state) => {
      state.set("k1", "b2");
    });
    expect(store.forModule(a).get(a, "k1")).toBe(1);
    expect(store.forModule(a).get(b, "k1")).toBe("b2");
  });

  test("the state view is a distinct object exposing only get/set/delete", () => {
    const { registry, store } = setup();
    executeInMemoryOperation(registry, store, request(), (_request, state) => {
      expect(Object.keys(state).sort()).toEqual(["delete", "get", "set"]);
    });
  });

  test("an operation with no changes succeeds and leaves state unchanged", () => {
    const { registry, store } = setup();
    const before = snapshot(store);
    expect(executeInMemoryOperation(registry, store, request(), () => {}).ok).toBe(true);
    expect(snapshot(store)).toEqual(before);
  });

  test("ordinary direct state calls still work outside execution", () => {
    const { registry, store, direct } = setup();
    executeInMemoryOperation(registry, store, request(), (_request, state) => state.set("k1", 2));
    direct.set("k1", 3);
    expect(direct.get(a, "k1")).toBe(3);
    expect(direct.delete("k1")).toBe(true);
    expect(store.forModule(b).get(a, "k1")).toBeUndefined();
  });
});

describe("staged visibility", () => {
  test("ordinary reads see committed values while the handler sees its own writes", () => {
    const { registry, store, direct } = setup();
    executeInMemoryOperation(registry, store, request(), (_request, state) => {
      state.set("k1", 2);
      expect(state.delete("k2")).toBe(true);
      state.set("k3", "new");

      expect(state.get(a, "k1")).toBe(2);
      expect(state.get(a, "k2")).toBeUndefined();
      expect(state.get(a, "k3")).toBe("new");

      expect(direct.get(a, "k1")).toBe(1);
      expect(direct.get(a, "k2")).toEqual({ list: [1, 2] });
      expect(direct.get(a, "k3")).toBeUndefined();
    });
    expect(direct.get(a, "k1")).toBe(2);
    expect(direct.get(a, "k2")).toBeUndefined();
    expect(direct.get(a, "k3")).toBe("new");
  });
});

describe("ownership", () => {
  test("reads can address another module; writes affect only the executing module", () => {
    const { registry, store } = setup();
    executeInMemoryOperation(registry, store, request(), (_request, state) => {
      expect(state.get(b, "k1")).toBe("b");
      state.set("k1", "from a");
      expect(state.get(b, "k1")).toBe("b");
      expect(state.delete("k1")).toBe(true);
      expect(state.get(b, "k1")).toBe("b");
      // @ts-expect-error set takes no owner parameter
      state.set(b, "k1", 1);
    });
    const access = store.forModule(b);
    expect(access.get(b, "k1")).toBe("b");
    // The extra argument lands in the value position, as with direct access.
    expect(access.get(a, "module-b")).toBe("k1");
  });
});

describe("atomic failure", () => {
  test("a throwing handler commits nothing and propagates the original error", () => {
    const { registry, store } = setup();
    const before = snapshot(store);
    const error = new Error("handler failed");
    expect(() =>
      executeInMemoryOperation(registry, store, request(), (_request, state) => {
        state.set("k1", 2);
        state.set("k3", 3);
        state.delete("k2");
        throw error;
      }),
    ).toThrow(error);
    expect(snapshot(store)).toEqual(before);
  });

  test("a non-Error thrown value propagates unchanged", () => {
    const { registry, store } = setup();
    let caught: unknown;
    try {
      executeInMemoryOperation(registry, store, request(), () => {
        throw "plain";
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe("plain");
  });

  test("an invalid staged value after a valid edit commits nothing", () => {
    const invalidValues: unknown[] = [
      undefined,
      NaN,
      () => 1,
      new Date(0),
      { nested: { bad: undefined } },
      [1, [2, [Infinity]]],
      { list: [1, { deep: 1n }] },
    ];
    for (const value of invalidValues) {
      const { registry, store } = setup();
      const before = snapshot(store);
      expect(() =>
        executeInMemoryOperation(registry, store, request(), (_request, state) => {
          state.set("k3", "valid");
          state.set("k1", value as StateValue);
        }),
      ).toThrow(TypeError);
      expect(snapshot(store)).toEqual(before);
    }
  });

  test("an invalid key after a valid edit commits nothing", () => {
    const { registry, store } = setup();
    const before = snapshot(store);
    expect(() =>
      executeInMemoryOperation(registry, store, request(), (_request, state) => {
        state.set("k3", "valid");
        state.set(" ", 1);
      }),
    ).toThrow(RangeError);
    expect(snapshot(store)).toEqual(before);
  });
});

describe("negative zero", () => {
  test("direct and nested staged -0 values are rejected without partial changes", () => {
    for (const value of [-0, [1, -0], { nested: { list: [0, -0] } }]) {
      const { registry, store } = setup();
      const before = snapshot(store);
      expect(() =>
        executeInMemoryOperation(registry, store, request(), (_request, state) => {
          state.set("k1", 0);
          state.set("k3", value as StateValue);
        }),
      ).toThrow(TypeError);
      expect(snapshot(store)).toEqual(before);
    }
  });

  test("positive zero and the string \"-0\" are valid staged values", () => {
    const { registry, store, direct } = setup();
    executeInMemoryOperation(registry, store, request(), (_request, state) => {
      state.set("k1", 0);
      state.set("k3", "-0");
    });
    expect(Object.is(direct.get(a, "k1"), 0)).toBe(true);
    expect(direct.get(a, "k3")).toBe("-0");
  });

  test("simTime and operation versions still reject -0", () => {
    expect(() => simTime(-0)).toThrow(RangeError);
    const registry = createModuleRegistry();
    expect(() =>
      registry.register({ id: a, operations: [{ name: "op-x", version: -0, validatePayload: () => true }] }),
    ).toThrow(RangeError);
  });
});

describe("copying", () => {
  test("mutating a value after staging it does not affect committed state", () => {
    const { registry, store, direct } = setup();
    const input = { list: [1, { v: 2 }] };
    executeInMemoryOperation(registry, store, request(), (_request, state) => {
      state.set("k3", input);
      input.list.push(9);
      (input.list[1] as { v: number }).v = 99;
      expect(state.get(a, "k3")).toEqual({ list: [1, { v: 2 }] });
    });
    input.list.push(10);
    expect(direct.get(a, "k3")).toEqual({ list: [1, { v: 2 }] });
  });

  test("mutating values returned by staged reads does not affect staged or committed state", () => {
    const { registry, store, direct } = setup();
    executeInMemoryOperation(registry, store, request(), (_request, state) => {
      (state.get(a, "k2") as { list: number[] }).list.push(9);
      state.set("k3", { list: [1] });
      const staged = state.get(a, "k3") as { list: number[] };
      staged.list.push(9);
      expect(state.get(a, "k3")).not.toBe(staged);
      expect(state.get(a, "k3")).toEqual({ list: [1] });
      expect(state.get(a, "k2")).toEqual({ list: [1, 2] });
    });
    expect(direct.get(a, "k2")).toEqual({ list: [1, 2] });
    expect(direct.get(a, "k3")).toEqual({ list: [1] });
  });
});

describe("deletions", () => {
  test("staged deletes report presence in the staged view", () => {
    const { registry, store, direct } = setup();
    executeInMemoryOperation(registry, store, request(), (_request, state) => {
      expect(state.delete("k1")).toBe(true);
      expect(state.delete("k1")).toBe(false);
      expect(state.delete("missing")).toBe(false);
      state.set("k3", null);
      expect(state.delete("k3")).toBe(true);
      expect(state.delete("k3")).toBe(false);
    });
    expect(direct.get(a, "k1")).toBeUndefined();
    expect(direct.get(a, "k3")).toBeUndefined();
  });

  test("deleting then setting a key commits its final value", () => {
    const { registry, store, direct } = setup();
    executeInMemoryOperation(registry, store, request(), (_request, state) => {
      expect(state.delete("k1")).toBe(true);
      expect(state.get(a, "k1")).toBeUndefined();
      state.set("k1", "again");
      expect(state.get(a, "k1")).toBe("again");
    });
    expect(direct.get(a, "k1")).toBe("again");
  });

  test("deleting every record of a module commits an empty namespace", () => {
    const { registry, store, direct } = setup();
    executeInMemoryOperation(registry, store, request(), (_request, state) => {
      state.delete("k1");
      state.delete("k2");
    });
    expect(direct.get(a, "k1")).toBeUndefined();
    expect(direct.get(a, "k2")).toBeUndefined();
    direct.set("k1", 1);
    expect(direct.get(a, "k1")).toBe(1);
  });

  test("a failed operation restores a deleted key", () => {
    const { registry, store, direct } = setup();
    expect(() =>
      executeInMemoryOperation(registry, store, request(), (_request, state) => {
        state.delete("k1");
        throw new Error("fail");
      }),
    ).toThrow("fail");
    expect(direct.get(a, "k1")).toBe(1);
  });
});

describe("handler errors", () => {
  test("a non-function handler is rejected with TypeError before validation", () => {
    const validatePayload = mock(() => true);
    const registry = createModuleRegistry();
    registry.register({ id: a, operations: [{ name: "op-x", version: 1, validatePayload }] });
    const store = createInMemoryStateStore();
    for (const handler of [undefined, null, 1, "fn", {}]) {
      expect(() => executeInMemoryOperation(registry, store, request(), handler as unknown as OperationHandler)).toThrow(
        TypeError,
      );
    }
    expect(validatePayload).not.toHaveBeenCalled();
  });

  test("a store not created by createInMemoryStateStore is rejected with TypeError", () => {
    const { registry, store } = setup();
    const imitation: InMemoryStateStore = { forModule: (owner) => store.forModule(owner) };
    const handler = mock(() => {});
    expect(() => executeInMemoryOperation(registry, imitation, request(), handler)).toThrow(TypeError);
    expect(handler).not.toHaveBeenCalled();
  });

  test("a Promise-returning handler fails with TypeError and commits nothing", () => {
    const { registry, store } = setup();
    const before = snapshot(store);
    const handler = (async (_request: OperationRequest, state: ModuleStateAccess) => {
      state.set("k1", 2);
    }) as unknown as OperationHandler;
    expect(() => executeInMemoryOperation(registry, store, request(), handler)).toThrow(TypeError);
    expect(snapshot(store)).toEqual(before);
  });

  test("a thenable-returning handler fails with TypeError without being awaited", () => {
    const { registry, store } = setup();
    const before = snapshot(store);
    const then = mock(() => {});
    const handler = ((_request: OperationRequest, state: ModuleStateAccess) => {
      state.set("k1", 2);
      return { then };
    }) as unknown as OperationHandler;
    expect(() => executeInMemoryOperation(registry, store, request(), handler)).toThrow(TypeError);
    expect(then).not.toHaveBeenCalled();
    expect(snapshot(store)).toEqual(before);
  });

  test("non-thenable return values are ignored", () => {
    const { registry, store, direct } = setup();
    const handler = ((_request: OperationRequest, state: ModuleStateAccess) => {
      state.set("k1", 2);
      return { then: "not a function" };
    }) as unknown as OperationHandler;
    expect(executeInMemoryOperation(registry, store, request(), handler).ok).toBe(true);
    expect(direct.get(a, "k1")).toBe(2);
  });
});

describe("access lifetime", () => {
  function expectInvalid(state: ModuleStateAccess) {
    expect(() => state.get(a, "k1")).toThrow();
    expect(() => state.set("k1", 42)).toThrow();
    expect(() => state.delete("k1")).toThrow();
  }

  test("a retained access throws after a successful operation", () => {
    const { registry, store } = setup();
    let retained: ModuleStateAccess | undefined;
    executeInMemoryOperation(registry, store, request(), (_request, state) => {
      retained = state;
      state.set("k1", 2);
    });
    const before = snapshot(store);
    expectInvalid(retained!);
    expect(snapshot(store)).toEqual(before);
    expect(store.forModule(a).get(a, "k1")).toBe(2);
  });

  test("a retained access throws after a failed operation", () => {
    const { registry, store } = setup();
    const before = snapshot(store);
    let retained: ModuleStateAccess | undefined;
    expect(() =>
      executeInMemoryOperation(registry, store, request(), (_request, state) => {
        retained = state;
        state.set("k1", 2);
        throw new Error("fail");
      }),
    ).toThrow("fail");
    expectInvalid(retained!);
    expect(snapshot(store)).toEqual(before);
  });

  test("a retained access stays invalid after a later operation starts", () => {
    const { registry, store, direct } = setup();
    let retained: ModuleStateAccess | undefined;
    executeInMemoryOperation(registry, store, request(), (_request, state) => {
      retained = state;
    });
    executeInMemoryOperation(registry, store, request(), (_request, state) => {
      expect(() => retained!.set("k1", 42)).toThrow();
      state.set("k3", "later");
    });
    expect(direct.get(a, "k1")).toBe(1);
    expect(direct.get(a, "k3")).toBe("later");
  });
});

describe("reentrancy", () => {
  test("nested execution against the same store fails and the outer operation can still commit fully", () => {
    const { registry, store, direct } = setup();
    const inner = mock<OperationHandler>((_request, state) => state.set("k3", "inner"));
    executeInMemoryOperation(registry, store, request(), (_request, state) => {
      state.set("k1", "outer-1");
      expect(() => executeInMemoryOperation(registry, store, request(), inner)).toThrow();
      state.set("k2", "outer-2");
    });
    expect(inner).not.toHaveBeenCalled();
    expect(direct.get(a, "k1")).toBe("outer-1");
    expect(direct.get(a, "k2")).toBe("outer-2");
    expect(direct.get(a, "k3")).toBeUndefined();
  });

  test("a propagated nested failure commits neither operation", () => {
    const { registry, store } = setup();
    const before = snapshot(store);
    expect(() =>
      executeInMemoryOperation(registry, store, request(), (_request, state) => {
        state.set("k1", "outer");
        executeInMemoryOperation(registry, store, request({ moduleId: "module-b" }), (_inner, innerState) => {
          innerState.set("k1", "inner");
        });
      }),
    ).toThrow();
    expect(snapshot(store)).toEqual(before);
  });

  test("execution against a different store may be nested", () => {
    const { registry, store, direct } = setup();
    const other = createInMemoryStateStore();
    executeInMemoryOperation(registry, store, request(), (_request, state) => {
      executeInMemoryOperation(registry, other, request(), (_inner, innerState) => innerState.set("k1", "other"));
      state.set("k1", "outer");
    });
    expect(direct.get(a, "k1")).toBe("outer");
    expect(other.forModule(a).get(a, "k1")).toBe("other");
  });

  test("the store accepts new operations after a failure", () => {
    const { registry, store, direct } = setup();
    expect(() =>
      executeInMemoryOperation(registry, store, request(), () => {
        throw new Error("fail");
      }),
    ).toThrow("fail");
    executeInMemoryOperation(registry, store, request(), (_request, state) => state.set("k1", 2));
    expect(direct.get(a, "k1")).toBe(2);
  });
});

test("the store's public surface is unchanged", () => {
  const store = createInMemoryStateStore();
  expect(Object.keys(store)).toEqual(["forModule"]);
  expect(Object.keys(store.forModule(a)).sort()).toEqual(["delete", "get", "set"]);
});

test("internal staging helpers are not exported from the package root", async () => {
  const exported = Object.keys(await import("../src/index.ts")).sort();
  expect(exported).toEqual([
    "createInMemoryStateStore",
    "createModuleRegistry",
    "entityId",
    "executeInMemoryOperation",
    "moduleId",
    "simTime",
    "workItemId",
  ]);
});
