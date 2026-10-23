import { describe, expect, mock, test } from "bun:test";
import {
  createInMemoryScheduler,
  createInMemoryStateStore,
  createModuleRegistry,
  executeInMemoryOperation,
  moduleId,
  simTime,
  workItemId,
} from "../src/index.ts";
import type { InMemoryScheduler, OperationHandler, ScheduledWork, SimTime } from "../src/index.ts";

const a = moduleId("module-a");

function work(id: string, at: number, overrides: Record<string, unknown> = {}): ScheduledWork {
  return {
    id: workItemId(id),
    at: simTime(at),
    request: { moduleId: a, operation: "op-x", payloadVersion: 1, payload: { n: 1 }, ...overrides },
  };
}

/** Bypasses static types to exercise runtime validation. */
function loose<T>(value: unknown): T {
  return value as T;
}

/** Advances while recording the IDs passed to the callback. */
function runAll(scheduler: InMemoryScheduler, target: number, max = 1_000): { ids: string[]; times: number[] } {
  const ids: string[] = [];
  const times: number[] = [];
  scheduler.advanceTo(simTime(target), max, (w) => {
    ids.push(w.id);
    times.push(scheduler.now());
  });
  return { ids, times };
}

const noop = () => {};

describe("creation", () => {
  test("a new scheduler starts empty at time 0", () => {
    const scheduler = createInMemoryScheduler();
    expect(scheduler.now()).toBe(simTime(0));
    expect(scheduler.pendingCount()).toBe(0);
  });

  test("accepts an explicit starting time", () => {
    expect(createInMemoryScheduler(simTime(1_500)).now()).toBe(simTime(1_500));
  });

  test("exposes only the documented methods", () => {
    expect(Object.keys(createInMemoryScheduler()).sort()).toEqual(["advanceTo", "now", "pendingCount", "schedule"]);
  });

  test("instances have independent clocks and queues", () => {
    const first = createInMemoryScheduler();
    const second = createInMemoryScheduler();
    first.schedule(work("w1", 10));
    first.advanceTo(simTime(5), 1, noop);
    expect(first.now()).toBe(simTime(5));
    expect(second.now()).toBe(simTime(0));
    expect(first.pendingCount()).toBe(1);
    expect(second.pendingCount()).toBe(0);
    second.schedule(work("w1", 10)); // same ID in another instance is independent
    expect(second.pendingCount()).toBe(1);
  });

  test("does not advance on its own", async () => {
    const scheduler = createInMemoryScheduler();
    scheduler.schedule(work("w1", 0));
    await Bun.sleep(5);
    expect(scheduler.now()).toBe(simTime(0));
    expect(scheduler.pendingCount()).toBe(1);
  });
});

describe("time validation", () => {
  const invalidTimes: [unknown, ErrorConstructor | RangeErrorConstructor | TypeErrorConstructor][] = [
    [-0, RangeError],
    [-1, RangeError],
    [1.5, RangeError],
    [Number.NaN, RangeError],
    [Number.POSITIVE_INFINITY, RangeError],
    [Number.MAX_SAFE_INTEGER + 1, RangeError],
    ["5", TypeError],
    [null, TypeError],
  ];

  test("rejects invalid initial times, including -0", () => {
    for (const [value, error] of invalidTimes) {
      expect(() => createInMemoryScheduler(loose<SimTime>(value))).toThrow(error);
    }
  });

  test("rejects invalid targets, including -0, without changing anything", () => {
    const scheduler = createInMemoryScheduler();
    scheduler.schedule(work("w1", 0));
    for (const [value, error] of invalidTimes) {
      const execute = mock(noop);
      expect(() => scheduler.advanceTo(loose<SimTime>(value), 1, execute)).toThrow(error);
      expect(execute).not.toHaveBeenCalled();
    }
    expect(scheduler.now()).toBe(simTime(0));
    expect(scheduler.pendingCount()).toBe(1);
  });

  test("rejects a target earlier than now; the clock never moves backward", () => {
    const scheduler = createInMemoryScheduler(simTime(100));
    scheduler.schedule(work("w1", 100));
    const execute = mock(noop);
    expect(() => scheduler.advanceTo(simTime(99), 1, execute)).toThrow(RangeError);
    expect(execute).not.toHaveBeenCalled();
    expect(scheduler.now()).toBe(simTime(100));
    expect(scheduler.pendingCount()).toBe(1);
  });
});

