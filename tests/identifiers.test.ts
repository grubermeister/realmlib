import { describe, expect, test } from "bun:test";
import { entityId, moduleId, workItemId } from "../src/index.ts";
import type { EntityId, ModuleId, WorkItemId } from "../src/index.ts";

const factories = [
  ["entityId", entityId],
  ["moduleId", moduleId],
  ["workItemId", workItemId],
] as const;

describe.each(factories)("%s", (_name, factory) => {
  test("returns valid strings unchanged", () => {
    for (const value of ["a", "abc-123", " padded ", "x\ty", "ünïcödé", "0"]) {
      const id = factory(value);
      expect(typeof id).toBe("string");
      expect<string>(id).toBe(value);
    }
  });

  test("preserves case", () => {
    expect<string>(factory("MixedCase")).toBe("MixedCase");
    expect(factory("ABC")).not.toBe(factory("abc"));
  });

  test("matching strings compare equally", () => {
    expect(factory("same") === factory("same")).toBe(true);
  });

  test("rejects empty and whitespace-only strings with RangeError", () => {
    for (const value of ["", " ", "   ", "\t", "\n", "\r\n", " \t\n "]) {
      expect(() => factory(value)).toThrow(RangeError);
    }
  });

  test("rejects U+0000 and unpaired surrogates with RangeError, but accepts surrogate pairs", () => {
    for (const value of ["\u0000", "a\u0000b", "\ud800", "a\udc00", "\ude00\ud83d"]) {
      expect(() => factory(value)).toThrow(RangeError);
    }
    expect<string>(factory("a\ud83d\ude00b")).toBe("a\ud83d\ude00b");
  });

  test("rejects non-string runtime values with TypeError", () => {
    const invalid: unknown[] = [undefined, null, 0, 1n, true, Symbol("s"), {}, [], new String("s")];
    for (const value of invalid) {
      expect(() => factory(value as string)).toThrow(TypeError);
    }
  });
});

test("identical text is permitted in different namespaces", () => {
  expect<string>(entityId("shared")).toBe("shared");
  expect<string>(moduleId("shared")).toBe("shared");
  expect<string>(workItemId("shared")).toBe("shared");
});

test("identifier types are distinct from string and from each other", () => {
  const e = entityId("e");
  const m = moduleId("m");
  const w = workItemId("w");

  // Branded IDs remain usable as strings.
  const asString: string = e;
  expect(asString).toBe("e");

  // @ts-expect-error a plain string is not an EntityId
  const rawEntity: EntityId = "e";
  // @ts-expect-error a plain string is not a ModuleId
  const rawModule: ModuleId = "m";
  // @ts-expect-error a plain string is not a WorkItemId
  const rawWorkItem: WorkItemId = "w";

  // @ts-expect-error ModuleId is not an EntityId
  const entityFromModule: EntityId = m;
  // @ts-expect-error WorkItemId is not an EntityId
  const entityFromWorkItem: EntityId = w;
  // @ts-expect-error EntityId is not a ModuleId
  const moduleFromEntity: ModuleId = e;
  // @ts-expect-error WorkItemId is not a ModuleId
  const moduleFromWorkItem: ModuleId = w;
  // @ts-expect-error EntityId is not a WorkItemId
  const workItemFromEntity: WorkItemId = e;
  // @ts-expect-error ModuleId is not a WorkItemId
  const workItemFromModule: WorkItemId = m;

  // An explicit unsafe assertion is the only bypass.
  const asserted = "e" as EntityId;

  expect([
    rawEntity,
    rawModule,
    rawWorkItem,
    entityFromModule,
    entityFromWorkItem,
    moduleFromEntity,
    moduleFromWorkItem,
    workItemFromEntity,
    workItemFromModule,
    asserted,
  ]).toHaveLength(10);
});
