import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import {
  CommitNotConfirmedError,
  CommitOutcomeUnknownError,
  createInMemoryScheduler,
  createInMemoryStateStore,
  createModuleRegistry,
  createPostgresSchedulerStorage,
  createScheduler,
  createSeededRandom,
  executeInMemoryOperation,
  initializePostgresSchedulerStorage,
  loadPostgresOperationRuntime,
  moduleId,
  simTime,
  workItemId,
} from "../src/index.ts";
import type {
  OperationHandler,
  PostgresOperationRuntime,
  PostgresQueryable,
  RandomSnapshot,
  ScheduledWork,
  SchedulerStorage,
  StateValue,
  StoredWork,
} from "../src/index.ts";
import { describeSchedulerStorageContract } from "./scheduler-storage-contract.ts";

// Opt-in: runs only against a separate, disposable database named by this variable.
const databaseUrl = process.env.REALMLIB_TEST_DATABASE_URL;
const repoRoot = await realpath(join(import.meta.dir, ".."));
const MAX = Number.MAX_SAFE_INTEGER;

const a = moduleId("module-a");
const b = moduleId("module-b");
const SEED = 20_261_023;

const registry = createModuleRegistry();
registry.register({ id: a, operations: [{ name: "op-x", version: 1, validatePayload: () => true }] });
registry.register({ id: b, operations: [{ name: "op-x", version: 1, validatePayload: () => true }] });

/** Bypasses static types to exercise runtime validation. */
function loose<T>(value: unknown): T {
  return value as T;
}

function work(id: string, at: number, owner = a, payload: StateValue = { n: 1 }): ScheduledWork {
  return { id: workItemId(id), at: simTime(at), request: { moduleId: owner, operation: "op-x", payloadVersion: 1, payload } };
}

/** Increments `count`, stores one draw under `roll`, and records the work's payload under `last`. */
const countAndRoll: OperationHandler = (request, state, random) => {
  const count = (state.get(request.moduleId, "count") as number | undefined) ?? 0;
  state.set("count", count + 1);
  state.set("roll", random!.nextFloat());
  state.set("last", request.payload as StateValue);
};

/** Stages a change and a draw, then fails. */
const stageThenThrow: OperationHandler = (request, state, random) => {
  state.set("count", 1_000);
  random!.nextFloat();
  throw new Error("handler failed after staging");
};

/** An `advanceTo()` callback that runs `handler` through `runtime`, throwing on rejection. */
function through(runtime: PostgresOperationRuntime, handler: OperationHandler = countAndRoll) {
  return (w: ScheduledWork): void => {
    const outcome = runtime.execute(registry, w.request, handler);
    if (!outcome.ok) throw new Error(`rejected: ${outcome.reason}`);
  };
}

/**
 * What the in-memory path commits for the same operations: the reference that
 * the PostgreSQL path must agree with.
 */
function inMemoryReference(payloads: StateValue[], seed = SEED) {
  const store = createInMemoryStateStore();
  const random = createSeededRandom(seed);
  for (const payload of payloads) {
    const outcome = executeInMemoryOperation(
      registry,
      store,
      { moduleId: a, operation: "op-x", payloadVersion: 1, payload },
      countAndRoll,
      random,
    );
    expect(outcome.ok).toBe(true);
  }
  const view = store.forModule(a);
  return {
    records: { count: view.get(a, "count"), roll: view.get(a, "roll"), last: view.get(a, "last") },
    random: random.snapshot(),
  };
}

/** A client whose responses are canned by statement prefix; never touches a database. */
function stubClient(): PostgresQueryable & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async query(text) {
      calls.push(text);
      if (text.startsWith("SELECT random_snapshot")) return { rows: [{ value: null, format_version: "1" }] };
      return { rows: [] };
    },
  };
}

