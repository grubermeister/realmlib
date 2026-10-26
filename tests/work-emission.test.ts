import { describe, expect, test } from "bun:test";
import {
  createInMemoryOperationRuntime,
  createInMemoryScheduler,
  createInMemoryStateStore,
  createModuleRegistry,
  createSeededRandom,
  executeInMemoryOperation,
  moduleId,
  simTime,
  workItemId,
  WorkIdConflictError,
} from "../src/index.ts";
import type {
  WorkEmitter,
  InMemoryOperationRuntime,
  ModuleId,
  OperationHandler,
  ScheduledWork,
  StateValue,
  StoredWork,
} from "../src/index.ts";
import { admitEmittedWork } from "../src/scheduler.ts";

const MAX = Number.MAX_SAFE_INTEGER;
const SEED = 20_261_026;

const a = moduleId("module-a");
const b = moduleId("module-b");

const registry = createModuleRegistry();
registry.register({ id: a, operations: [{ name: "step", version: 1, validatePayload: () => true }] });
registry.register({ id: b, operations: [{ name: "step", version: 1, validatePayload: () => true }] });

/** Bypasses static types to exercise runtime validation. */
function loose<T>(value: unknown): T {
  return value as T;
}

function work(id: string, at: number, owner: ModuleId = a, payload: StateValue = {}): ScheduledWork {
  return { id: workItemId(id), at: simTime(at), request: { moduleId: owner, operation: "step", payloadVersion: 1, payload } };
}

/** What `step` emits: a work item for `to` (default module A) running `step` with `payload`. */
type Emission = { id: string; at: number; to?: string; payload?: StateValue };

/**
 * Appends the payload's `tag` to its module's `log`, stores one draw under
 * `roll`, emits the payload's `emits` in order, then throws if `fail` is set.
 */
const step: OperationHandler = (request, state, random, emitter) => {
  const { tag = null, emits = [], fail = false } = request.payload as { tag?: string; emits?: Emission[]; fail?: boolean };
  const log = (state.get(request.moduleId, "log") as StateValue[] | undefined) ?? [];
  state.set("log", [...log, tag]);
  if (random !== undefined) state.set("roll", random.nextFloat());
  for (const e of emits) emitter!.emit(work(e.id, e.at, moduleId(e.to ?? a), e.payload ?? {}));
  if (fail) throw new Error("handler failed after emitting");
};

/** An `advanceTo()` callback that runs `handler` through `runtime`, recording each executed ID. */
function through(runtime: InMemoryOperationRuntime, executed: string[] = [], handler: OperationHandler = step) {
  return (w: ScheduledWork): void => {
    const outcome = runtime.execute(registry, w.request, handler);
    if (!outcome.ok) throw new Error(`rejected: ${outcome.reason}`);
    executed.push(w.id);
  };
}

function runtimeWithRandom(initialTime = 0): InMemoryOperationRuntime {
  return createInMemoryOperationRuntime(simTime(initialTime), createSeededRandom(SEED).snapshot());
}

/** Pending work in execution order, as [id, at, sequence, module]. */
async function queue(runtime: InMemoryOperationRuntime): Promise<(string | number)[][]> {
  const due = await runtime.storage.readDue(simTime(MAX), 1_000);
  return due.map((w) => [w.id, w.at, w.sequence, w.request.moduleId]);
}

/** Everything observable about a runtime's committed state. */
async function observe(runtime: InMemoryOperationRuntime) {
  return {
    now: await runtime.scheduler.now(),
    nextSequence: await runtime.storage.readNextSequence(),
    queue: await queue(runtime),
    records: [a, b].map((owner) => [runtime.read(owner, "log") ?? null, runtime.read(owner, "roll") ?? null]),
    random: runtime.randomSnapshot() ?? null,
  };
}

