import { expect, test } from "bun:test";
import { simTime } from "../src/index.ts";
import type { SimTime } from "../src/index.ts";

test("accepts 0, 1, and Number.MAX_SAFE_INTEGER unchanged", () => {
  for (const value of [0, 1, 1_000, Number.MAX_SAFE_INTEGER]) {
    const t = simTime(value);
    expect(typeof t).toBe("number");
    expect<number>(t).toBe(value);
  }
});

test("values remain comparable and JSON-serializable numbers", () => {
  const earlier = simTime(1);
  const later = simTime(2);
  expect(earlier < later).toBe(true);
  expect(earlier === simTime(1)).toBe(true);

  const json = JSON.stringify({ at: simTime(1_500) });
  expect(json).toBe('{"at":1500}');
  expect(JSON.parse(json)).toEqual({ at: 1_500 });
});

test("rejects negative (including -0), fractional, NaN, infinite, and unsafe values with RangeError", () => {
  const invalid = [
    -0,
    -1,
    -Number.MAX_SAFE_INTEGER,
    0.5,
    1.000001,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    Number.MAX_VALUE,
  ];
  for (const value of invalid) {
    expect(() => simTime(value)).toThrow(RangeError);
  }
});

test("rejects non-number runtime values with TypeError", () => {
  const invalid: unknown[] = [undefined, null, "1", 1n, true, Symbol("s"), {}, [], new Number(1)];
  for (const value of invalid) {
    expect(() => simTime(value as number)).toThrow(TypeError);
  }
});

test("SimTime is distinct from number", () => {
  const t = simTime(5);

  // SimTime remains usable as a number.
  const asNumber: number = t;
  expect(asNumber).toBe(5);

  // @ts-expect-error a plain number is not a SimTime
  const raw: SimTime = 5;
  // @ts-expect-error arithmetic yields a plain number, not a SimTime
  const sum: SimTime = t + 1;

  // An explicit unsafe assertion is the only bypass.
  const asserted = 5 as SimTime;

  expect([raw, sum, asserted]).toHaveLength(3);
});
