import { describe, expect, test } from "bun:test";
import { createInMemoryStateStore, moduleId } from "../src/index.ts";
import type { InMemoryStateStore, ModuleId, ModuleStateAccess, StateValue } from "../src/index.ts";

const a = moduleId("module-a");
const b = moduleId("module-b");

describe("stores", () => {
  test("a new store is empty", () => {
    const store = createInMemoryStateStore();
    expect(store.forModule(a).get(a, "k")).toBeUndefined();
    expect(store.forModule(a).delete("k")).toBe(false);
  });

  test("separate stores do not share data", () => {
    const first = createInMemoryStateStore();
    const second = createInMemoryStateStore();
    first.forModule(a).set("k", 1);
    expect(second.forModule(a).get(a, "k")).toBeUndefined();
    second.forModule(a).set("k", 2);
    expect(first.forModule(a).get(a, "k")).toBe(1);
  });

  test("exposes only forModule, and access objects only get/set/delete", () => {
    const store = createInMemoryStateStore();
    expect(Object.keys(store)).toEqual(["forModule"]);
    expect(Object.keys(store.forModule(a)).sort()).toEqual(["delete", "get", "set"]);
  });

  test("forModule does not create records", () => {
    const store = createInMemoryStateStore();
    store.forModule(a);
    expect(store.forModule(b).get(a, "k")).toBeUndefined();
  });
});

describe("identifiers and keys", () => {
  const store = createInMemoryStateStore();
  const access = store.forModule(a);

  test("accepts any nonblank key unchanged and is case-sensitive", () => {
    for (const key of ["k", " padded ", "x\ty", "ünïcödé", "0", "__proto__", "constructor"]) {
      access.set(key, key);
      expect(access.get(a, key)).toBe(key);
    }
    access.set("Key", 1);
    access.set("key", 2);
    expect(access.get(a, "Key")).toBe(1);
    expect(access.get(a, "key")).toBe(2);
    expect(access.get(a, "KEY")).toBeUndefined();
  });

  test("rejects blank keys with RangeError", () => {
    for (const key of ["", " ", "\t", "\r\n"]) {
      expect(() => access.set(key, 1)).toThrow(RangeError);
      expect(() => access.get(a, key)).toThrow(RangeError);
      expect(() => access.delete(key)).toThrow(RangeError);
    }
  });

  test("rejects keys containing U+0000 or unpaired surrogates with RangeError", () => {
    for (const key of ["\u0000", "k\u0000", "\ud800", "k\udfff"]) {
      expect(() => access.set(key, 1)).toThrow(RangeError);
      expect(() => access.get(a, key)).toThrow(RangeError);
      expect(() => access.delete(key)).toThrow(RangeError);
    }
    access.set("k\ud83d\ude00", 1);
    expect(access.get(a, "k\ud83d\ude00")).toBe(1);
  });

  test("rejects non-string keys with TypeError", () => {
    for (const key of [undefined, null, 0, 1n, true, Symbol("s"), {}, [], new String("k")]) {
      expect(() => access.set(key as string, 1)).toThrow(TypeError);
      expect(() => access.get(a, key as string)).toThrow(TypeError);
      expect(() => access.delete(key as string)).toThrow(TypeError);
    }
  });

  test("rejects invalid runtime module IDs", () => {
    for (const id of ["", "  "]) {
      expect(() => store.forModule(id as ModuleId)).toThrow(RangeError);
      expect(() => access.get(id as ModuleId, "k")).toThrow(RangeError);
    }
    for (const id of [undefined, null, 1, {}, new String("m")]) {
      expect(() => store.forModule(id as ModuleId)).toThrow(TypeError);
      expect(() => access.get(id as ModuleId, "k")).toThrow(TypeError);
    }
  });

  test("module IDs need not be registered and are case-sensitive", () => {
    const upper = moduleId("MODULE-A");
    store.forModule(upper).set("shared", "upper");
    store.forModule(a).set("shared", "lower");
    expect(access.get(upper, "shared")).toBe("upper");
    expect(access.get(a, "shared")).toBe("lower");
  });
});

describe("namespaces", () => {
  test("two modules can use the same key without collision", () => {
    const store = createInMemoryStateStore();
    store.forModule(a).set("k", "from a");
    store.forModule(b).set("k", "from b");
    expect(store.forModule(a).get(a, "k")).toBe("from a");
    expect(store.forModule(a).get(b, "k")).toBe("from b");
  });

  test("access objects for one module share its records", () => {
    const store = createInMemoryStateStore();
    const first = store.forModule(a);
    const second = store.forModule(moduleId("module-a"));
    first.set("k", 1);
    expect(second.get(a, "k")).toBe(1);
    second.set("k", 2);
    expect(first.get(a, "k")).toBe(2);
    expect(first.delete("k")).toBe(true);
    expect(second.get(a, "k")).toBeUndefined();
  });
});

