import { describe, expect, test } from "bun:test";
import { createSeededRandom } from "../src/index.ts";
import type { RandomSnapshot, SeededRandom } from "../src/index.ts";

/** Bypasses static types to exercise runtime validation. */
function loose<T>(value: unknown): T {
  return value as T;
}

function draws(random: SeededRandom, count: number): number[] {
  return Array.from({ length: count }, () => random.nextFloat());
}

/** Raw 32-bit outputs: each float times 2**32 is exactly the generator output. */
function outputs(random: SeededRandom, count: number): number[] {
  return draws(random, count).map((x) => x * 2 ** 32);
}

function snapshotOf(words: unknown, algorithm: unknown = "xoshiro128ss-v1"): RandomSnapshot {
  return loose<RandomSnapshot>({ algorithm, words });
}

describe("fixed sequences", () => {
  // Independently published fixtures for realmlib's v1 seed expansion + xoshiro128** 1.1.
  const fixtures: [number, number[], number[]][] = [
    [0, [2462723854, 1020716019, 454327756, 1275600319], [3809008728, 1133695204, 53579671]],
    [1, [2527132011, 314344336, 2535364964, 2041432039], [2442144158, 3238099751, 3819917871]],
  ];

  for (const [seed, state, first] of fixtures) {
    test(`seed ${seed} expands to the pinned state and outputs`, () => {
      const random = createSeededRandom(seed);
      expect(random.snapshot()).toEqual({ algorithm: "xoshiro128ss-v1", words: loose<RandomSnapshot["words"]>(state) });
      expect(outputs(random, 3)).toEqual(first);
    });

    test(`restoring seed ${seed}'s state does not re-expand it`, () => {
      expect(outputs(createSeededRandom(snapshotOf(state)), 3)).toEqual(first);
    });
  }
});

describe("explicit seeding", () => {
  test("equal seeds produce equal sequences", () => {
    expect(draws(createSeededRandom(12345), 50)).toEqual(draws(createSeededRandom(12345), 50));
  });

  test("instances share no mutable state", () => {
    const first = createSeededRandom(7);
    const second = createSeededRandom(7);
    const expected = draws(createSeededRandom(7), 10);
    draws(first, 5);
    expect(draws(second, 10)).toEqual(expected);
    expect(draws(first, 5)).toEqual(expected.slice(5));
  });

  test("different seeds produce different sequences", () => {
    expect(draws(createSeededRandom(0), 5)).not.toEqual(draws(createSeededRandom(1), 5));
  });

  test("the maximum seed is accepted", () => {
    expect(() => createSeededRandom(4_294_967_295)).not.toThrow();
  });
});

describe("numeric output", () => {
  test("draws are finite, in [0, 1), and never -0", () => {
    for (const seed of [0, 1, 2, 4_294_967_295]) {
      const random = createSeededRandom(seed);
      for (let i = 0; i < 10_000; i++) {
        const x = random.nextFloat();
        expect(Number.isFinite(x)).toBe(true);
        expect(x >= 0 && x < 1).toBe(true);
        expect(Object.is(x, -0)).toBe(false);
      }
    }
  });

  test("a zero output converts to positive zero", () => {
    // s[1] = 0 makes the scrambled output 0.
    const random = createSeededRandom(snapshotOf([1, 0, 0, 0]));
    const x = random.nextFloat();
    expect(Object.is(x, 0)).toBe(true);
  });
});

describe("seed validation", () => {
  test("non-number seeds throw TypeError", () => {
    for (const seed of ["1", 1n, true, undefined, null, () => 1]) {
      expect(() => createSeededRandom(loose(seed))).toThrow(TypeError);
    }
  });

  test("out-of-range numbers throw RangeError", () => {
    for (const seed of [-0, -1, 0.5, 4_294_967_296, NaN, Infinity, -Infinity]) {
      expect(() => createSeededRandom(seed)).toThrow(RangeError);
    }
  });
});

describe("snapshot validation", () => {
  const valid = [1, 2, 3, 4];

  test("wrong types throw TypeError", () => {
    const cases: unknown[] = [
      { words: valid },
      snapshotOf(valid, 1),
      snapshotOf(undefined),
      snapshotOf("1,2,3,4"),
      snapshotOf({ 0: 1, 1: 2, 2: 3, 3: 4, length: 4 }),
      snapshotOf([1, 2, 3, "4"]),
      snapshotOf([1, 2, null, 4]),
      snapshotOf([1n, 2, 3, 4]),
    ];
    for (const snapshot of cases) {
      expect(() => createSeededRandom(loose(snapshot))).toThrow(TypeError);
    }
  });

  test("unknown algorithms, wrong word counts, invalid words, and all-zero state throw RangeError", () => {
    const cases: unknown[] = [
      snapshotOf(valid, "xoshiro128ss-v2"),
      snapshotOf(valid, "xoshiro128ss"),
      snapshotOf(valid, "XOSHIRO128SS-V1"),
      snapshotOf([]),
      snapshotOf([1, 2, 3]),
      snapshotOf([1, 2, 3, 4, 5]),
      snapshotOf([1, 2, 3, -0]),
      snapshotOf([-0, 0, 0, 1]),
      snapshotOf([1, 2, 3, -1]),
      snapshotOf([1, 2, 3, 0.5]),
      snapshotOf([1, 2, 3, 4_294_967_296]),
      snapshotOf([1, 2, 3, NaN]),
      snapshotOf([1, 2, 3, Infinity]),
      snapshotOf([0, 0, 0, 0]),
    ];
    for (const snapshot of cases) {
      expect(() => createSeededRandom(loose(snapshot))).toThrow(RangeError);
    }
  });
});

describe("snapshots", () => {
  test("a JSON round-trip reproduces all subsequent draws", () => {
    const random = createSeededRandom(99);
    draws(random, 3);
    const restored = createSeededRandom(JSON.parse(JSON.stringify(random.snapshot())) as RandomSnapshot);
    expect(draws(restored, 100)).toEqual(draws(random, 100));
  });

  test("snapshots contain only the algorithm and words", () => {
    const snapshot = createSeededRandom(3).snapshot();
    expect(Object.keys(snapshot).sort()).toEqual(["algorithm", "words"]);
    expect(snapshot.words).toHaveLength(4);
  });

  test("snapshot() does not advance the stream", () => {
    const random = createSeededRandom(5);
    random.snapshot();
    expect(draws(random, 5)).toEqual(draws(createSeededRandom(5), 5));
  });

  test("mutating the input snapshot does not alter the stream", () => {
    const input = { algorithm: "xoshiro128ss-v1", words: [1, 2, 3, 4] };
    const random = createSeededRandom(snapshotOf(input.words));
    const viaInput = createSeededRandom(loose(input));
    input.words[0] = 99;
    input.words.length = 0;
    input.algorithm = "other";
    expect(draws(viaInput, 5)).toEqual(draws(random, 5));
  });

  test("mutating a returned snapshot does not alter the stream", () => {
    const random = createSeededRandom(8);
    const reference = createSeededRandom(8);
    const returned = loose<{ algorithm: string; words: number[] }>(random.snapshot());
    returned.words[1] = 0;
    returned.words.push(5);
    returned.algorithm = "other";
    expect(random.snapshot()).toEqual(reference.snapshot());
    expect(draws(random, 5)).toEqual(draws(reference, 5));
  });

  test("each snapshot is a fresh copy", () => {
    const random = createSeededRandom(8);
    const first = random.snapshot();
    expect(random.snapshot()).not.toBe(first);
    expect(random.snapshot().words).not.toBe(first.words);
  });
});
