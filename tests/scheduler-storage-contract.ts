/**
 * Reusable behavioral tests for {@link SchedulerStorage} implementations.
 *
 * Call {@link describeSchedulerStorageContract} from a `*.test.ts` file with a
 * factory that returns fresh, empty storage at the given clock. The same cases
 * then run against that implementation, both directly and through
 * `createScheduler()`.
 */

import { describe, expect, test } from "bun:test";
import { WorkIdConflictError, createScheduler, moduleId, simTime, workItemId } from "../src/index.ts";
import type { ModuleId, ScheduledWork, SchedulerStorage, SimTime, StateValue, StoredWork, WorkItemId } from "../src/index.ts";

export type SchedulerStorageFactory = (initialTime: SimTime) => SchedulerStorage | Promise<SchedulerStorage>;

const a = moduleId("module-a");

function request(payload: StoredWork["request"]["payload"] = { n: 1 }): StoredWork["request"] {
  return { moduleId: a, operation: "op-x", payloadVersion: 1, payload };
}

function stored(id: string, at: number, sequence: number, payload?: StoredWork["request"]["payload"]): StoredWork {
  return { id: workItemId(id), at: simTime(at), sequence, request: request(payload) };
}

function work(id: string, at: number, payload?: StoredWork["request"]["payload"]): ScheduledWork {
  return { id: workItemId(id), at: simTime(at), request: request(payload) };
}

/** Bypasses static types to exercise runtime validation. */
function loose<T>(value: unknown): T {
  return value as T;
}

async function dueIds(storage: SchedulerStorage, until = Number.MAX_SAFE_INTEGER, limit = 1_000): Promise<string[]> {
  return (await storage.readDue(simTime(until), limit)).map((w) => w.id);
}

/** Everything a scheduler can observe in storage, for checking that a call changed nothing. */
async function snapshot(storage: SchedulerStorage, ids: string[]) {
  return {
    clock: await storage.readClock(),
    nextSequence: await storage.readNextSequence(),
    pending: await storage.countPending(),
    due: await storage.readDue(simTime(Number.MAX_SAFE_INTEGER), 1_000),
    records: await Promise.all(ids.map((id) => storage.readWork(workItemId(id)))),
  };
}

/** Variants of `base` that differ in exactly one identity-bearing field. */
function conflicting(base: ScheduledWork): [string, ScheduledWork][] {
  const { request } = base;
  return [
    ["time", { ...base, at: simTime(base.at + 1) }],
    ["module", { ...base, request: { ...request, moduleId: moduleId("module-b") } }],
    ["operation", { ...base, request: { ...request, operation: "op-y" } }],
    ["payload version", { ...base, request: { ...request, payloadVersion: 2 } }],
    ["payload", { ...base, request: { ...request, payload: { n: 2 } } }],
  ];
}

async function runAll(storage: SchedulerStorage, target: number, max = 1_000): Promise<string[]> {
  const ids: string[] = [];
  await createScheduler(storage).advanceTo(simTime(target), max, (w) => void ids.push(w.id));
  return ids;
}

