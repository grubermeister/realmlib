import { describe, expect, test } from "bun:test";
import {
  createInMemoryScheduler,
  createInMemorySchedulerStorage,
  createScheduler,
  moduleId,
  simTime,
  workItemId,
} from "../src/index.ts";
import type { ScheduledWork, SimTime } from "../src/index.ts";
import { describeSchedulerStorageContract } from "./scheduler-storage-contract.ts";

describeSchedulerStorageContract("in-memory", (initialTime) => createInMemorySchedulerStorage(initialTime));

function work(id: string, at: number): ScheduledWork {
  return {
    id: workItemId(id),
    at: simTime(at),
    request: { moduleId: moduleId("module-a"), operation: "op-x", payloadVersion: 1, payload: null },
  };
}

describe("in-memory scheduler storage", () => {
  test("defaults to clock 0 and rejects invalid initial times, including -0", async () => {
    expect(await createInMemorySchedulerStorage().readClock()).toBe(simTime(0));
    for (const value of [-0, -1, 1.5, Number.NaN]) {
      expect(() => createInMemorySchedulerStorage(value as SimTime)).toThrow(RangeError);
    }
    expect(() => createInMemorySchedulerStorage("5" as unknown as SimTime)).toThrow(TypeError);
  });

  test("instances share no state", async () => {
    const first = createInMemorySchedulerStorage();
    const second = createInMemorySchedulerStorage();
    await createScheduler(first).schedule(work("w1", 10));
    expect(await second.countPending()).toBe(0);
    expect(await second.readNextSequence()).toBe(0);
    expect(await second.readWorkIdStatus(workItemId("w1"))).toBeUndefined();
  });

  test("createInMemoryScheduler uses fresh storage at the given time", async () => {
    const scheduler = createInMemoryScheduler(simTime(7));
    expect(await scheduler.now()).toBe(simTime(7));
    expect(await scheduler.pendingCount()).toBe(0);
  });

  test("ordering holds through many inserts and out-of-order completions", async () => {
    const storage = createInMemorySchedulerStorage();
    const request = { moduleId: moduleId("module-a"), operation: "op-x", payloadVersion: 1, payload: null };
    const expected: [number, number][] = [];
    let seed = 7;
    for (let sequence = 0; sequence < 300; sequence++) {
      seed = (seed * 31 + 11) % 97;
      await storage.insertPending({ id: workItemId(`w${sequence}`), at: simTime(seed % 40), sequence, request }, sequence + 1);
      expected.push([seed % 40, sequence]);
    }
    expected.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    // Complete every third item in its due order, wherever it sits in the heap.
    for (const [, sequence] of expected.filter((_, index) => index % 3 === 1)) {
      await storage.markCompleted(workItemId(`w${sequence}`));
    }
    const remaining = expected.filter((_, index) => index % 3 !== 1);
    const due = await storage.readDue(simTime(Number.MAX_SAFE_INTEGER), 1_000);
    expect(due.map((w) => [w.at, w.sequence])).toEqual(remaining);
    expect(await storage.countPending()).toBe(remaining.length);
  });
});