describe("scheduling", () => {
  test("accepts work at the current time and in the future", () => {
    const scheduler = createInMemoryScheduler(simTime(10));
    scheduler.schedule(work("now", 10));
    scheduler.schedule(work("later", 20));
    expect(scheduler.pendingCount()).toBe(2);
    expect(scheduler.now()).toBe(simTime(10));
  });

  test("rejects past-time work without modifying the queue", () => {
    const scheduler = createInMemoryScheduler(simTime(10));
    scheduler.schedule(work("w1", 20));
    expect(() => scheduler.schedule(work("past", 9))).toThrow(RangeError);
    expect(scheduler.pendingCount()).toBe(1);
    expect(runAll(scheduler, 100).ids).toEqual(["w1"]);
  });

  test("rejects a duplicate pending ID without modifying the queue", () => {
    const scheduler = createInMemoryScheduler();
    scheduler.schedule(work("w1", 20, { payload: "first" }));
    expect(() => scheduler.schedule(work("w1", 10, { payload: "second" }))).toThrow(Error);
    expect(scheduler.pendingCount()).toBe(1);
    const payloads: unknown[] = [];
    scheduler.advanceTo(simTime(100), 10, (w) => payloads.push(w.request.payload));
    expect(payloads).toEqual(["first"]);
  });

  test("IDs are case-sensitive", () => {
    const scheduler = createInMemoryScheduler();
    scheduler.schedule(work("w1", 0));
    scheduler.schedule(work("W1", 0));
    expect(scheduler.pendingCount()).toBe(2);
  });

  test("a completed ID may be scheduled again", () => {
    const scheduler = createInMemoryScheduler();
    scheduler.schedule(work("w1", 5));
    expect(runAll(scheduler, 5).ids).toEqual(["w1"]);
    scheduler.schedule(work("w1", 6));
    expect(runAll(scheduler, 6).ids).toEqual(["w1"]);
  });

  test("rejected work consumes no ordering position", () => {
    const scheduler = createInMemoryScheduler();
    scheduler.schedule(work("w1", 5));
    expect(() => scheduler.schedule(work("bad", 5, { operation: " " }))).toThrow();
    expect(() => scheduler.schedule(work("w1", 5))).toThrow();
    scheduler.schedule(work("w2", 5));
    scheduler.schedule(work("w3", 5));
    expect(runAll(scheduler, 5).ids).toEqual(["w1", "w2", "w3"]);
  });

  test("the operation need not be registered", () => {
    const scheduler = createInMemoryScheduler();
    scheduler.schedule(work("w1", 0, { moduleId: moduleId("module-unregistered"), operation: "op-unknown" }));
    expect(scheduler.pendingCount()).toBe(1);
  });
});