describe("emitting work", () => {
  test("a module's operation emits work for another module, which runs through the scheduler and writes only its own records", async () => {
    const runtime = runtimeWithRandom();
    await runtime.scheduler.schedule(
      work("a1", 10, a, { tag: "a1", emits: [{ id: "b1", at: 25, to: b, payload: { tag: "b1" } }] }),
    );

    const executed: string[] = [];
    expect(await runtime.scheduler.advanceTo(simTime(20), 10, through(runtime, executed))).toEqual({
      now: simTime(20),
      executed: 1,
      reachedTarget: true,
    });
    // A's operation committed its own records and B's work, but nothing of B's.
    expect(runtime.read(a, "log")).toEqual(["a1"]);
    expect(runtime.read(b, "log")).toBeUndefined();
    expect(await queue(runtime)).toEqual([["b1", 25, 1, b]]);
    expect(await runtime.storage.readWork(workItemId("b1"))).toEqual({
      status: "pending",
      work: { ...work("b1", 25, b, { tag: "b1" }), sequence: 1 } as StoredWork,
    });

    expect(await runtime.scheduler.advanceTo(simTime(30), 10, through(runtime, executed))).toEqual({
      now: simTime(30),
      executed: 1,
      reachedTarget: true,
    });
    expect(executed).toEqual(["a1", "b1"]);
    // B's handler ran with B's state access: it wrote B's records only.
    expect(runtime.read(a, "log")).toEqual(["a1"]);
    expect(runtime.read(b, "log")).toEqual(["b1"]);
    expect(await runtime.storage.readWorkIdStatus(workItemId("b1"))).toBe("completed");
    expect(await runtime.scheduler.pendingCount()).toBe(0);
  });

  test("emitted work runs after work already queued at the same time, in emission order", async () => {
    const runtime = runtimeWithRandom();
    await runtime.scheduler.schedule(
      work("source", 10, a, {
        tag: "source",
        emits: [
          { id: "e1", at: 10, to: b, payload: { tag: "e1" } },
          { id: "e2", at: 10, payload: { tag: "e2" } },
          { id: "e3", at: 11, to: b, payload: { tag: "e3" } },
        ],
      }),
    );
    await runtime.scheduler.schedule(work("queued", 10, b, { tag: "queued" }));
    await runtime.scheduler.schedule(work("later", 11, a, { tag: "later" }));

    const executed: string[] = [];
    await runtime.scheduler.advanceTo(simTime(10), 1, through(runtime, executed));
    // Emitted items take the next sequences, after everything inserted before them.
    expect(await queue(runtime)).toEqual([
      ["queued", 10, 1, b],
      ["e1", 10, 3, b],
      ["e2", 10, 4, a],
      ["later", 11, 2, a],
      ["e3", 11, 5, b],
    ]);
    // The same advanceTo() picks up emitted work due at the current time.
    await runtime.scheduler.advanceTo(simTime(11), 100, through(runtime, executed));
    expect(executed).toEqual(["source", "queued", "e1", "e2", "later", "e3"]);
    expect(runtime.read(a, "log")).toEqual(["source", "e2", "later"]);
    expect(runtime.read(b, "log")).toEqual(["queued", "e1", "e3"]);
  });

  test("emitted work due after the target stays pending, and the clock stops at the target", async () => {
    const runtime = runtimeWithRandom();
    await runtime.scheduler.schedule(work("source", 10, a, { emits: [{ id: "later", at: 100, to: b }] }));

    expect(await runtime.scheduler.advanceTo(simTime(50), 100, through(runtime))).toEqual({
      now: simTime(50),
      executed: 1,
      reachedTarget: true,
    });
    expect(await queue(runtime)).toEqual([["later", 100, 1, b]]);
    expect(await runtime.scheduler.advanceTo(simTime(99), 100, through(runtime))).toEqual({
      now: simTime(99),
      executed: 0,
      reachedTarget: true,
    });
    expect(await runtime.scheduler.advanceTo(simTime(100), 100, through(runtime))).toEqual({
      now: simTime(100),
      executed: 1,
      reachedTarget: true,
    });
    expect(await runtime.scheduler.pendingCount()).toBe(0);
  });

  test("maxOperations bounds a chain of zero-delay emissions, and the next advance resumes it in order", async () => {
    /** Each link emits the next one at the same time, forever. */
    const chain: OperationHandler = (request, state, _random, emitter) => {
      const n = (request.payload as { n: number }).n;
      state.set("links", [...((state.get(request.moduleId, "links") as number[] | undefined) ?? []), n]);
      emitter!.emit(work(`link-${n + 1}`, emitter!.now, a, { n: n + 1 }));
    };
    const runtime = runtimeWithRandom();
    await runtime.scheduler.schedule(work("link-0", 10, a, { n: 0 }));
    const executed: string[] = [];

    expect(await runtime.scheduler.advanceTo(simTime(1_000), 5, through(runtime, executed, chain))).toEqual({
      now: simTime(10),
      executed: 5,
      reachedTarget: false,
    });
    expect(await queue(runtime)).toEqual([["link-5", 10, 5, a]]);
    expect(await runtime.scheduler.advanceTo(simTime(1_000), 3, through(runtime, executed, chain))).toEqual({
      now: simTime(10),
      executed: 3,
      reachedTarget: false,
    });
    expect(executed).toEqual(["link-0", "link-1", "link-2", "link-3", "link-4", "link-5", "link-6", "link-7"]);
    expect(runtime.read(a, "links")).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(await queue(runtime)).toEqual([["link-8", 10, 8, a]]);
  });

  test("the same experiment from the same start gives the same clock, queue, completions, and state", async () => {
    async function experiment() {
      const runtime = runtimeWithRandom(5);
      await runtime.scheduler.schedule(
        work("a1", 10, a, {
          tag: "a1",
          emits: [
            { id: "b1", at: 10, to: b, payload: { tag: "b1", emits: [{ id: "a2", at: 40, payload: { tag: "a2" } }] } },
            { id: "b2", at: 30, to: b, payload: { tag: "b2" } },
          ],
        }),
      );
      await runtime.scheduler.schedule(work("a0", 10, a, { tag: "a0" }));
      const executed: string[] = [];
      await runtime.scheduler.advanceTo(simTime(35), 2, through(runtime, executed));
      await runtime.scheduler.advanceTo(simTime(35), 100, through(runtime, executed));
      return { executed, ...(await observe(runtime)) };
    }

    const first = await experiment();
    expect(first.executed).toEqual(["a1", "a0", "b1", "b2"]);
    expect(first.queue).toEqual([["a2", 40, 4, a]]);
    expect(await experiment()).toEqual(first);
  });

  test("handlers run outside an operation runtime receive no emitter", async () => {
    let received: WorkEmitter | undefined | "unset" = "unset";
    const capture: OperationHandler = (_request, _state, _random, emitter) => {
      received = emitter;
    };
    executeInMemoryOperation(registry, createInMemoryStateStore(), work("w", 0).request, capture, createSeededRandom(1));
    expect(received).toBeUndefined();

    received = "unset";
    const scheduler = createInMemoryScheduler();
    await scheduler.schedule(work("w", 5));
    const store = createInMemoryStateStore();
    await scheduler.advanceTo(simTime(5), 1, (w) => void executeInMemoryOperation(registry, store, w.request, capture));
    expect(received).toBeUndefined();
  });

  test("readers on other microtasks see an emitting item either wholly uncommitted or wholly committed", async () => {
    const runtime = runtimeWithRandom();
    const emits = [{ id: "e1", at: 20 }, { id: "e2", at: 30 }, { id: "e3", at: 40 }];
    await runtime.scheduler.schedule(work("source", 10, a, { tag: "source", emits }));
    const ids = ["source", "e1", "e2", "e3"].map((id) => workItemId(id));

    // Starts every read in the same synchronous turn, so each sample is one instant.
    const sample = () =>
      Promise.all([
        Promise.all(ids.map((id) => runtime.storage.readWorkIdStatus(id))),
        runtime.storage.countPending(),
        runtime.storage.readNextSequence(),
        runtime.read(a, "log") ?? null,
        runtime.randomSnapshot() ?? null,
      ]);
    const before = await sample();

    let done = false;
    const advanced = runtime.scheduler.advanceTo(simTime(10), 1, through(runtime)).finally(() => (done = true));
    const samples: ReturnType<typeof sample>[] = [];
    while (!done) {
      samples.push(sample());
      await undefined;
    }
    await advanced;
    const after = await sample();
    expect(after).not.toEqual(before);
    expect(after[0]).toEqual(["completed", "pending", "pending", "pending"]);

    for (const seen of await Promise.all(samples)) expect([before, after]).toContainEqual(seen);
  });

  test("the in-memory runtime commits the same state and draws as executeInMemoryOperation()", async () => {
    const runtime = runtimeWithRandom();
    const store = createInMemoryStateStore();
    const random = createSeededRandom(SEED);
    for (const [index, tag] of ["x", "y", "z"].entries()) {
      await runtime.scheduler.schedule(work(`w${index}`, index, b, { tag }));
      executeInMemoryOperation(registry, store, work(`w${index}`, index, b, { tag }).request, step, random);
    }
    await runtime.scheduler.advanceTo(simTime(10), 10, through(runtime));
    expect(runtime.read(b, "log")).toEqual(store.forModule(b).get(b, "log")!);
    expect(runtime.read(b, "roll")).toBe(store.forModule(b).get(b, "roll")!);
    expect(runtime.randomSnapshot()).toEqual(random.snapshot());
  });
});