describe("PostgreSQL operation runtime without a database", () => {
  test("a pg Pool or an object without query() is refused before any statement", async () => {
    const poolLike = Object.assign(stubClient(), { totalCount: 0, idleCount: 0 });
    await expect(loadPostgresOperationRuntime(poolLike)).rejects.toThrow("not a Pool");
    expect(poolLike.calls).toEqual([]);
    for (const value of [undefined, null, {}, { query: 1 }]) {
      await expect(loadPostgresOperationRuntime(loose<PostgresQueryable>(value))).rejects.toThrow(TypeError);
    }
  });

  test("execute() outside a callback of the runtime's scheduler throws and stages nothing", async () => {
    const client = stubClient();
    const runtime = await loadPostgresOperationRuntime(client);
    let called = false;
    expect(() =>
      runtime.execute(registry, work("w", 0).request, () => {
        called = true;
      }),
    ).toThrow("can only run inside an advanceTo() callback");
    expect(called).toBe(false);
    expect(runtime.randomSnapshot()).toBeUndefined();
    expect(client.calls).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      expect.stringContaining("SELECT random_snapshot"),
      expect.stringContaining("FROM realmlib.state_records"),
      "COMMIT",
    ]);
  });

  test("initialization validates the random snapshot, including -0, before any statement", async () => {
    const client = stubClient();
    const invalid = [
      { algorithm: "xoshiro128ss-v1", words: [-0, 1, 2, 3] },
      { algorithm: "xoshiro128ss-v1", words: [0, 0, 0, 0] },
      { algorithm: "other", words: [1, 2, 3, 4] },
    ];
    for (const snapshot of invalid) {
      await expect(initializePostgresSchedulerStorage(client, simTime(0), loose<RandomSnapshot>(snapshot))).rejects.toThrow(
        RangeError,
      );
    }
    expect(client.calls).toEqual([]);
  });

  test("the scheduler hands each item to storage.runWork() instead of separate clock and completion writes", async () => {
    const calls: string[] = [];
    const queue: StoredWork[] = [
      { id: workItemId("w1"), at: simTime(5), sequence: 0, request: { ...work("w1", 5).request, payload: null } },
    ];
    let clock = simTime(0);
    const storage: SchedulerStorage = {
      async readClock() {
        return clock;
      },
      async writeClock(now) {
        calls.push(`writeClock ${now}`);
        clock = now;
      },
      async readNextSequence() {
        return 1;
      },
      async insertPending() {},
      async readDue(until, limit) {
        return queue.filter((w) => w.at <= until).slice(0, limit);
      },
      async countPending() {
        return queue.length;
      },
      async readWorkIdStatus() {
        return undefined;
      },
      async readWork() {
        return undefined;
      },
      async markCompleted() {
        calls.push("markCompleted");
      },
      async runWork(w, run) {
        calls.push(`runWork ${w.id} begin`);
        clock = w.at;
        run();
        queue.shift();
        calls.push(`runWork ${w.id} end`);
      },
    };
    expect(await createScheduler(storage).advanceTo(simTime(10), 5, (w) => void calls.push(`execute ${w.id}`))).toEqual({
      now: simTime(10),
      executed: 1,
      reachedTarget: true,
    });
    expect(calls).toEqual(["runWork w1 begin", "execute w1", "runWork w1 end", "writeClock 10"]);
  });
});

if (!databaseUrl) {
  test.skip("PostgreSQL operation runtime NOT RUN: set REALMLIB_TEST_DATABASE_URL to a disposable database", () => {});
} else {
  definePostgresTests(databaseUrl);
}