describe("reading", () => {
  test("get reads records from any module", () => {
    const store = createInMemoryStateStore();
    store.forModule(b).set("k", 7);
    expect(store.forModule(a).get(b, "k")).toBe(7);
    expect(store.forModule(a).get(a, "k")).toBeUndefined();
  });

  test("missing records give undefined while stored null stays null", () => {
    const store = createInMemoryStateStore();
    const access = store.forModule(a);
    access.set("empty", null);
    expect(access.get(a, "empty")).toBeNull();
    expect(access.get(a, "missing")).toBeUndefined();
  });
});

describe("writing", () => {
  test("set replaces only the bound owner's record", () => {
    const store = createInMemoryStateStore();
    store.forModule(b).set("k", "b");
    const access = store.forModule(a);
    access.set("k", 1);
    access.set("k", { replaced: true });
    expect(access.get(a, "k")).toEqual({ replaced: true });
    expect(access.get(b, "k")).toBe("b");
  });

  test("set cannot target another owner", () => {
    const store = createInMemoryStateStore();
    const access = store.forModule(a);
    // @ts-expect-error set takes no owner parameter
    expect(() => access.set(b, "k", 1)).not.toThrow();
    // At runtime the extra argument is the value position: the record is stored under key "module-b" for owner a.
    expect(access.get(b, "k")).toBeUndefined();
    expect(access.get(a, "module-b")).toBe("k");
  });

  test("changes take effect immediately", () => {
    const store = createInMemoryStateStore();
    const writer = store.forModule(a);
    const reader = store.forModule(b);
    writer.set("k", 1);
    expect(reader.get(a, "k")).toBe(1);
    writer.delete("k");
    expect(reader.get(a, "k")).toBeUndefined();
  });
});

describe("deletion", () => {
  test("delete removes only the bound owner's key and reports presence", () => {
    const store = createInMemoryStateStore();
    const accessA = store.forModule(a);
    const accessB = store.forModule(b);
    accessA.set("k", 1);
    accessA.set("other", 2);
    accessB.set("k", 3);

    expect(accessA.delete("k")).toBe(true);
    expect(accessA.get(a, "k")).toBeUndefined();
    expect(accessA.get(a, "other")).toBe(2);
    expect(accessA.get(b, "k")).toBe(3);
    expect(accessA.delete("k")).toBe(false);
  });

  test("a deleted null record is reported as present", () => {
    const store = createInMemoryStateStore();
    const access = store.forModule(a);
    access.set("k", null);
    expect(access.delete("k")).toBe(true);
    expect(access.delete("k")).toBe(false);
  });

  test("a record can be re-created after deletion", () => {
    const store = createInMemoryStateStore();
    const access = store.forModule(a);
    access.set("k", 1);
    access.delete("k");
    access.set("k", 2);
    expect(access.get(a, "k")).toBe(2);
  });
});

describe("JSON values", () => {
  function roundTrip(value: StateValue): StateValue | undefined {
    const access = createInMemoryStateStore().forModule(a);
    access.set("k", value);
    return access.get(a, "k");
  }

  test("primitive values round-trip exactly", () => {
    for (const value of [null, true, false, 0, -1, 0.1, -2.5e-300, Number.MAX_VALUE, "", "text", "ünïcödé"]) {
      expect(roundTrip(value)).toBe(value);
    }
  });

  test("nested arrays and objects round-trip exactly", () => {
    const value: StateValue = {
      n: 1.5,
      s: "x",
      b: false,
      z: null,
      list: [1, "two", null, [true, { deep: [] }]],
      nested: { empty: {}, items: [{ id: 1 }, { id: 2 }] },
    };
    const result = roundTrip(value);
    expect(result).toEqual(value);
    expect(JSON.stringify(result)).toBe(JSON.stringify(value));
  });

  test("objects keep their own key order and special key names", () => {
    const value = JSON.parse('{"b":1,"a":2,"__proto__":3,"constructor":4}') as StateValue;
    const result = roundTrip(value) as { [key: string]: StateValue };
    expect(Object.keys(result)).toEqual(["b", "a", "__proto__", "constructor"]);
    expect(result["__proto__"]).toBe(3);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });

  test("null-prototype objects are accepted", () => {
    const value = Object.assign(Object.create(null) as { [key: string]: StateValue }, { k: 1 });
    expect(roundTrip(value)).toEqual({ k: 1 });
  });

  test("shared non-cyclic references are accepted", () => {
    const shared = { v: 1 };
    expect(roundTrip({ x: shared, y: [shared, shared] })).toEqual({ x: { v: 1 }, y: [{ v: 1 }, { v: 1 }] });
  });

  test("rejects unsupported values with TypeError", () => {
    class Point {
      x = 1;
    }
    const cyclic: { [key: string]: unknown } = {};
    cyclic.self = cyclic;
    const cyclicArray: unknown[] = [];
    cyclicArray.push([cyclicArray]);
    const accessor = {};
    Object.defineProperty(accessor, "v", { get: () => 1, enumerable: true });
    const hidden = {};
    Object.defineProperty(hidden, "v", { value: 1, enumerable: false });
    const withExtra: unknown[] & { extra?: number } = [1];
    withExtra.extra = 2;
    const arrayAccessor: unknown[] = [];
    Object.defineProperty(arrayAccessor, 0, { get: () => 1, enumerable: true });
    class List extends Array {}

    const invalid: unknown[] = [
      undefined,
      NaN,
      Infinity,
      -Infinity,
      -0,
      { nested: [1, -0] },
      1n,
      () => 1,
      Symbol("s"),
      new Point(),
      new Date(0),
      new Map(),
      new Set(),
      /x/,
      new Number(1),
      new String("s"),
      new Uint8Array(1),
      cyclic,
      cyclicArray,
      [1, , 3],
      new Array(2),
      { [Symbol("s")]: 1 },
      accessor,
      hidden,
      withExtra,
      arrayAccessor,
      List.from([1]),
      { nested: { bad: undefined } },
      [1, [2, [NaN]]],
    ];

    for (const value of invalid) {
      expect(() => createInMemoryStateStore().forModule(a).set("k", value as StateValue)).toThrow(TypeError);
    }
  });

  test("an invalid value does not create a record", () => {
    const access = createInMemoryStateStore().forModule(a);
    expect(() => access.set("k", undefined as unknown as StateValue)).toThrow(TypeError);
    expect(access.get(a, "k")).toBeUndefined();
  });
});