describe("emission failures", () => {
  test("throwing after emitting keeps no emitted work, state, or draws, and the item stays pending at its time", async () => {
    const runtime = runtimeWithRandom();
    await runtime.scheduler.schedule(work("queued", 50, b));
    await runtime.scheduler.schedule(
      work("source", 10, a, { tag: "source", emits: [{ id: "e1", at: 10 }, { id: "e2", at: 20, to: b }], fail: true }),
    );
    const before = await observe(runtime);

    await expect(runtime.scheduler.advanceTo(simTime(100), 10, through(runtime))).rejects.toThrow(
      "handler failed after emitting",
    );
    // Only the clock moved, to the failed item's time, as for any failed item.
    expect(await observe(runtime)).toEqual({ ...before, now: simTime(10) });
    expect(await runtime.storage.readWork(workItemId("e1"))).toBeUndefined();

    // A failure of the callback after a successful operation discards the operation too.
    const succeeds: OperationHandler = (request, state, random, emitter) =>
      step({ ...request, payload: { ...(request.payload as object), fail: false } }, state, random, emitter);
    const executedThenThrow = (w: ScheduledWork): void => {
      through(runtime, [], succeeds)(w);
      throw new Error("callback failed after the operation");
    };
    await expect(runtime.scheduler.advanceTo(simTime(100), 10, executedThenThrow)).rejects.toThrow("callback failed");
    expect(await observe(runtime)).toEqual({ ...before, now: simTime(10) });

    // The next accepted work gets the next sequence: the failures consumed none.
    expect(await runtime.scheduler.schedule(work("next", 60))).toBe("accepted");
    expect((await runtime.storage.readWork(workItemId("next")))!.work.sequence).toBe(2);
  });

  test("invalid emitted work is rejected when emitted, and an operation that lets it propagate keeps nothing", async () => {
    const invalid: [string, unknown, ErrorConstructor | typeof RangeError][] = [
      ["not an object", null, TypeError],
      ["blank ID", { ...work("x", 10), id: " " }, RangeError],
      ["ID with U+0000", { ...work("x", 10), id: "x\u0000" }, RangeError],
      ["earlier than the operation", work("x", 9), RangeError],
      ["negative zero time", { ...work("x", 10), at: -0 }, RangeError],
      ["fractional time", { ...work("x", 10), at: 10.5 }, RangeError],
      ["time past the safe range", { ...work("x", 10), at: MAX + 1 }, RangeError],
      ["missing request field", { ...work("x", 10), request: { moduleId: a, operation: "step", payloadVersion: 1 } }, TypeError],
      ["blank module", { ...work("x", 10), request: { ...work("x", 10).request, moduleId: "" } }, RangeError],
      ["zero version", { ...work("x", 10), request: { ...work("x", 10).request, payloadVersion: 0 } }, RangeError],
      ["negative zero in payload", work("x", 10, a, { n: [-0] }), TypeError],
      ["non-finite payload", work("x", 10, a, { n: Number.NaN }), TypeError],
      ["undefined in payload", work("x", 10, a, loose<StateValue>({ n: undefined })), TypeError],
    ];
    for (const [label, bad, errorType] of invalid) {
      const runtime = runtimeWithRandom();
      await runtime.scheduler.schedule(work("source", 10, a, { tag: "source" }));
      const before = await observe(runtime);
      const emitsThenFails: OperationHandler = (request, state, random, emitter) => {
        step(request, state, random, emitter);
        emitter!.emit(work("valid", 10, b));
        emitter!.emit(loose<ScheduledWork>(bad));
      };
      const error = await runtime.scheduler.advanceTo(simTime(20), 10, through(runtime, [], emitsThenFails)).catch((e) => e);
      expect([label, error]).toEqual([label, expect.any(errorType)]);
      expect([label, await observe(runtime)]).toEqual([label, { ...before, now: simTime(10) }]);
    }
  });

  test("a rejected emit queues nothing, so a handler that catches it keeps its other effects", async () => {
    const runtime = runtimeWithRandom();
    await runtime.scheduler.schedule(work("source", 10));
    const catches: OperationHandler = (request, state, random, emitter) => {
      step(request, state, random, emitter);
      emitter!.emit(work("kept", 10, b));
      expect(() => emitter!.emit(work("too-early", 9, b))).toThrow("earlier than the operation's time 10");
    };
    await runtime.scheduler.advanceTo(simTime(10), 1, through(runtime, [], catches));
    expect(await queue(runtime)).toEqual([["kept", 10, 1, b]]);
    expect(await runtime.storage.readWork(workItemId("too-early"))).toBeUndefined();
  });

  test("emitting different work under a stored ID fails the whole operation and inserts none of its items", async () => {
    const runtime = runtimeWithRandom();
    await runtime.scheduler.schedule(work("done", 10, b, { tag: "done" }));
    await runtime.scheduler.advanceTo(simTime(10), 10, through(runtime));
    await runtime.scheduler.schedule(work("waiting", 50, b, { tag: "waiting" }));
    await runtime.scheduler.schedule(work("source", 10, a, { tag: "source" }));
    const before = await observe(runtime);

    for (const [conflicting, status] of [
      [work("waiting", 50, b, { tag: "other" }), "pending"],
      [work("done", 10, a, { tag: "done" }), "completed"],
    ] as const) {
      const emitsConflict: OperationHandler = (request, state, random, emitter) => {
        step(request, state, random, emitter);
        emitter!.emit(work("fresh-1", 10, b));
        emitter!.emit(work("fresh-2", 20, a));
        emitter!.emit(conflicting);
      };
      const error = await runtime.scheduler.advanceTo(simTime(100), 10, through(runtime, [], emitsConflict)).catch((e) => e);
      expect(error).toBeInstanceOf(WorkIdConflictError);
      expect(error.status).toBe(status);
      // No prefix of the emitted items, no state or draws, no sequence, no receipt: the item stays pending.
      expect(await observe(runtime)).toEqual(before);
      expect(await runtime.storage.readWork(workItemId("fresh-1"))).toBeUndefined();
      expect(await runtime.storage.readWorkIdStatus(workItemId("source"))).toBe("pending");
    }

    // The completed receipt and the pending item still hold their original requests.
    expect((await runtime.storage.readWork(workItemId("done")))!.work.request.moduleId).toBe(b);
    expect((await runtime.storage.readWork(workItemId("waiting")))!.work.request.payload).toEqual({ tag: "waiting" });
  });

  test("identical emissions are one work item: repeats within an operation or of stored work consume no sequence", async () => {
    const runtime = runtimeWithRandom();
    await runtime.scheduler.schedule(work("done", 10, b));
    await runtime.scheduler.advanceTo(simTime(10), 10, through(runtime));
    await runtime.scheduler.schedule(work("waiting", 30, b, { tag: "waiting" }));
    await runtime.scheduler.schedule(work("source", 10, a, { tag: "source" }));

    const repeats: OperationHandler = (request, state, random, emitter) => {
      step(request, state, random, emitter);
      emitter!.emit(work("new", 20, b, { k: [1, { x: 2, y: 3 }] }));
      emitter!.emit(work("new", 20, b, { k: [1, { y: 3, x: 2 }] })); // same request, keys reordered
      expect(() => emitter!.emit(work("new", 20, b, { k: [{ x: 2, y: 3 }, 1] }))).toThrow(WorkIdConflictError);
      emitter!.emit(work("waiting", 30, b, { tag: "waiting" })); // identical to stored pending work
      emitter!.emit(work("done", 10, b)); // identical to a stored receipt
      emitter!.emit(work("source", 10, a, { tag: "source" })); // identical to the item being executed
    };
    await runtime.scheduler.advanceTo(simTime(10), 10, through(runtime, [], repeats));

    expect(await queue(runtime)).toEqual([
      ["new", 20, 3, b],
      ["waiting", 30, 1, b],
    ]);
    expect(await runtime.storage.readNextSequence()).toBe(4);
    expect(await runtime.storage.readWorkIdStatus(workItemId("source"))).toBe("completed");
  });

  test("schedule() still rejects during advanceTo(), from a handler or a callback", async () => {
    const runtime = runtimeWithRandom();
    await runtime.scheduler.schedule(work("source", 10));
    const attempts: Promise<unknown>[] = [];
    const schedulesDirectly: OperationHandler = (request, state, random, emitter) => {
      step(request, state, random, emitter);
      attempts.push(runtime.scheduler.schedule(work("from-handler", 10)));
    };
    await runtime.scheduler.advanceTo(simTime(10), 10, (w) => {
      through(runtime, [], schedulesDirectly)(w);
      attempts.push(runtime.scheduler.schedule(work("from-callback", 10)));
      attempts.push(runtime.storage.insertPending({ ...work("raw", 10), sequence: 99, request: { ...work("raw", 10).request, payload: null } }, 100));
    });
    for (const attempt of attempts) await expect(attempt).rejects.toThrow();
    await expect(attempts[0]!).rejects.toThrow("Cannot schedule work while advanceTo() is dispatching");
    await expect(attempts[2]!).rejects.toThrow("while a work item is running");
    expect(await runtime.scheduler.pendingCount()).toBe(0);
    expect(await runtime.storage.readNextSequence()).toBe(1);
  });

  test("the emitter tells the operation's time, and like the rest of an operation is unusable once its handler returns", async () => {
    const runtime = runtimeWithRandom();
    await runtime.scheduler.schedule(work("ok", 10));
    await runtime.scheduler.schedule(work("fails", 20, a, { fail: true }));
    const kept: WorkEmitter[] = [];
    const keeps: OperationHandler = (request, _state, _random, emitter) => {
      kept.push(emitter!);
      if ((request.payload as { fail?: boolean }).fail) throw new Error("fail");
    };
    await runtime.scheduler.advanceTo(simTime(10), 10, (w) => {
      runtime.execute(registry, w.request, keeps);
      // The item has not committed yet, but its handler has returned.
      expect(() => kept[0]!.emit(work("late", 10))).toThrow("Work emitter is no longer valid");
    });
    expect(kept[0]!.now).toBe(simTime(10));
    expect(Object.isFrozen(kept[0])).toBe(true);
    await expect(runtime.scheduler.advanceTo(simTime(20), 10, through(runtime, [], keeps))).rejects.toThrow("fail");
    expect(kept[1]!.now).toBe(simTime(20));
    for (const emitter of kept) expect(() => emitter.emit(work("late", 30))).toThrow("Work emitter is no longer valid");
    expect(await queue(runtime)).toEqual([["fails", 20, 1, a]]);
  });

  test("execute() runs only inside a callback of the runtime's scheduler, once per item", async () => {
    const runtime = runtimeWithRandom();
    expect(() => runtime.execute(registry, work("w", 0).request, step)).toThrow("can only run inside an advanceTo() callback");
    await runtime.scheduler.schedule(work("w", 5));
    await expect(
      runtime.scheduler.advanceTo(simTime(5), 1, (w) => {
        runtime.execute(registry, w.request, step);
        runtime.execute(registry, w.request, step);
      }),
    ).rejects.toThrow("only one operation per work item");
    expect(runtime.read(a, "log")).toBeUndefined();
    // A rejected request runs no handler and stages nothing; the callback decides whether that fails the item.
    expect(
      await runtime.scheduler.advanceTo(simTime(5), 1, (w) => {
        expect(runtime.execute(registry, { ...w.request, operation: "unknown" }, step)).toEqual({
          ok: false,
          reason: "unknown-operation",
        });
      }),
    ).toEqual({ now: simTime(5), executed: 1, reachedTarget: true });
    expect(runtime.read(a, "log")).toBeUndefined();
  });

  test("a new runtime validates its start and has no random stream unless given one", async () => {
    expect(() => createInMemoryOperationRuntime(loose(-1))).toThrow(RangeError);
    expect(() => createInMemoryOperationRuntime(simTime(0), loose({ algorithm: "xoshiro128ss-v1", words: [0, 0, 0, -0] }))).toThrow(RangeError);
    const runtime = createInMemoryOperationRuntime(simTime(7));
    expect(await runtime.scheduler.now()).toBe(simTime(7));
    expect(runtime.randomSnapshot()).toBeUndefined();
    expect(Object.keys(runtime).sort()).toEqual(["execute", "randomSnapshot", "read", "scheduler", "storage"]);
  });
});