describe("envelope validation", () => {
  function rejects(input: unknown, error: ErrorConstructor | RangeErrorConstructor | TypeErrorConstructor): void {
    const scheduler = createInMemoryScheduler();
    expect(() => scheduler.schedule(loose<ScheduledWork>(input))).toThrow(error);
    expect(scheduler.pendingCount()).toBe(0);
  }

  const base = work("w1", 0);

  test("rejects a non-object work item", () => {
    for (const input of [null, undefined, "w1", 5]) rejects(input, TypeError);
  });

  test("rejects bad work IDs", () => {
    rejects({ ...base, id: "" }, RangeError);
    rejects({ ...base, id: "  " }, RangeError);
    rejects({ ...base, id: 7 }, TypeError);
    rejects({ ...base, id: undefined }, TypeError);
  });

  test("rejects bad scheduled times", () => {
    rejects({ ...base, at: -0 }, RangeError);
    rejects({ ...base, at: 0.5 }, RangeError);
    rejects({ ...base, at: "0" }, TypeError);
  });

  test("rejects a non-object or incomplete request", () => {
    rejects({ ...base, request: null }, TypeError);
    rejects({ ...base, request: [] }, TypeError);
    rejects({ ...base, request: { moduleId: "module-a", operation: "op-x", payloadVersion: 1 } }, TypeError);
    const inherited = Object.create({ payload: 1 }) as Record<string, unknown>;
    Object.assign(inherited, { moduleId: "module-a", operation: "op-x", payloadVersion: 1 });
    rejects({ ...base, request: inherited }, TypeError);
  });

  test("rejects bad module IDs", () => {
    rejects(work("w1", 0, { moduleId: "" }), RangeError);
    rejects(work("w1", 0, { moduleId: " " }), RangeError);
    rejects(work("w1", 0, { moduleId: 1 }), TypeError);
  });

  test("rejects blank or non-string operation names", () => {
    rejects(work("w1", 0, { operation: "" }), RangeError);
    rejects(work("w1", 0, { operation: " \t" }), RangeError);
    rejects(work("w1", 0, { operation: 1 }), TypeError);
  });

  test("rejects invalid payload versions, including -0", () => {
    for (const version of [0, -0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      rejects(work("w1", 0, { payloadVersion: version }), RangeError);
    }
    rejects(work("w1", 0, { payloadVersion: "1" }), TypeError);
  });

  test("accepts operation names and versions unchanged", () => {
    const scheduler = createInMemoryScheduler();
    scheduler.schedule(work("w1", 0, { operation: " Op-X ", payloadVersion: Number.MAX_SAFE_INTEGER }));
    const seen: ScheduledWork[] = [];
    scheduler.advanceTo(simTime(0), 1, (w) => seen.push(w));
    expect(seen[0]!.request.operation).toBe(" Op-X ");
    expect(seen[0]!.request.payloadVersion).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("payload values", () => {
  function rejectsPayload(payload: unknown): void {
    const scheduler = createInMemoryScheduler();
    expect(() => scheduler.schedule(work("w1", 0, { payload }))).toThrow(TypeError);
    expect(scheduler.pendingCount()).toBe(0);
  }

  test("rejects -0, NaN, and infinities directly and at depth", () => {
    for (const bad of [-0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      rejectsPayload(bad);
      rejectsPayload([bad]);
      rejectsPayload({ k: { list: [1, { deep: [bad] }] } });
    }
  });

  test("rejects unsupported values and objects", () => {
    class Custom {
      value = 1;
    }
    for (const bad of [undefined, 1n, Symbol("s"), () => 1, new Date(0), new Map(), new Custom(), [1, , 3]]) {
      rejectsPayload(bad);
      rejectsPayload({ k: bad });
    }
  });

  test("rejects cyclic data", () => {
    const cyclic: Record<string, unknown> = { k: 1 };
    cyclic.self = cyclic;
    rejectsPayload(cyclic);
    const list: unknown[] = [];
    list.push({ list });
    rejectsPayload(list);
  });

  test("preserves valid JSON-like data", () => {
    const payload = { s: "x", n: -1.5, z: 0, t: true, f: false, nil: null, list: [1, [2, { k: "v" }]], empty: {} };
    const scheduler = createInMemoryScheduler();
    scheduler.schedule(work("w1", 0, { payload }));
    const seen: unknown[] = [];
    scheduler.advanceTo(simTime(0), 1, (w) => seen.push(w.request.payload));
    expect(seen).toEqual([payload]);
    expect(Object.is((seen[0] as { z: number }).z, 0)).toBe(true);
  });

  test("accepts primitive and null payloads", () => {
    const scheduler = createInMemoryScheduler();
    const values = [null, 0, "", "text", false];
    values.forEach((payload, index) => scheduler.schedule(work(`w${index}`, 0, { payload })));
    const seen: unknown[] = [];
    scheduler.advanceTo(simTime(0), 10, (w) => seen.push(w.request.payload));
    expect(seen).toEqual(values);
  });
});

describe("defensive copying", () => {
  test("mutating the caller's objects after scheduling does not affect pending work", () => {
    const payload = { list: [1, 2], nested: { k: "v" } };
    const request = { moduleId: a, operation: "op-x", payloadVersion: 1, payload };
    const input = { id: workItemId("w1"), at: simTime(5), request };
    const scheduler = createInMemoryScheduler();
    scheduler.schedule(input);

    payload.list.push(3);
    payload.nested.k = "changed";
    request.operation = "op-changed";
    request.payloadVersion = 9;
    (input as { at: number }).at = 1_000;

    const seen: ScheduledWork[] = [];
    scheduler.advanceTo(simTime(5), 1, (w) => seen.push(w));
    expect(seen).toEqual([
      {
        id: workItemId("w1"),
        at: simTime(5),
        request: { moduleId: a, operation: "op-x", payloadVersion: 1, payload: { list: [1, 2], nested: { k: "v" } } },
      },
    ]);
  });

  test("mutating a callback's work cannot affect a pending retry", () => {
    const scheduler = createInMemoryScheduler();
    scheduler.schedule(work("w1", 5, { payload: { list: [1] } }));
    expect(() =>
      scheduler.advanceTo(simTime(5), 1, (w) => {
        const mutable = w as { request: { operation: string; payload: { list: number[] } } };
        mutable.request.payload.list.push(2);
        mutable.request.operation = "op-changed";
        throw new Error("fail");
      }),
    ).toThrow("fail");

    const seen: ScheduledWork[] = [];
    scheduler.advanceTo(simTime(5), 1, (w) => seen.push(w));
    expect(seen[0]!.request).toEqual({ moduleId: a, operation: "op-x", payloadVersion: 1, payload: { list: [1] } });
  });

  test("each callback invocation receives a separate copy", () => {
    const scheduler = createInMemoryScheduler();
    scheduler.schedule(work("w1", 5));
    const seen: ScheduledWork[] = [];
    expect(() =>
      scheduler.advanceTo(simTime(5), 1, (w) => {
        seen.push(w);
        throw new Error("fail");
      }),
    ).toThrow("fail");
    scheduler.advanceTo(simTime(5), 1, (w) => seen.push(w));
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[0]!.request.payload).not.toBe(seen[1]!.request.payload);
    expect(seen[0]).toEqual(seen[1]!);
  });
});

describe("ordering", () => {
  test("runs items in increasing time order regardless of insertion order", () => {
    const scheduler = createInMemoryScheduler();
    for (const [id, at] of [["c", 30], ["a", 10], ["e", 50], ["b", 20], ["d", 40]] as const) {
      scheduler.schedule(work(id, at));
    }
    expect(runAll(scheduler, 100)).toEqual({ ids: ["a", "b", "c", "d", "e"], times: [10, 20, 30, 40, 50] });
  });

  test("equal times run in insertion order, even when interleaved with other times", () => {
    const scheduler = createInMemoryScheduler();
    const inserts: [string, number][] = [
      ["t20-1", 20],
      ["t10-1", 10],
      ["t20-2", 20],
      ["t30-1", 30],
      ["t10-2", 10],
      ["t20-3", 20],
      ["t10-3", 10],
      ["t30-2", 30],
      ["t20-4", 20],
    ];
    for (const [id, at] of inserts) scheduler.schedule(work(id, at));
    expect(runAll(scheduler, 100).ids).toEqual([
      "t10-1",
      "t10-2",
      "t10-3",
      "t20-1",
      "t20-2",
      "t20-3",
      "t20-4",
      "t30-1",
      "t30-2",
    ]);
  });

  test("ordering holds for a larger queue with work added between advances", () => {
    const scheduler = createInMemoryScheduler();
    const expected: [number, number][] = [];
    let sequence = 0;
    const add = (at: number) => {
      scheduler.schedule(work(`w${sequence}`, at, { payload: sequence }));
      expected.push([at, sequence++]);
    };
    // Deterministic pseudo-random times in [0, 50).
    let seed = 7;
    for (let i = 0; i < 200; i++) {
      seed = (seed * 31 + 11) % 97;
      add(seed % 50);
    }
    const seen: [number, number][] = [];
    scheduler.advanceTo(simTime(24), 1_000, (w) => seen.push([w.at, w.request.payload as number]));
    for (let i = 0; i < 100; i++) {
      seed = (seed * 31 + 11) % 97;
      add(24 + (seed % 26));
    }
    scheduler.advanceTo(simTime(100), 1_000, (w) => seen.push([w.at, w.request.payload as number]));
    expect(seen).toEqual(expected.sort((x, y) => x[0] - y[0] || x[1] - y[1]));
  });
});

describe("advancement", () => {
  test("advancing an empty scheduler moves the clock to the target", () => {
    const scheduler = createInMemoryScheduler(simTime(3));
    const execute = mock(noop);
    expect(scheduler.advanceTo(simTime(40), 5, execute)).toEqual({ now: simTime(40), executed: 0, reachedTarget: true });
    expect(execute).not.toHaveBeenCalled();
    expect(scheduler.now()).toBe(simTime(40));
  });

  test("advancing over part of the queue runs only due work", () => {
    const scheduler = createInMemoryScheduler();
    scheduler.schedule(work("w1", 10));
    scheduler.schedule(work("w2", 20));
    scheduler.schedule(work("w3", 30));
    const ids: string[] = [];
    expect(scheduler.advanceTo(simTime(25), 10, (w) => ids.push(w.id))).toEqual({
      now: simTime(25),
      executed: 2,
      reachedTarget: true,
    });
    expect(ids).toEqual(["w1", "w2"]);
    expect(scheduler.pendingCount()).toBe(1);
  });

  test("work exactly at the target runs", () => {
    const scheduler = createInMemoryScheduler();
    scheduler.schedule(work("w1", 30));
    scheduler.schedule(work("w2", 31));
    expect(runAll(scheduler, 30).ids).toEqual(["w1"]);
    expect(scheduler.now()).toBe(simTime(30));
  });

  test("advancing to the current time runs work due now", () => {
    const scheduler = createInMemoryScheduler(simTime(7));
    scheduler.schedule(work("w1", 7));
    expect(scheduler.advanceTo(simTime(7), 1, noop)).toEqual({ now: simTime(7), executed: 1, reachedTarget: true });
    expect(scheduler.pendingCount()).toBe(0);
  });

  test("the callback observes each item's scheduled time as now()", () => {
    const scheduler = createInMemoryScheduler();
    scheduler.schedule(work("w1", 10));
    scheduler.schedule(work("w2", 15));
    expect(runAll(scheduler, 100).times).toEqual([10, 15]);
    expect(scheduler.now()).toBe(simTime(100));
  });

  test("ignores the callback's return value", () => {
    const scheduler = createInMemoryScheduler();
    scheduler.schedule(work("w1", 0));
    scheduler.schedule(work("w2", 0));
    const returns: unknown[] = [false, { ok: false }];
    const result = scheduler.advanceTo(simTime(0), 5, loose<(w: ScheduledWork) => void>(() => returns.shift()));
    expect(result.executed).toBe(2);
  });
});

describe("bounded work", () => {
  test("the limit caps callbacks and leaves the backlog without skipping it", () => {
    const scheduler = createInMemoryScheduler();
    for (const [id, at] of [["w1", 10], ["w2", 20], ["w3", 20], ["w4", 30], ["w5", 60]] as const) {
      scheduler.schedule(work(id, at));
    }
    const ids: string[] = [];
    const execute = (w: ScheduledWork) => void ids.push(w.id);

    expect(scheduler.advanceTo(simTime(50), 2, execute)).toEqual({ now: simTime(20), executed: 2, reachedTarget: false });
    expect(scheduler.now()).toBe(simTime(20));
    expect(scheduler.pendingCount()).toBe(3);

    expect(scheduler.advanceTo(simTime(50), 1, execute)).toEqual({ now: simTime(20), executed: 1, reachedTarget: false });
    expect(scheduler.advanceTo(simTime(50), 5, execute)).toEqual({ now: simTime(50), executed: 1, reachedTarget: true });
    expect(ids).toEqual(["w1", "w2", "w3", "w4"]);
    expect(scheduler.pendingCount()).toBe(1);
  });

  test("an exactly exhausted backlog reaches the target", () => {
    const scheduler = createInMemoryScheduler();
    scheduler.schedule(work("w1", 10));
    scheduler.schedule(work("w2", 20));
    scheduler.schedule(work("w3", 90));
    expect(scheduler.advanceTo(simTime(50), 2, noop)).toEqual({ now: simTime(50), executed: 2, reachedTarget: true });
  });

  test("invalid limits fail before executing anything", () => {
    const scheduler = createInMemoryScheduler();
    scheduler.schedule(work("w1", 0));
    const cases: [unknown, RangeErrorConstructor | TypeErrorConstructor][] = [
      [0, RangeError],
      [-0, RangeError],
      [-1, RangeError],
      [1.5, RangeError],
      [Number.MAX_SAFE_INTEGER + 1, RangeError],
      [Number.POSITIVE_INFINITY, RangeError],
      [Number.NaN, RangeError],
      ["1", TypeError],
      [undefined, TypeError],
    ];
    for (const [limit, error] of cases) {
      const execute = mock(noop);
      expect(() => scheduler.advanceTo(simTime(10), loose<number>(limit), execute)).toThrow(error);
      expect(execute).not.toHaveBeenCalled();
    }
    expect(scheduler.now()).toBe(simTime(0));
    expect(scheduler.pendingCount()).toBe(1);
  });

  test("a non-function callback fails with TypeError before any change", () => {
    const scheduler = createInMemoryScheduler();
    scheduler.schedule(work("w1", 0));
    for (const execute of [undefined, null, {}, "f"]) {
      expect(() => scheduler.advanceTo(simTime(10), 1, loose<(w: ScheduledWork) => void>(execute))).toThrow(TypeError);
    }
    expect(scheduler.now()).toBe(simTime(0));
    expect(scheduler.pendingCount()).toBe(1);
  });
});

describe("callback failure", () => {
  test("a throw keeps the item pending, stops at its time, and keeps earlier successes", () => {
    const scheduler = createInMemoryScheduler();
    scheduler.schedule(work("w1", 10));
    scheduler.schedule(work("w2", 20));
    scheduler.schedule(work("w3", 30));
    const failure = new Error("fail");
    const ids: string[] = [];
    let thrown: unknown;
    try {
      scheduler.advanceTo(simTime(50), 10, (w) => {
        if (w.id === "w2") throw failure;
        ids.push(w.id);
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(failure);
    expect(ids).toEqual(["w1"]);
    expect(scheduler.now()).toBe(simTime(20));
    expect(scheduler.pendingCount()).toBe(2);

    expect(scheduler.advanceTo(simTime(50), 10, (w) => void ids.push(w.id))).toEqual({
      now: simTime(50),
      executed: 2,
      reachedTarget: true,
    });
    expect(ids).toEqual(["w1", "w2", "w3"]);
  });

  test("a failed item keeps its place ahead of equal-time items", () => {
    const scheduler = createInMemoryScheduler();
    scheduler.schedule(work("w1", 10));
    scheduler.schedule(work("w2", 10));
    expect(() =>
      scheduler.advanceTo(simTime(10), 5, () => {
        throw new Error("fail");
      }),
    ).toThrow("fail");
    expect(runAll(scheduler, 10).ids).toEqual(["w1", "w2"]);
  });

  test("a failed item's ID stays reserved until it succeeds", () => {
    const scheduler = createInMemoryScheduler();
    scheduler.schedule(work("w1", 10));
    expect(() =>
      scheduler.advanceTo(simTime(10), 1, () => {
        throw new Error("fail");
      }),
    ).toThrow("fail");
    expect(() => scheduler.schedule(work("w1", 10))).toThrow(Error);
  });

  test("Promise and thenable returns are rejected and keep the item pending", () => {
    for (const returned of [Promise.resolve(), { then: () => {} }, Object.assign(() => {}, { then: () => {} })]) {
      const scheduler = createInMemoryScheduler();
      scheduler.schedule(work("w1", 10));
      scheduler.schedule(work("w2", 20));
      expect(() => scheduler.advanceTo(simTime(30), 5, loose<(w: ScheduledWork) => void>(() => returned))).toThrow(
        TypeError,
      );
      expect(scheduler.now()).toBe(simTime(10));
      expect(scheduler.pendingCount()).toBe(2);
      expect(runAll(scheduler, 30).ids).toEqual(["w1", "w2"]);
    }
  });

  test("an async callback is rejected", () => {
    const scheduler = createInMemoryScheduler();
    scheduler.schedule(work("w1", 10));
    expect(() => scheduler.advanceTo(simTime(10), 1, async () => {})).toThrow(TypeError);
    expect(scheduler.pendingCount()).toBe(1);
  });
});

describe("reentrancy", () => {
  test("nested advanceTo is rejected and the outer failure keeps the item", () => {
    const scheduler = createInMemoryScheduler();
    scheduler.schedule(work("w1", 10));
    let nested: unknown;
    expect(() =>
      scheduler.advanceTo(simTime(10), 1, () => {
        try {
          scheduler.advanceTo(simTime(10), 1, noop);
        } catch (error) {
          nested = error;
          throw error;
        }
      }),
    ).toThrow(Error);
    expect(nested).toBeInstanceOf(Error);
    expect(scheduler.pendingCount()).toBe(1);
  });

  test("schedule from a callback is rejected and enqueues nothing", () => {
    const scheduler = createInMemoryScheduler();
    scheduler.schedule(work("w1", 10));
    let caught: unknown;
    scheduler.advanceTo(simTime(10), 1, () => {
      try {
        scheduler.schedule(work("w2", 20));
      } catch (error) {
        caught = error;
      }
    });
    expect(caught).toBeInstanceOf(Error);
    expect(scheduler.pendingCount()).toBe(0);
  });

  test("reading now() and pendingCount() from a callback is allowed", () => {
    const scheduler = createInMemoryScheduler();
    scheduler.schedule(work("w1", 10));
    scheduler.schedule(work("w2", 20));
    const observed: [number, number][] = [];
    scheduler.advanceTo(simTime(30), 5, () => void observed.push([scheduler.now(), scheduler.pendingCount()]));
    expect(observed).toEqual([
      [10, 2],
      [20, 1],
    ]);
  });

  test("the guard is released after a failed advance", () => {
    const scheduler = createInMemoryScheduler();
    scheduler.schedule(work("w1", 10));
    expect(() =>
      scheduler.advanceTo(simTime(10), 1, () => {
        throw new Error("fail");
      }),
    ).toThrow("fail");
    scheduler.schedule(work("w2", 10));
    expect(runAll(scheduler, 10).ids).toEqual(["w1", "w2"]);
  });

  test("the guard is released after a successful advance", () => {
    const scheduler = createInMemoryScheduler();
    scheduler.schedule(work("w1", 10));
    runAll(scheduler, 10);
    scheduler.schedule(work("w2", 10));
    expect(runAll(scheduler, 10).ids).toEqual(["w2"]);
  });

  test("another scheduler can be used from a callback", () => {
    const outer = createInMemoryScheduler();
    const inner = createInMemoryScheduler();
    outer.schedule(work("w1", 10));
    outer.advanceTo(simTime(10), 1, () => inner.schedule(work("w2", 0)));
    expect(inner.pendingCount()).toBe(1);
  });
});

describe("executor integration", () => {
  test("a callback can run scheduled work through executeInMemoryOperation", () => {
    const registry = createModuleRegistry();
    registry.register({
      id: a,
      operations: [{ name: "op-add", version: 1, validatePayload: (p) => typeof p === "number" }],
    });
    const store = createInMemoryStateStore();
    store.forModule(a).set("k1", 0);

    const add: OperationHandler = (request, state) => {
      state.set("k1", (state.get(request.moduleId, "k1") as number) + (request.payload as number));
    };

    const scheduler = createInMemoryScheduler();
    scheduler.schedule(work("w1", 10, { operation: "op-add", payload: 2 }));
    scheduler.schedule(work("w2", 20, { operation: "op-add", payload: "not-a-number" }));
    scheduler.schedule(work("w3", 30, { operation: "op-add", payload: 3 }));

    const execute = (w: ScheduledWork) => {
      const result = executeInMemoryOperation(registry, store, w.request, add);
      if (!result.ok) throw new Error(`rejected: ${result.reason}`);
    };

    expect(() => scheduler.advanceTo(simTime(40), 10, execute)).toThrow("rejected: invalid-payload");
    expect(scheduler.now()).toBe(simTime(20));
    expect(scheduler.pendingCount()).toBe(2);
    expect(store.forModule(a).get(a, "k1")).toBe(2);
  });
});