function definePostgresTests(url: string): void {
  // The observer is a separate connection: it sees only what has committed.
  const observer = new pg.Client({ connectionString: url });
  const drivers: pg.Client[] = [];
  let migrated = false;

  beforeAll(async () => {
    await observer.connect();
    const { rows } = await observer.query("SELECT EXISTS (SELECT FROM pg_namespace WHERE nspname = 'realmlib') AS present");
    if (rows[0].present) {
      throw new Error("refusing to run: schema realmlib already exists; use a separate disposable database");
    }
    const migration = await Bun.file(join(repoRoot, "migrations", "001_initial_persistence.sql")).text();
    await observer.query("BEGIN");
    try {
      await observer.query(migration);
      await observer.query("COMMIT");
    } catch (error) {
      await observer.query("ROLLBACK");
      throw error;
    }
    migrated = true;
  });

  afterAll(async () => {
    for (const driver of drivers) await driver.end().catch(() => {});
    if (migrated) await observer.query("DROP SCHEMA realmlib CASCADE");
    await observer.end();
  });

  /** A new dedicated driver connection, closed after the file's tests. */
  async function driver(): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: url });
    // A terminated backend is reported through the query that was running; keep the event from crashing the run.
    client.on("error", () => {});
    await client.connect();
    drivers.push(client);
    return client;
  }

  async function reset(initialTime = 0, random: RandomSnapshot | null = createSeededRandom(SEED).snapshot()) {
    await observer.query("TRUNCATE realmlib.work_items, realmlib.runtime_state, realmlib.state_records");
    await initializePostgresSchedulerStorage(observer, simTime(initialTime), random ?? undefined);
  }

  /** Everything committed, read through the observer connection. */
  async function committed() {
    const runtime = await observer.query(
      "SELECT now_ms::text, next_sequence::text, random_snapshot::text FROM realmlib.runtime_state",
    );
    const records = await observer.query(
      "SELECT module_id, record_key, value::text FROM realmlib.state_records ORDER BY module_id, record_key",
    );
    const items = await observer.query(
      `SELECT work_id, at_ms::text, sequence::text, payload::text, status, completed_at_ms::text
       FROM realmlib.work_items ORDER BY sequence`,
    );
    expect(runtime.rows).toHaveLength(1);
    return { runtime: runtime.rows[0], records: records.rows, items: items.rows };
  }

  function recordsOf(view: Awaited<ReturnType<typeof committed>>, owner: string = a): Record<string, unknown> {
    return Object.fromEntries(
      view.records.filter((r) => r.module_id === owner).map((r) => [r.record_key, JSON.parse(r.value)]),
    );
  }

  type Fault = {
    when: (text: string) => boolean;
    /** Fail before the statement is sent, fail after it has run, or (`tamper`) rewrite its result rows. */
    phase: "before" | "after" | "tamper";
    error?: () => unknown;
    /** For `after`: runs once the statement has run, before the failure is reported. */
    then?: () => Promise<unknown>;
    rows?: (rows: Record<string, unknown>[]) => Record<string, unknown>[];
  };

  /** Wraps a driver connection so chosen statements fail, before or after they reach the database. */
  function faulty(target: pg.Client) {
    const seen: string[] = [];
    // Each armed fault fires once, on the first statement it matches.
    const faults: Fault[] = [];
    const client: PostgresQueryable = {
      async query(text, values) {
        seen.push(text);
        const index = faults.findIndex((f) => f.when(text));
        const armed = index === -1 ? undefined : faults.splice(index, 1)[0]!;
        const failure = () => (armed!.error ?? (() => new Error("injected database failure")))();
        if (armed?.phase === "before") throw failure();
        const result = await target.query(text, values);
        if (armed?.phase === "tamper") return { ...result, rows: armed.rows!(result.rows) };
        if (armed?.phase === "after") {
          await armed.then?.();
          throw failure();
        }
        return result;
      },
    };
    return {
      client,
      seen,
      arm(...next: Fault[]) {
        faults.push(...next);
      },
    };
  }

  /** `countAndRoll`, counting its invocations. */
  function counted() {
    const calls: string[] = [];
    const handler: OperationHandler = (request, state, random) => {
      calls.push(JSON.stringify(request.payload));
      countAndRoll(request, state, random);
    };
    return { calls, handler };
  }

  describeSchedulerStorageContract("PostgreSQL operation runtime", async (initialTime) => {
    await reset(initialTime, null);
    return (await loadPostgresOperationRuntime(await driver())).storage;
  });

  describe("PostgreSQL operation runtime", () => {
    test("a successful item commits its records, random position, clock, and receipt in one transaction on one client", async () => {
      await reset(0);
      const conn = faulty(await driver());
      const runtime = await loadPostgresOperationRuntime(conn.client);
      await runtime.scheduler.schedule(work("w1", 100, a, { n: 1 }));
      await runtime.scheduler.schedule(work("w2", 150, a, { n: 2 }));
      conn.seen.length = 0;

      // Stopping at the work limit leaves the clock exactly where the item's transaction put it.
      expect(await runtime.scheduler.advanceTo(simTime(500), 1, through(runtime))).toEqual({
        now: simTime(100),
        executed: 1,
        reachedTarget: false,
      });
      const expected = inMemoryReference([{ n: 1 }]);
      const view = await committed();
      expect(view.runtime).toEqual({
        now_ms: "100",
        next_sequence: "2",
        random_snapshot: JSON.stringify(expected.random),
      });
      expect(recordsOf(view)).toEqual(expected.records);
      expect(view.items).toEqual([
        { work_id: "w1", at_ms: "100", sequence: "0", payload: '{"n":1}', status: "completed", completed_at_ms: "100" },
        { work_id: "w2", at_ms: "150", sequence: "1", payload: '{"n":2}', status: "pending", completed_at_ms: null },
      ]);

      // Every write of the item went through the one connection, between one BEGIN and its COMMIT.
      const statements = conn.seen.filter((text) => !text.trimStart().startsWith("SELECT"));
      expect(statements[0]).toBe("BEGIN");
      expect(statements.at(-1)).toBe("COMMIT");
      expect(statements.filter((t) => t === "BEGIN" || t === "COMMIT")).toEqual(["BEGIN", "COMMIT"]);
      expect(statements.slice(1, -1)).toEqual([
        expect.stringMatching(/^UPDATE realmlib\.runtime_state SET now_ms = /),
        expect.stringMatching(/^INSERT INTO realmlib\.state_records /),
        expect.stringMatching(/^INSERT INTO realmlib\.state_records /),
        expect.stringMatching(/^INSERT INTO realmlib\.state_records /),
        expect.stringMatching(/^UPDATE realmlib\.runtime_state SET random_snapshot = /),
        expect.stringMatching(/SET status = 'completed'/),
      ]);

      // In-memory views agree with the commit, and so does a runtime loaded on another connection.
      expect(runtime.read(a, "count")).toBe(1);
      expect(runtime.randomSnapshot()).toEqual(expected.random);
      const reloaded = await loadPostgresOperationRuntime(await driver());
      expect(reloaded.read(a, "roll")).toBe(expected.records.roll!);
      expect(reloaded.randomSnapshot()).toEqual(expected.random);

      // The completed ID stays reserved, and the next item continues the same stream.
      await expect(runtime.scheduler.schedule(work("w1", 600))).rejects.toThrow("has already completed");
      expect(await runtime.scheduler.advanceTo(simTime(500), 10, through(runtime))).toEqual({
        now: simTime(500),
        executed: 1,
        reachedTarget: true,
      });
      const after = await committed();
      expect(recordsOf(after)).toEqual(inMemoryReference([{ n: 1 }, { n: 2 }]).records);
      expect(after.runtime.random_snapshot).toBe(JSON.stringify(inMemoryReference([{ n: 1 }, { n: 2 }]).random));
      expect(after.runtime.now_ms).toBe("500");
      await expect(reloaded.scheduler.schedule(work("w2", 600))).rejects.toThrow("has already completed");
    });

    test("resubmissions are harmless pending and completed, across new runtimes and storage adapters", async () => {
      await reset(0);
      const runtime = await loadPostgresOperationRuntime(await driver());
      const original = work("w1", 10, a, { n: 1, tags: ["x", "y"] });
      expect(await runtime.scheduler.schedule(original)).toBe("accepted");
      expect(await runtime.scheduler.schedule(work("w2", 50, a, { n: 2 }))).toBe("accepted");

      // Pending: still exactly one row with its original sequence, and no sequence consumed.
      const pending = await committed();
      expect(await runtime.scheduler.schedule(work("w1", 10, a, { tags: ["x", "y"], n: 1 }))).toBe("already-pending");
      await expect(runtime.scheduler.schedule(work("w1", 10, a, { n: 1, tags: ["y", "x"] }))).rejects.toThrow(
        "is already pending",
      );
      await expect(runtime.scheduler.schedule(work("w1", 10, b, { n: 1, tags: ["x", "y"] }))).rejects.toThrow(
        "is already pending",
      );
      expect(await committed()).toEqual(pending);
      expect(pending.items.map((r) => [r.work_id, r.sequence])).toEqual([["w1", "0"], ["w2", "1"]]);
      expect(pending.runtime.next_sequence).toBe("2");

      // Completed: the handler changed a record and drew a number; the receipt keeps the request.
      const { calls, handler } = counted();
      await runtime.scheduler.advanceTo(simTime(20), 10, through(runtime, handler));
      expect(calls).toHaveLength(1);
      const done = await committed();
      expect(done.items[0]).toEqual({
        work_id: "w1",
        at_ms: "10",
        sequence: "0",
        payload: '{"n":1,"tags":["x","y"]}',
        status: "completed",
        completed_at_ms: "10",
      });
      expect(recordsOf(done)).toEqual(inMemoryReference([{ n: 1, tags: ["x", "y"] }]).records);

      const reloaded = await loadPostgresOperationRuntime(await driver());
      const plain = createScheduler(createPostgresSchedulerStorage(await driver()));
      for (const scheduler of [runtime.scheduler, reloaded.scheduler, plain]) {
        expect(await scheduler.schedule(original)).toBe("already-completed");
        for (const variant of [
          work("w1", 20, a, { n: 1, tags: ["x", "y"] }),
          work("w1", 10, a, { n: 1, tags: ["x", "y", "z"] }),
          { ...original, request: { ...original.request, payloadVersion: 2 } },
          { ...original, request: { ...original.request, operation: "op-y" } },
        ]) {
          await expect(scheduler.schedule(variant)).rejects.toThrow("has already completed");
        }
      }
      // Advancing over its time again runs nothing: state, draws, clock, sequence, receipt, and queue are unchanged.
      await reloaded.scheduler.advanceTo(simTime(20), 10, through(reloaded, handler));
      expect(calls).toHaveLength(1);
      expect(await committed()).toEqual(done);
      expect(reloaded.randomSnapshot()).toEqual(runtime.randomSnapshot());
    });

    test("deletions and records of other modules are committed by owner", async () => {
      await reset(0);
      const runtime = await loadPostgresOperationRuntime(await driver());
      await runtime.scheduler.schedule(work("seed-b", 1, b));
      await runtime.scheduler.schedule(work("a-reads-b", 2, a));
      await runtime.scheduler.schedule(work("a-deletes", 3, a));
      const handlers: Record<string, OperationHandler> = {
        "seed-b": (_r, state) => state.set("shared", { from: "b" }),
        // Any module may read another's records but writes only its own namespace.
        "a-reads-b": (_r, state) => {
          state.set("copy", state.get(b, "shared")!);
          state.set("temp", 1);
        },
        "a-deletes": (_r, state) => {
          expect(state.delete("temp")).toBe(true);
          state.set("gone", 1);
          expect(state.delete("gone")).toBe(true);
        },
      };
      await runtime.scheduler.advanceTo(simTime(10), 10, (w) => {
        const outcome = runtime.execute(registry, w.request, handlers[w.id]!);
        if (!outcome.ok) throw new Error(outcome.reason);
      });
      expect((await committed()).records).toEqual([
        { module_id: "module-a", record_key: "copy", value: '{"from":"b"}' },
        { module_id: "module-b", record_key: "shared", value: '{"from":"b"}' },
      ]);
      expect(runtime.read(a, "temp")).toBeUndefined();
      expect(runtime.read(a, "copy")).toEqual({ from: "b" });
    });

    for (const [stage, when] of [
      ["after a state record is written", (t: string) => t.includes("INSERT INTO realmlib.state_records")],
      ["after the random position is written", (t: string) => t.includes("SET random_snapshot")],
      ["after completion is written", (t: string) => t.includes("SET status = 'completed'")],
    ] as const) {
      test(`a database failure ${stage} leaves nothing of the item committed or visible`, async () => {
        await reset(0);
        const conn = faulty(await driver());
        const runtime = await loadPostgresOperationRuntime(conn.client);
        await runtime.scheduler.schedule(work("w1", 10, a, { n: 1 }));
        await runtime.scheduler.schedule(work("w2", 20, a, { n: 2 }));
        await runtime.scheduler.advanceTo(simTime(10), 10, through(runtime));
        const before = await committed();

        conn.arm({ when, phase: "after" });
        await expect(runtime.scheduler.advanceTo(simTime(30), 10, through(runtime))).rejects.toThrow(
          "injected database failure",
        );
        // Not even the item's clock movement survives: the database failed, not the handler.
        expect(await committed()).toEqual(before);
        expect(before.runtime.now_ms).toBe("10");
        expect(runtime.read(a, "count")).toBe(1);
        expect(runtime.read(a, "last")).toEqual({ n: 1 });
        expect(runtime.randomSnapshot()).toEqual(inMemoryReference([{ n: 1 }]).random);
        expect(await runtime.scheduler.pendingCount()).toBe(1);
        expect(await runtime.scheduler.now()).toBe(simTime(10));

        // The rollback left the runtime consistent: the same item runs again with the same draws.
        expect(await runtime.scheduler.advanceTo(simTime(30), 10, through(runtime))).toEqual({
          now: simTime(30),
          executed: 1,
          reachedTarget: true,
        });
        const reference = inMemoryReference([{ n: 1 }, { n: 2 }]);
        expect(recordsOf(await committed())).toEqual(reference.records);
        expect(runtime.randomSnapshot()).toEqual(reference.random);
      });
    }

    test("a handler failure discards staged effects, keeps the item pending, and leaves the clock at its time", async () => {
      await reset(0);
      const runtime = await loadPostgresOperationRuntime(await driver());
      await runtime.scheduler.schedule(work("ok", 10, a, { n: 1 }));
      await runtime.scheduler.schedule(work("bad", 20, a, { n: 2 }));
      await runtime.scheduler.schedule(work("later", 30, a, { n: 3 }));

      await expect(
        runtime.scheduler.advanceTo(simTime(100), 10, (w) => {
          const outcome = runtime.execute(registry, w.request, w.id === "bad" ? stageThenThrow : countAndRoll);
          if (!outcome.ok) throw new Error(outcome.reason);
        }),
      ).rejects.toThrow("handler failed after staging");

      // The earlier item from the same advanceTo() stays committed; the failed one left only the clock.
      const reference = inMemoryReference([{ n: 1 }]);
      const view = await committed();
      expect(view.runtime).toEqual({ now_ms: "20", next_sequence: "3", random_snapshot: JSON.stringify(reference.random) });
      expect(recordsOf(view)).toEqual(reference.records);
      expect(view.items.map((r) => [r.work_id, r.status, r.completed_at_ms])).toEqual([
        ["ok", "completed", "10"],
        ["bad", "pending", null],
        ["later", "pending", null],
      ]);
      expect(runtime.read(a, "count")).toBe(1);
      expect(runtime.randomSnapshot()).toEqual(reference.random);
      await expect(runtime.scheduler.schedule(work("bad", 50))).rejects.toThrow("is already pending");

      // A callback that throws after a successful execute() is a failure too, and so is a thenable.
      for (const callback of [
        (w: ScheduledWork) => {
          through(runtime)(w);
          throw new Error("callback failed after execute");
        },
        (w: ScheduledWork) => {
          through(runtime)(w);
          return loose<void>(Promise.resolve());
        },
        (w: ScheduledWork) => {
          through(runtime)(w);
          through(runtime)(w);
        },
      ]) {
        await expect(runtime.scheduler.advanceTo(simTime(100), 10, callback)).rejects.toThrow();
        expect(await committed()).toEqual(view);
        expect(runtime.read(a, "count")).toBe(1);
      }

      // Retrying reproduces the draws the failed attempt would have made.
      await runtime.scheduler.advanceTo(simTime(100), 10, through(runtime));
      const final = inMemoryReference([{ n: 1 }, { n: 2 }, { n: 3 }]);
      expect(recordsOf(await committed())).toEqual(final.records);
      expect(runtime.randomSnapshot()).toEqual(final.random);
    });

    test("ordering, work limits, and clock-only advancement match the in-memory scheduler", async () => {
      await reset(0);
      const runtime = await loadPostgresOperationRuntime(await driver());
      const memory = createInMemoryScheduler();
      const items = [work("c", 50), work("a", 40), work("b", 50), work("d", 50), work("e", 5_000)];
      for (const item of items) {
        await runtime.scheduler.schedule(item);
        await memory.schedule(item);
      }
      const order: string[] = [];
      const memoryOrder: string[] = [];
      const steps: [number, number][] = [[100, 2], [100, 5], [100, 5], [1_000, 5], [6_000, 1], [7_000, 1]];
      for (const [target, limit] of steps) {
        const result = await runtime.scheduler.advanceTo(simTime(target), limit, (w) => {
          order.push(w.id);
          through(runtime)(w);
        });
        expect(result).toEqual(await memory.advanceTo(simTime(target), limit, (w) => void memoryOrder.push(w.id)));
        expect((await committed()).runtime.now_ms).toBe(String(result.now));
      }
      expect(order).toEqual(["a", "c", "b", "d", "e"]);
      expect(order).toEqual(memoryOrder);
      // Execution never consumes sequences, and draws were committed once per item.
      expect((await committed()).runtime.next_sequence).toBe("5");
      expect(runtime.read(a, "count")).toBe(5);
      expect(runtime.randomSnapshot()).toEqual(inMemoryReference([1, 2, 3, 4, 5]).random);

      // A target at the safe-integer limit is stored exactly.
      await runtime.scheduler.advanceTo(simTime(MAX), 1, through(runtime));
      expect((await committed()).runtime.now_ms).toBe(String(MAX));
    });

    test("invalid values cannot become committed changes", async () => {
      await reset(0);
      const runtime = await loadPostgresOperationRuntime(await driver());
      await runtime.scheduler.schedule(work("w", 10));
      await expect(runtime.scheduler.schedule(work("neg-zero", 10, a, { nested: [1, -0] }))).rejects.toThrow(TypeError);

      for (const bad of [{ nested: [1, -0] }, -0, Number.NaN, loose<StateValue>(undefined)]) {
        await expect(
          runtime.scheduler.advanceTo(simTime(20), 10, (w) => {
            const outcome = runtime.execute(registry, w.request, (_r, state) => {
              state.set("ok", 1);
              state.set("bad", bad);
            });
            if (!outcome.ok) throw new Error(outcome.reason);
          }),
        ).rejects.toThrow(TypeError);
      }
      const view = await committed();
      expect(view.records).toEqual([]);
      expect(view.items.map((r) => r.status)).toEqual(["pending"]);
      expect(view.runtime.now_ms).toBe("10");
      expect(runtime.read(a, "ok")).toBeUndefined();
    });

    test("malformed persisted state or random snapshots are rejected when loading", async () => {
      const cases: [string, string][] = [
        ["INSERT INTO realmlib.state_records VALUES ('module-a', 'k', '-0')", "Invalid persisted state record"],
        ["INSERT INTO realmlib.state_records VALUES ('module-a', 'k', '{\"a\":[1,-0]}')", "Invalid persisted state record"],
        ["INSERT INTO realmlib.state_records VALUES ('module-a', 'k', '[1e400]')", "Invalid persisted state record"],
        ["INSERT INTO realmlib.state_records VALUES ('﻿', 'k', '1')", "Invalid persisted state record"],
        ["INSERT INTO realmlib.state_records VALUES ('module-a', ' 　', '1')", "Invalid persisted state record"],
        [
          `UPDATE realmlib.runtime_state SET random_snapshot = '{"algorithm":"xoshiro128ss-v1","words":[-0,1,2,3]}'`,
          "Invalid persisted runtime_state.random_snapshot",
        ],
        [
          `UPDATE realmlib.runtime_state SET random_snapshot = '{"algorithm":"other","words":[1,2,3,4]}'`,
          "Invalid persisted runtime_state.random_snapshot",
        ],
        ["UPDATE realmlib.runtime_state SET format_version = 2", "Unsupported"],
        ["DELETE FROM realmlib.runtime_state", "has no row"],
      ];
      for (const [statement, message] of cases) {
        await reset(0);
        await observer.query(statement);
        const client = await driver();
        await expect(loadPostgresOperationRuntime(client)).rejects.toThrow(message);
        // The read-only load transaction was closed: the connection is usable.
        expect((await client.query("SELECT 1 AS one")).rows).toEqual([{ one: 1 }]);
      }
      // Without a configured stream, handlers get none and nothing is written for it.
      await reset(0, null);
      const runtime = await loadPostgresOperationRuntime(await driver());
      await runtime.scheduler.schedule(work("w", 1));
      let received: unknown = "unset";
      await runtime.scheduler.advanceTo(simTime(1), 1, (w) => {
        runtime.execute(registry, w.request, (_r, state, random) => {
          received = random;
          state.set("k", 1);
        });
      });
      expect(received).toBeUndefined();
      expect((await committed()).runtime.random_snapshot).toBeNull();
    });

    test("a COMMIT the server rejects leaves nothing committed or visible, and the runtime usable", async () => {
      await reset(0);
      // A deferred constraint trigger fails only at COMMIT; it is dropped before the test ends.
      await observer.query(`CREATE FUNCTION realmlib.test_reject_at_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.value::text = '"reject"' THEN RAISE EXCEPTION 'rejected at commit'; END IF;
          RETURN NULL;
        END $$`);
      await observer.query(`CREATE CONSTRAINT TRIGGER test_reject_at_commit AFTER INSERT OR UPDATE ON realmlib.state_records
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION realmlib.test_reject_at_commit()`);
      try {
        const conn = faulty(await driver());
        const runtime = await loadPostgresOperationRuntime(conn.client);
        await runtime.scheduler.schedule(work("w", 10, a, "reject"));
        const before = await committed();
        await expect(runtime.scheduler.advanceTo(simTime(20), 10, through(runtime))).rejects.toMatchObject({
          message: "rejected at commit",
          code: "P0001",
        });
        // The statements before COMMIT all succeeded; the server refused the commit itself.
        expect(conn.seen.at(-1)).toBe("COMMIT");
        expect(await committed()).toEqual(before);
        expect(runtime.read(a, "last")).toBeUndefined();
        expect(runtime.randomSnapshot()).toEqual(createSeededRandom(SEED).snapshot());

        await observer.query("DROP TRIGGER test_reject_at_commit ON realmlib.state_records");
        expect(await runtime.scheduler.advanceTo(simTime(20), 10, through(runtime))).toMatchObject({ executed: 1 });
        expect(runtime.read(a, "last")).toBe("reject");
      } finally {
        await observer.query("DROP TRIGGER IF EXISTS test_reject_at_commit ON realmlib.state_records");
        await observer.query("DROP FUNCTION realmlib.test_reject_at_commit()");
      }
    });

    /** The reply to the item's COMMIT is lost, as if the connection had dropped, after the statement ran. */
    const lostReply = (then?: () => Promise<unknown>): Fault => ({
      when: (t) => t === "COMMIT",
      phase: "after",
      error: () => new Error("Connection terminated unexpectedly"),
      then,
    });
    /** The statement that reads the work item's durable record. */
    const receiptRead = (t: string) => t.includes("FROM realmlib.work_items WHERE work_id = $1");

    test("a lost COMMIT reply after a real commit is confirmed from the receipt, and execution continues once", async () => {
      await reset(0);
      const conn = faulty(await driver());
      const runtime = await loadPostgresOperationRuntime(conn.client);
      await runtime.scheduler.schedule(work("w1", 10, a, { n: 1 }));
      await runtime.scheduler.schedule(work("w2", 20, a, { n: 2 }));
      const { calls, handler } = counted();
      conn.seen.length = 0;
      conn.arm(lostReply());

      expect(await runtime.scheduler.advanceTo(simTime(30), 10, through(runtime, handler))).toEqual({
        now: simTime(30),
        executed: 2,
        reachedTarget: true,
      });
      // Each handler ran once; the second saw the first's committed effects, reloaded from the database.
      expect(calls).toEqual(['{"n":1}', '{"n":2}']);
      expect(conn.seen.filter((t) => t === "COMMIT")).toHaveLength(2 + 1); // two items, one reconciliation read
      const firstCommit = conn.seen.indexOf("COMMIT");
      expect(conn.seen.slice(firstCommit + 1, firstCommit + 3)).toEqual([
        "ROLLBACK",
        "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      ]);

      const reference = inMemoryReference([{ n: 1 }, { n: 2 }]);
      const view = await committed();
      expect(recordsOf(view)).toEqual(reference.records);
      expect(view.runtime).toEqual({ now_ms: "30", next_sequence: "2", random_snapshot: JSON.stringify(reference.random) });
      expect(view.items.map((r) => [r.work_id, r.status, r.completed_at_ms])).toEqual([
        ["w1", "completed", "10"],
        ["w2", "completed", "20"],
      ]);
      expect(runtime.read(a, "count")).toBe(2);
      expect(runtime.randomSnapshot()).toEqual(reference.random);

      // Resubmitting either request, here or through a new runtime on another connection, changes nothing.
      const reloaded = await loadPostgresOperationRuntime(await driver());
      for (const scheduler of [runtime.scheduler, reloaded.scheduler]) {
        expect(await scheduler.schedule(work("w1", 10, a, { n: 1 }))).toBe("already-completed");
        await expect(scheduler.schedule(work("w1", 10, a, { n: 9 }))).rejects.toThrow("has already completed");
      }
      expect(await reloaded.scheduler.advanceTo(simTime(30), 10, through(reloaded, handler))).toMatchObject({ executed: 0 });
      expect(calls).toHaveLength(2);
      expect(await committed()).toEqual(view);
      expect(reloaded.read(a, "count")).toBe(2);
    });

    test("a lost COMMIT that did not commit leaves the item pending, unexecuted, and runnable once on request", async () => {
      await reset(0);
      const conn = faulty(await driver());
      const runtime = await loadPostgresOperationRuntime(conn.client);
      await runtime.scheduler.schedule(work("w1", 10, a, { n: 1 }));
      await runtime.scheduler.schedule(work("w2", 20, a, { n: 2 }));
      const before = await committed();
      const { calls, handler } = counted();
      conn.seen.length = 0;
      // The COMMIT never reaches the server, so ROLLBACK ends the open transaction.
      conn.arm({ when: (t) => t === "COMMIT", phase: "before", error: () => new Error("Connection terminated unexpectedly") });

      const failure = await runtime.scheduler.advanceTo(simTime(30), 10, through(runtime, handler)).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(CommitNotConfirmedError);
      expect((failure as Error).cause).toMatchObject({ message: "Connection terminated unexpectedly" });
      // Nothing of the attempt is durable, the clock included, and the later item did not run.
      expect(calls).toEqual(['{"n":1}']);
      expect(await committed()).toEqual(before);
      expect(before.items.map((r) => [r.work_id, r.status])).toEqual([
        ["w1", "pending"],
        ["w2", "pending"],
      ]);
      expect(runtime.read(a, "count")).toBeUndefined();
      expect(runtime.randomSnapshot()).toEqual(createSeededRandom(SEED).snapshot());
      expect(await runtime.scheduler.schedule(work("w1", 10, a, { n: 1 }))).toBe("already-pending");

      // An explicit advance runs each item once, with the draws the lost attempt would have made.
      expect(await runtime.scheduler.advanceTo(simTime(30), 10, through(runtime, handler))).toMatchObject({ executed: 2 });
      expect(calls).toEqual(['{"n":1}', '{"n":1}', '{"n":2}']);
      const reference = inMemoryReference([{ n: 1 }, { n: 2 }]);
      expect(recordsOf(await committed())).toEqual(reference.records);
      expect((await committed()).runtime.random_snapshot).toBe(JSON.stringify(reference.random));
      expect(runtime.randomSnapshot()).toEqual(reference.random);
    });

    /** After a lost reply to a real commit, the observer changes the committed receipt before it is read. */
    const lostThenAltered = (statement: string) => [lostReply(() => observer.query(statement))];
    const unresolved: [string, () => Fault[]][] = [
      ["the ROLLBACK before the read fails", () => [lostReply(), { when: (t) => t === "ROLLBACK", phase: "before" }]],
      [
        "the read fails",
        () => [lostReply(), { when: (t) => t.startsWith("BEGIN ISOLATION LEVEL REPEATABLE READ"), phase: "before" }],
      ],
      ["the receipt query fails", () => [lostReply(), { when: receiptRead, phase: "after" }]],
      [
        "the read is not in a fresh transaction",
        () => [lostReply(), { when: (t) => t.includes("pg_current_xact_id_if_assigned"), phase: "tamper", rows: () => [{ xid: "1" }] }],
      ],
      ["the work item is missing", () => lostThenAltered("DELETE FROM realmlib.work_items WHERE work_id = 'w1'")],
      [
        "the receipt holds a different request",
        () => lostThenAltered(`UPDATE realmlib.work_items SET payload = '{"n":2}' WHERE work_id = 'w1'`),
      ],
      [
        "the receipt is unreadable",
        () => lostThenAltered(`UPDATE realmlib.work_items SET payload = '{"n":-0}' WHERE work_id = 'w1'`),
      ],
      [
        "the receipt has another completion time",
        () => lostThenAltered("UPDATE realmlib.work_items SET completed_at_ms = 11 WHERE work_id = 'w1'"),
      ],
      [
        // The transaction never committed; a fixture rewrites the pending row as it is read.
        "the item is pending with a different request",
        () => [
          { when: (t) => t === "COMMIT", phase: "before" },
          { when: receiptRead, phase: "tamper", rows: (rows) => rows.map((r) => ({ ...r, operation: "op-y" })) },
        ],
      ],
    ];
    for (const [situation, faults] of unresolved) {
      test(`an unknown COMMIT outcome fails closed when ${situation}`, async () => {
        await reset(0);
        const conn = faulty(await driver());
        const runtime = await loadPostgresOperationRuntime(conn.client);
        await runtime.scheduler.schedule(work("w1", 10, a, { n: 1 }));
        await runtime.scheduler.schedule(work("w2", 20, a, { n: 2 }));
        const { calls, handler } = counted();
        conn.arm(...faults());
        const failure = await runtime.scheduler.advanceTo(simTime(30), 10, through(runtime, handler)).catch((e: unknown) => e);
        expect(failure).toBeInstanceOf(CommitOutcomeUnknownError);
        expect((failure as Error).cause).toBeInstanceOf(Error);
        // Neither claimed as completed nor executed again, and the later item did not run.
        expect(calls).toEqual(['{"n":1}']);
        expect(() => runtime.read(a, "count")).toThrow("unusable");
        expect(() => runtime.randomSnapshot()).toThrow("unusable");
        await expect(runtime.scheduler.now()).rejects.toThrow("unusable");
        await expect(runtime.scheduler.schedule(work("w3", 40))).rejects.toThrow("unusable");
        await expect(runtime.scheduler.advanceTo(simTime(30), 1, through(runtime, handler))).rejects.toThrow("unusable");
        expect(calls).toHaveLength(1);
        expect((await committed()).items.find((r) => r.work_id === "w2")).toMatchObject({ status: "pending" });
      });
    }

    test("an unknown COMMIT outcome fails closed when the connection is really lost", async () => {
      // Here the transaction did not commit, but with the connection gone the runtime cannot tell.
      await reset(0);
      const target = await driver();
      const pid = (await target.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      // Once armed, terminates the driver's backend from the observer just before COMMIT is sent.
      let terminate = false;
      const seen: string[] = [];
      const terminating: PostgresQueryable = {
        async query(text, values) {
          seen.push(text);
          if (terminate && text === "COMMIT") await observer.query("SELECT pg_terminate_backend($1, 5000)", [pid]);
          return target.query(text, values);
        },
      };
      const runtime = await loadPostgresOperationRuntime(terminating);
      await runtime.scheduler.schedule(work("w", 10));
      const { calls, handler } = counted();
      terminate = true;
      seen.length = 0;
      const before = await committed();
      const failure = await runtime.scheduler.advanceTo(simTime(20), 10, through(runtime, handler)).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(CommitOutcomeUnknownError);
      expect((failure as Error).message).toContain("could not be read");
      expect(calls).toHaveLength(1);
      // Sent once, never retried; the ROLLBACK that follows fails on the dead connection, so nothing is read.
      expect(seen.filter((t) => t === "COMMIT")).toHaveLength(1);
      expect(seen.at(-1)).toBe("ROLLBACK");
      expect(await committed()).toEqual(before);
      expect(() => runtime.read(a, "count")).toThrow("unusable");

      // A new runtime on a new connection reads the durable truth: still pending, run on request.
      const fresh = await loadPostgresOperationRuntime(await driver());
      expect(await fresh.scheduler.schedule(work("w", 10))).toBe("already-pending");
      expect(await fresh.scheduler.advanceTo(simTime(20), 10, through(fresh, handler))).toMatchObject({ executed: 1 });
      expect(calls).toHaveLength(2);
      expect(fresh.read(a, "count")).toBe(1);
    });
  });
}