export function describeSchedulerStorageContract(name: string, create: SchedulerStorageFactory): void {
  const fresh = (initialTime = 0) => Promise.resolve(create(simTime(initialTime)));

  describe(`${name}: scheduler storage contract`, () => {
    test("fresh storage has the initial clock, sequence 0, and no work", async () => {
      for (const initial of [0, 1_500]) {
        const storage = await fresh(initial);
        expect(await storage.readClock()).toBe(simTime(initial));
        expect(await storage.readNextSequence()).toBe(0);
        expect(await storage.countPending()).toBe(0);
        expect(await dueIds(storage)).toEqual([]);
        expect(await storage.readWorkIdStatus(workItemId("w1"))).toBeUndefined();
      }
    });

    test("the clock is written and read back, and invalid times including -0 are rejected", async () => {
      const storage = await fresh();
      await storage.writeClock(simTime(42));
      expect(await storage.readClock()).toBe(simTime(42));
      const invalid: [unknown, RangeErrorConstructor | TypeErrorConstructor][] = [
        [-0, RangeError],
        [-1, RangeError],
        [1.5, RangeError],
        ["5", TypeError],
      ];
      for (const [value, error] of invalid) {
        await expect(storage.writeClock(loose<SimTime>(value))).rejects.toThrow(error);
      }
      expect(await storage.readClock()).toBe(simTime(42));
    });

    test("inserted work is pending, advances the next sequence, and reads back as a copy", async () => {
      const storage = await fresh();
      const input = stored("w1", 10, 0, { list: [1] });
      await storage.insertPending(input, 1);
      (input.request.payload as { list: number[] }).list.push(2);

      expect(await storage.readWorkIdStatus(workItemId("w1"))).toBe("pending");
      expect(await storage.readNextSequence()).toBe(1);
      expect(await storage.countPending()).toBe(1);
      const [first] = await storage.readDue(simTime(10), 1);
      expect(first).toEqual(stored("w1", 10, 0, { list: [1] }));

      (first!.request.payload as { list: number[] }).list.push(3);
      expect((await storage.readDue(simTime(10), 1))[0]).toEqual(stored("w1", 10, 0, { list: [1] }));
    });

    test("due work is read in (time, sequence) order, bounded by time and count, without removal", async () => {
      const storage = await fresh();
      const inserts: [string, number][] = [
        ["t20-1", 20],
        ["t10-1", 10],
        ["t20-2", 20],
        ["t30-1", 30],
        ["t10-2", 10],
      ];
      for (const [index, [id, at]] of inserts.entries()) await storage.insertPending(stored(id, at, index), index + 1);

      expect(await dueIds(storage)).toEqual(["t10-1", "t10-2", "t20-1", "t20-2", "t30-1"]);
      expect(await dueIds(storage, 20)).toEqual(["t10-1", "t10-2", "t20-1", "t20-2"]);
      expect(await dueIds(storage, 20, 3)).toEqual(["t10-1", "t10-2", "t20-1"]);
      expect(await dueIds(storage, 9)).toEqual([]);
      expect(await storage.countPending()).toBe(5);
    });

    test("readDue rejects invalid times and limits, including -0", async () => {
      const storage = await fresh();
      await expect(storage.readDue(loose<SimTime>(-0), 1)).rejects.toThrow(RangeError);
      for (const limit of [0, -0, -1, 1.5, Number.NaN]) {
        await expect(storage.readDue(simTime(0), limit)).rejects.toThrow(RangeError);
      }
      await expect(storage.readDue(simTime(0), loose<number>("1"))).rejects.toThrow(TypeError);
    });

    test("a -0 sequence is rejected even when the next sequence is 0, and changes nothing", async () => {
      const storage = await fresh();
      await expect(storage.insertPending(stored("w1", 10, -0), 1)).rejects.toThrow(RangeError);
      await expect(storage.insertPending(stored("w1", 10, 0), -0)).rejects.toThrow(RangeError);
      expect(await storage.readNextSequence()).toBe(0);
      expect(await storage.readWorkIdStatus(workItemId("w1"))).toBeUndefined();
      await storage.insertPending(stored("w1", 10, 0), 1);
      expect(Object.is((await storage.readDue(simTime(10), 1))[0]!.sequence, 0)).toBe(true);
    });

    test("completion removes pending work, keeps its ID occupied, and leaves the sequence alone", async () => {
      const storage = await fresh();
      for (const [index, id] of ["w1", "w2", "w3"].entries()) await storage.insertPending(stored(id, 10, index), index + 1);

      await storage.markCompleted(workItemId("w2"));
      expect(await storage.readWorkIdStatus(workItemId("w2"))).toBe("completed");
      expect(await storage.countPending()).toBe(2);
      expect(await storage.readNextSequence()).toBe(3);
      expect(await dueIds(storage)).toEqual(["w1", "w3"]);

      await storage.markCompleted(workItemId("w1"));
      expect(await dueIds(storage)).toEqual(["w3"]);
      expect(await storage.readWorkIdStatus(workItemId("w1"))).toBe("completed");
      expect(await storage.readWorkIdStatus(workItemId("w3"))).toBe("pending");
    });

    test("completing work that is not pending is rejected", async () => {
      const storage = await fresh();
      await storage.insertPending(stored("w1", 10, 0), 1);
      await storage.markCompleted(workItemId("w1"));
      for (const id of ["w1", "unknown"]) {
        await expect(storage.markCompleted(workItemId(id))).rejects.toThrow(Error);
      }
      expect(await storage.readWorkIdStatus(workItemId("unknown"))).toBeUndefined();
    });

    test("inserting an occupied ID or a non-increasing sequence is rejected and changes nothing", async () => {
      const storage = await fresh();
      await storage.insertPending(stored("pending", 10, 0), 1);
      await storage.insertPending(stored("done", 10, 1), 2);
      await storage.markCompleted(workItemId("done"));

      await expect(storage.insertPending(stored("pending", 20, 2), 3)).rejects.toThrow(Error);
      await expect(storage.insertPending(stored("done", 20, 2), 3)).rejects.toThrow(Error);
      await expect(storage.insertPending(stored("w3", 20, 1), 3)).rejects.toThrow(RangeError);
      await expect(storage.insertPending(stored("w3", 20, 2), 2)).rejects.toThrow(RangeError);
      await expect(storage.insertPending(stored("w3", 20, 2), 2.5)).rejects.toThrow(RangeError);

      expect(await storage.readNextSequence()).toBe(2);
      expect(await dueIds(storage)).toEqual(["pending"]);
      expect(await storage.readWorkIdStatus(workItemId("w3"))).toBeUndefined();
    });
  });

  describe(`${name}: scheduler over storage`, () => {
    test("runs work by due time, then by sequence", async () => {
      const storage = await fresh();
      const scheduler = createScheduler(storage);
      for (const [id, at] of [["t20-1", 20], ["t10-1", 10], ["t20-2", 20], ["t10-2", 10]] as const) {
        await scheduler.schedule(work(id, at));
      }
      expect(await runAll(storage, 100)).toEqual(["t10-1", "t10-2", "t20-1", "t20-2"]);
    });

    test("schedule assigns consecutive sequences and records them in storage", async () => {
      const storage = await fresh();
      const scheduler = createScheduler(storage);
      await scheduler.schedule(work("w1", 20));
      await expect(scheduler.schedule(work("w1", 21))).rejects.toThrow("is already pending");
      await scheduler.schedule(work("w2", 10));
      expect((await storage.readDue(simTime(100), 10)).map((w): [string, number] => [w.id, w.sequence])).toEqual([
        ["w2", 1],
        ["w1", 0],
      ]);
      expect(await storage.readNextSequence()).toBe(2);
    });

    test("a new scheduler continues from the stored clock, queue, and sequence", async () => {
      const storage = await fresh();
      const first = createScheduler(storage);
      await first.schedule(work("w1", 10));
      await first.schedule(work("w2", 50));
      await first.schedule(work("w3", 50));
      await first.advanceTo(simTime(20), 10, () => {});

      const second = createScheduler(storage);
      expect(await second.now()).toBe(simTime(20));
      expect(await second.pendingCount()).toBe(2);
      await expect(second.schedule(work("past", 19))).rejects.toThrow(RangeError);
      await second.schedule(work("w4", 50));
      expect(await storage.readNextSequence()).toBe(4);
      expect(await runAll(storage, 50)).toEqual(["w2", "w3", "w4"]);
    });

    test("the sequence does not restart after the queue empties, even across schedulers", async () => {
      const storage = await fresh();
      const first = createScheduler(storage);
      await first.schedule(work("w1", 10));
      await first.schedule(work("w2", 10));
      await first.advanceTo(simTime(10), 10, () => {});
      expect(await storage.countPending()).toBe(0);

      const second = createScheduler(storage);
      await second.schedule(work("w3", 10));
      expect((await storage.readDue(simTime(10), 1))[0]!.sequence).toBe(2);
      expect(await storage.readNextSequence()).toBe(3);
    });

    test("duplicate IDs are rejected while pending and after completion, across schedulers", async () => {
      const storage = await fresh();
      const first = createScheduler(storage);
      await first.schedule(work("done", 10));
      await first.schedule(work("pending", 30));
      await first.advanceTo(simTime(20), 10, () => {});

      const second = createScheduler(storage);
      await expect(second.schedule(work("done", 40))).rejects.toThrow("has already completed");
      await expect(second.schedule(work("pending", 40))).rejects.toThrow("is already pending");
      expect(await storage.readNextSequence()).toBe(2);
      await second.schedule(work("other", 40));
      expect(await runAll(storage, 40)).toEqual(["pending", "other"]);
      await expect(createScheduler(storage).schedule(work("pending", 50))).rejects.toThrow("has already completed");
    });

    test("bounded advancement leaves the backlog in storage for the next scheduler", async () => {
      const storage = await fresh();
      const first = createScheduler(storage);
      for (const [id, at] of [["w1", 10], ["w2", 20], ["w3", 20], ["w4", 30]] as const) await first.schedule(work(id, at));
      expect(await first.advanceTo(simTime(50), 2, () => {})).toEqual({ now: simTime(20), executed: 2, reachedTarget: false });
      expect(await storage.readClock()).toBe(simTime(20));
      expect(await dueIds(storage)).toEqual(["w3", "w4"]);

      const second = createScheduler(storage);
      const ids: string[] = [];
      expect(await second.advanceTo(simTime(50), 5, (w) => void ids.push(w.id))).toEqual({
        now: simTime(50),
        executed: 2,
        reachedTarget: true,
      });
      expect(ids).toEqual(["w3", "w4"]);
      expect(await storage.readClock()).toBe(simTime(50));
    });

    test("a failed callback leaves its item pending at the head, the clock at its time, and the sequence alone", async () => {
      const storage = await fresh();
      const first = createScheduler(storage);
      for (const [id, at] of [["w1", 10], ["w2", 20], ["w3", 20]] as const) await first.schedule(work(id, at));
      await expect(
        first.advanceTo(simTime(50), 10, (w) => {
          if (w.id === "w2") throw new Error("fail");
        }),
      ).rejects.toThrow("fail");

      expect(await storage.readClock()).toBe(simTime(20));
      expect(await storage.readNextSequence()).toBe(3);
      expect(await storage.readWorkIdStatus(workItemId("w1"))).toBe("completed");
      expect(await storage.readWorkIdStatus(workItemId("w2"))).toBe("pending");
      expect(await runAll(storage, 50)).toEqual(["w2", "w3"]);
    });

    test("invalid times and counts, including -0, are rejected without changing storage", async () => {
      const storage = await fresh();
      const scheduler = createScheduler(storage);
      await scheduler.schedule(work("w1", 0));
      await expect(scheduler.schedule(loose<ScheduledWork>({ ...work("w2", 0), at: -0 }))).rejects.toThrow(RangeError);
      await expect(scheduler.advanceTo(loose<SimTime>(-0), 1, () => {})).rejects.toThrow(RangeError);
      await expect(scheduler.advanceTo(simTime(10), -0, () => {})).rejects.toThrow(RangeError);
      expect(await storage.readClock()).toBe(simTime(0));
      expect(await storage.readNextSequence()).toBe(1);
      expect(await dueIds(storage)).toEqual(["w1"]);
      expect(await storage.readWorkIdStatus(loose<WorkItemId>("w2"))).toBeUndefined();
    });

    test("IDs and operation names with U+0000 or unpaired surrogates are rejected without changing storage", async () => {
      const storage = await fresh();
      const scheduler = createScheduler(storage);
      for (const text of ["w\u0000", "w\ud800", "\udc00w"]) {
        await expect(scheduler.schedule(loose<ScheduledWork>({ ...work("w1", 0), id: text }))).rejects.toThrow(RangeError);
        const bad = { ...work("w1", 0), request: { ...request(), operation: text } };
        await expect(scheduler.schedule(bad)).rejects.toThrow(RangeError);
        const badModule = { ...work("w1", 0), request: { ...request(), moduleId: loose<ModuleId>(text) } };
        await expect(scheduler.schedule(badModule)).rejects.toThrow(RangeError);
      }
      expect(await storage.readNextSequence()).toBe(0);
      expect(await storage.countPending()).toBe(0);

      // A well-formed surrogate pair is ordinary text and round-trips.
      const emoji = { id: workItemId("w\ud83d\ude00"), at: simTime(0), request: { ...request(), operation: "op\ud83d\ude00" } };
      await scheduler.schedule(emoji);
      expect(await storage.readDue(simTime(0), 1)).toEqual([{ ...emoji, sequence: 0 }]);
    });
  });

  describe(`${name}: work identity and resubmission`, () => {
    test("readWork returns pending work and, after completion, its original request, as copies", async () => {
      const storage = await fresh();
      expect(await storage.readWork(workItemId("w1"))).toBeUndefined();
      await storage.insertPending(stored("w1", 10, 0, { list: [1], nested: { k: "v" } }), 1);
      const pending = await storage.readWork(workItemId("w1"));
      expect(pending).toEqual({ status: "pending", work: stored("w1", 10, 0, { list: [1], nested: { k: "v" } }) });
      (pending!.work.request.payload as { list: number[] }).list.push(2);

      await storage.writeClock(simTime(10));
      await storage.markCompleted(workItemId("w1"));
      expect(await storage.readWork(workItemId("w1"))).toEqual({
        status: "completed",
        work: stored("w1", 10, 0, { list: [1], nested: { k: "v" } }),
      });
      expect(await storage.readWork(workItemId("W1"))).toBeUndefined();
    });

    test("an identical pending resubmission is a no-op that keeps the original sequence and position", async () => {
      const storage = await fresh();
      const scheduler = createScheduler(storage);
      expect(await scheduler.schedule(work("w1", 20))).toBe("accepted");
      expect(await scheduler.schedule(work("w2", 20))).toBe("accepted");
      const before = await snapshot(storage, ["w1", "w2"]);
      expect(await scheduler.schedule(work("w1", 20))).toBe("already-pending");
      expect(await createScheduler(storage).schedule(work("w1", 20))).toBe("already-pending");
      expect(await snapshot(storage, ["w1", "w2"])).toEqual(before);
      expect(before.nextSequence).toBe(2);
      expect(await runAll(storage, 20)).toEqual(["w1", "w2"]);
    });

    test("different work under a pending ID is rejected as a conflict and changes nothing", async () => {
      const storage = await fresh();
      const scheduler = createScheduler(storage);
      const original = work("w1", 20);
      await scheduler.schedule(original);
      const before = await snapshot(storage, ["w1"]);
      for (const [field, variant] of conflicting(original)) {
        const failure = await scheduler.schedule(variant).catch((e: unknown) => e);
        expect({ field, failure }).toEqual({ field, failure: expect.any(WorkIdConflictError) });
        expect((failure as WorkIdConflictError).status).toBe("pending");
        expect((failure as Error).message).toContain("is already pending");
      }
      expect(await snapshot(storage, ["w1"])).toEqual(before);
      expect(await scheduler.schedule(original)).toBe("already-pending");
    });

    test("an identical completed resubmission is recognized without running or changing anything, across schedulers", async () => {
      const storage = await fresh();
      const first = createScheduler(storage);
      const original = work("done", 10);
      await first.schedule(original);
      await first.schedule(work("later", 30));
      expect(await runAll(storage, 20)).toEqual(["done"]);
      const before = await snapshot(storage, ["done", "later"]);
      expect(before.clock).toBe(simTime(20));

      for (const scheduler of [first, createScheduler(storage)]) {
        // Its time is now in the past; that does not matter for a recognized retry.
        expect(await scheduler.schedule(original)).toBe("already-completed");
        for (const [field, variant] of conflicting(original)) {
          const failure = await scheduler.schedule(variant).catch((e: unknown) => e);
          expect({ field, failure }).toEqual({ field, failure: expect.any(WorkIdConflictError) });
          expect((failure as WorkIdConflictError).status).toBe("completed");
          expect((failure as Error).message).toContain("has already completed");
        }
      }
      expect(await snapshot(storage, ["done", "later"])).toEqual(before);
      expect(await runAll(storage, 20)).toEqual([]);
      expect(await runAll(storage, 30)).toEqual(["later"]);
    });

    test("payload identity is structural: key order does not matter, any nested difference does", async () => {
      const storage = await fresh();
      const scheduler = createScheduler(storage);
      const payload: StateValue = { a: 1, b: { c: [1, { d: "x", e: null }], f: true }, g: [] };
      await scheduler.schedule(work("w1", 10, payload));
      const before = await snapshot(storage, ["w1"]);

      const reordered = { g: [], b: { f: true, c: [1, { e: null, d: "x" }] }, a: 1 };
      expect(await scheduler.schedule(work("w1", 10, reordered))).toBe("already-pending");
      const nullPrototype = Object.assign(Object.create(null) as Record<string, StateValue>, payload);
      expect(await scheduler.schedule(work("w1", 10, nullPrototype))).toBe("already-pending");

      const different: StateValue[] = [
        { a: 1, b: { c: [1, { d: "y", e: null }], f: true }, g: [] },
        { a: 1, b: { c: [1, { d: "x", e: false }], f: true }, g: [] },
        { a: 1, b: { c: [{ d: "x", e: null }, 1], f: true }, g: [] },
        { a: 1, b: { c: [1, { d: "x" }], f: true }, g: [] },
        { a: 1, b: { c: [1, { d: "x", e: null, z: null }], f: true }, g: [] },
        { a: "1", b: { c: [1, { d: "x", e: null }], f: true }, g: [] },
        { a: 1, b: { c: [1, { d: "x", e: null }], f: true }, g: {} },
        { a: 1, b: { c: { 0: 1, 1: { d: "x", e: null } }, f: true }, g: [] },
        { a: 1, b: { c: [1, { d: "x", e: null }], f: true } },
        [payload],
        null,
      ];
      for (const variant of different) {
        await expect(scheduler.schedule(work("w1", 10, variant))).rejects.toBeInstanceOf(WorkIdConflictError);
      }
      expect(await snapshot(storage, ["w1"])).toEqual(before);
    });

    test("invalid resubmissions, including nested -0, are rejected by validation before any identity match", async () => {
      const storage = await fresh();
      const scheduler = createScheduler(storage);
      await scheduler.schedule(work("w1", 0, { list: [0, 1] }));
      await scheduler.schedule(work("w2", 0, 0));
      const before = await snapshot(storage, ["w1", "w2"]);
      // Each would serialize to the stored JSON or compare equal with ===, if validation ran later.
      const invalid: [ScheduledWork, new (...args: never[]) => Error][] = [
        [work("w1", 0, { list: [-0, 1] }), TypeError],
        [work("w2", 0, -0), TypeError],
        [work("w1", 0, { list: [0, 1], extra: loose<StateValue>(undefined) }), TypeError],
        [{ ...work("w1", 0, { list: [0, 1] }), at: loose<SimTime>(-0) }, RangeError],
        [{ ...work("w1", 0, { list: [0, 1] }), request: { ...request({ list: [0, 1] }), payloadVersion: -0 } }, RangeError],
        // Valid, and not trimmed to match: text is compared exactly.
        [{ ...work("w1", 0, { list: [0, 1] }), request: { ...request({ list: [0, 1] }), operation: " op-x" } }, WorkIdConflictError],
      ];
      for (const [variant, error] of invalid) {
        await expect(scheduler.schedule(variant)).rejects.toBeInstanceOf(error);
      }
      expect(await snapshot(storage, ["w1", "w2"])).toEqual(before);
    });
  });
}
