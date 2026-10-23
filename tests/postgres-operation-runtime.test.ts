import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import {
  CommitOutcomeUnknownError,
  createInMemoryScheduler,
  createInMemoryStateStore,
  createModuleRegistry,
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

  type Fault = { when: (text: string) => boolean; phase: "before" | "after"; error?: () => unknown };

  /** Wraps a driver connection so one chosen statement fails, before or after it reaches the database. */
  function faulty(target: pg.Client) {
    const seen: string[] = [];
    let fault: Fault | undefined;
    const client: PostgresQueryable = {
      async query(text, values) {
        seen.push(text);
        const armed = fault !== undefined && fault.when(text) ? fault : undefined;
        if (armed) fault = undefined;
        const failure = () => (armed!.error ?? (() => new Error("injected database failure")))();
        if (armed?.phase === "before") throw failure();
        const result = await target.query(text, values);
        if (armed?.phase === "after") throw failure();
        return result;
      },
    };
    return {
      client,
      seen,
      arm(next: Fault) {
        fault = next;
      },
    };
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

    test("a COMMIT with an unknown outcome is surfaced, not retried, and the runtime refuses further use", async () => {
      // The reply to a COMMIT that did commit is lost.
      await reset(0);
      const conn = faulty(await driver());
      const runtime = await loadPostgresOperationRuntime(conn.client);
      await runtime.scheduler.schedule(work("w", 10));
      conn.seen.length = 0;
      conn.arm({ when: (t) => t === "COMMIT", phase: "after", error: () => new Error("Connection terminated unexpectedly") });
      const failure = await runtime.scheduler.advanceTo(simTime(20), 10, through(runtime)).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(CommitOutcomeUnknownError);
      expect((failure as Error).cause).toMatchObject({ message: "Connection terminated unexpectedly" });
      // Sent once and never retried.
      expect(conn.seen.filter((t) => t === "COMMIT")).toEqual(["COMMIT"]);
      // It did commit, which only a reload can show; the old runtime exposes nothing.
      expect((await committed()).items[0]).toMatchObject({ status: "completed" });
      expect(() => runtime.read(a, "count")).toThrow("unusable");
      expect(() => runtime.randomSnapshot()).toThrow("unusable");
      await expect(runtime.scheduler.now()).rejects.toThrow("unusable");
      await expect(runtime.scheduler.advanceTo(simTime(30), 1, () => {})).rejects.toThrow("unusable");
      expect((await loadPostgresOperationRuntime(await driver())).read(a, "count")).toBe(1);

      // A COMMIT that fails without reaching the server is just as ambiguous to the client. The
      // runtime still sends ROLLBACK (which never commits), so the open transaction does not hold
      // its locks; the observer's TRUNCATE in reset() would otherwise wait for it.
      await reset(0);
      const unsent = faulty(await driver());
      const blocked = await loadPostgresOperationRuntime(unsent.client);
      await blocked.scheduler.schedule(work("w", 10));
      const beforeUnsent = await committed();
      unsent.arm({ when: (t) => t === "COMMIT", phase: "before" });
      await expect(blocked.scheduler.advanceTo(simTime(20), 10, through(blocked))).rejects.toBeInstanceOf(
        CommitOutcomeUnknownError,
      );
      expect(unsent.seen.slice(-2)).toEqual(["COMMIT", "ROLLBACK"]);
      expect(await committed()).toEqual(beforeUnsent);

      // The connection is really lost during COMMIT: here it did not commit, but the client cannot tell.
      await reset(0);
      const target = await driver();
      const pid = (await target.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      // Once armed, terminates the driver's backend from the observer just before COMMIT is sent.
      let terminate = false;
      const terminating: PostgresQueryable = {
        async query(text, values) {
          if (terminate && text === "COMMIT") await observer.query("SELECT pg_terminate_backend($1, 5000)", [pid]);
          return target.query(text, values);
        },
      };
      const second = await loadPostgresOperationRuntime(terminating);
      await second.scheduler.schedule(work("w", 10));
      terminate = true;
      const before = await committed();
      const outcome = await second.scheduler.advanceTo(simTime(20), 10, through(second)).catch((e: unknown) => e);
      expect(outcome).toBeInstanceOf(CommitOutcomeUnknownError);
      expect(await committed()).toEqual(before);
      expect(() => second.read(a, "count")).toThrow("unusable");
    });
  });
}