describe("admitting emitted work", () => {
  function storage(stored: Record<string, StoredWork & { status: "pending" | "completed" }>, next: number) {
    return {
      async readWork(id: string) {
        const found = stored[id];
        return found === undefined ? undefined : { status: found.status, work: found };
      },
      async readNextSequence() {
        return next;
      },
    };
  }
  const item = (id: string) => ({ id: workItemId(id), at: simTime(1), request: { ...work(id, 1).request, payload: null } });

  test("sequences start at the stored next sequence and must stay safe integers with a next sequence above them", async () => {
    expect(await admitEmittedWork(storage({}, MAX - 2), [item("x"), item("y")])).toEqual({
      admitted: [
        { ...item("x"), sequence: MAX - 2 },
        { ...item("y"), sequence: MAX - 1 },
      ],
    });
    const result = await admitEmittedWork(storage({}, MAX - 1), [item("x"), item("y")]);
    expect("rejected" in result && result.rejected).toBeInstanceOf(RangeError);
  });

  test("nothing new reads no sequence, and a storage error rejects instead of being reported as a rejection", async () => {
    let reads = 0;
    const counting = {
      ...storage({ x: { ...item("x"), sequence: 0, status: "completed" } }, 5),
      async readNextSequence() {
        reads++;
        return 5;
      },
    };
    expect(await admitEmittedWork(counting, [item("x")])).toEqual({ admitted: [] });
    expect(reads).toBe(0);
    const failing = { ...counting, readWork: async () => Promise.reject(new Error("storage down")) };
    await expect(admitEmittedWork(failing, [item("y")])).rejects.toThrow("storage down");
  });
});