describe("copying", () => {
  test("mutating the input after set does not change stored state", () => {
    const access = createInMemoryStateStore().forModule(a);
    const input = { list: [1, { v: 2 }], obj: { v: 3 } };
    access.set("k", input);
    input.list.push(9);
    (input.list[1] as { v: number }).v = 99;
    input.obj.v = 99;
    expect(access.get(a, "k")).toEqual({ list: [1, { v: 2 }], obj: { v: 3 } });
  });

  test("mutating a returned value does not change stored state", () => {
    const access = createInMemoryStateStore().forModule(a);
    access.set("k", { list: [1, { v: 2 }] });
    const first = access.get(a, "k") as { list: (number | { v: number })[] };
    first.list.push(9);
    (first.list[1] as { v: number }).v = 99;
    expect(access.get(a, "k")).toEqual({ list: [1, { v: 2 }] });
  });

  test("each get returns a fresh, unfrozen copy", () => {
    const access = createInMemoryStateStore().forModule(a);
    access.set("k", [{ v: 1 }]);
    const first = access.get(a, "k") as { v: number }[];
    const second = access.get(a, "k") as { v: number }[];
    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
    expect(Object.isFrozen(first)).toBe(false);
  });

  test("frozen input is accepted and stored as a copy", () => {
    const access = createInMemoryStateStore().forModule(a);
    access.set("k", Object.freeze({ list: Object.freeze([1]) }));
    const result = access.get(a, "k") as { list: number[] };
    result.list.push(2);
    expect(access.get(a, "k")).toEqual({ list: [1] });
  });
});

describe("failed writes", () => {
  test("an invalid replacement leaves the previous value unchanged", () => {
    const access = createInMemoryStateStore().forModule(a);
    access.set("k", { v: [1, 2] });
    // The invalid part sits after valid data so a partial write would be visible.
    expect(() => access.set("k", { v: [3], bad: () => 1 } as unknown as StateValue)).toThrow(TypeError);
    expect(() => access.set("k", [1, 2, NaN])).toThrow(TypeError);
    expect(access.get(a, "k")).toEqual({ v: [1, 2] });
  });

  test("an invalid key leaves state unchanged", () => {
    const access = createInMemoryStateStore().forModule(a);
    access.set("k", 1);
    expect(() => access.set(" ", 2)).toThrow(RangeError);
    expect(() => access.delete(" ")).toThrow(RangeError);
    expect(access.get(a, "k")).toBe(1);
  });
});

test("types accept state values and reject non-state values", () => {
  const store: InMemoryStateStore = createInMemoryStateStore();
  const access: ModuleStateAccess = store.forModule(a);

  const ok: StateValue[] = [null, true, 1, "s", [1, [null]], { a: { b: ["c"] } }];
  for (const value of ok) access.set("k", value);
  const result: StateValue | undefined = access.get(a, "k");
  expect(result).toEqual({ a: { b: ["c"] } });

  expect(() => {
    // @ts-expect-error functions are not state values
    access.set("k", () => 1);
    // @ts-expect-error undefined is not a state value
    access.set("k", undefined);
    // @ts-expect-error nested undefined is not a state value
    access.set("k", { v: undefined });
    // @ts-expect-error bigint is not a state value
    access.set("k", 1n);
    // @ts-expect-error symbols are not state values
    access.set("k", Symbol("s"));
    // @ts-expect-error Date is not a state value
    access.set("k", new Date());
    // @ts-expect-error Map is not a state value
    access.set("k", new Map());
  }).toThrow(TypeError);

  // @ts-expect-error get requires a ModuleId, not a plain string
  access.get("module-a", "k");
  // @ts-expect-error forModule requires a ModuleId, not a plain string
  store.forModule("module-a");
  // @ts-expect-error delete takes no owner parameter
  access.delete(b, "k");
});
