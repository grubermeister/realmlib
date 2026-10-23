# realmlib

`realmlib` is an independently maintained shared TypeScript library for Lattice
simulation infrastructure. It is intended to be imported by `edgelord` and other
Bun programs without depending on either.

It currently provides foundational value types (identifiers and simulation
time), a registry for validating operation requests, an in-memory
module state store, atomic execution of a single operation against that
store, a manually advanced scheduler over replaceable storage (with in-memory
and PostgreSQL implementations), seeded random streams
whose draws commit with an operation, and a PostgreSQL path that commits each
scheduled operation's effects in one transaction; it contains **no simulation
engine or behavior**.

The target runtime is Bun. Compatibility with Node.js or browsers is not established.

## Development

```sh
bun install          # install development dependencies
bun test             # run tests
bun run typecheck    # strict TypeScript check (tsc --noEmit)
```

## Usage

Bun consumers import from the package root only.

## Identifiers and simulation time

```ts
import { entityId, moduleId, workItemId, simTime } from "realmlib";
import type { EntityId, ModuleId, WorkItemId, SimTime } from "realmlib";

const entity: EntityId = entityId("entity-42");
const module: ModuleId = moduleId("module-a");
const item: WorkItemId = workItemId("job-7");
const at: SimTime = simTime(90_000); // 90 simulated seconds after the origin
```

- `EntityId`, `ModuleId`, and `WorkItemId` are distinct branded strings.
  Identifiers are **caller-supplied**: the factories only validate (any nonempty,
  non-whitespace-only string) and return the value unchanged. They do not
  generate IDs, check uniqueness, or register anything.
- **Storable text:** identifiers, operation names, and state keys must not
  contain U+0000 or an unpaired UTF-16 surrogate (`RangeError`, or
  `malformed-request` from `validate()`). PostgreSQL rejects U+0000, and an
  unpaired surrogate has no UTF-8 encoding, so it would be stored altered.
  Surrogate pairs (such as emoji) are fine. String *values* inside payloads and
  state are unrestricted, because JSON escapes them.
- `SimTime` is a branded integer number of **simulated milliseconds since an
  arbitrary simulation origin** (`0` through `Number.MAX_SAFE_INTEGER`). It is
  **not** wall-clock time or a Unix timestamp, and there is no clock.
- Non-string or non-number input throws `TypeError`; out-of-range values
  throw `RangeError`.

## Module registry

A registry records which operations each module accepts and validates incoming
operation envelopes against them. It **does not execute operations**:
registration and validation are all it does (see
[Executing an operation](#executing-an-operation)).

```ts
import { createModuleRegistry, moduleId } from "realmlib";

const registry = createModuleRegistry(); // new, empty, independent instance

registry.register({
  id: moduleId("module-a"),
  operations: [
    { name: "op-x", version: 1, validatePayload: (p) => typeof p === "number" },
  ],
});

const result = registry.validate({
  moduleId: "module-a",
  operation: "op-x",
  payloadVersion: 1,
  payload: 42,
});

if (result.ok) {
  result.request; // { moduleId, operation, payloadVersion, payload }
} else {
  result.reason;
}
```

- `register()` throws on an invalid definition (bad module ID, blank or
  duplicate operation name, version that is not a positive safe integer,
  non-function validator) or an already-registered module ID. Registration is
  atomic, and the registry keeps its own copy of the metadata. Each operation
  name has exactly one registered version; operation names are case-sensitive.
- `validate(input)` accepts untrusted input and checks, in order:

  | `reason`              | Meaning                                                        |
  |-----------------------|----------------------------------------------------------------|
  | `malformed-request`   | Not an object with own `moduleId`, `operation`, `payloadVersion`, `payload` fields of valid shape |
  | `unknown-module`      | No module registered with that ID                              |
  | `unknown-operation`   | The module does not register that operation name               |
  | `unsupported-version` | `payloadVersion` differs from the operation's registered version |
  | `invalid-payload`     | The operation's `validatePayload` returned `false`             |

- `validatePayload` is called once, with the original payload, only after the
  envelope, module, operation, and version all match. It must be synchronous
  and return a boolean: errors it throws propagate, and a nonboolean return
  throws `TypeError`.
- On success, `request` is a fresh envelope; the payload is passed through
  unchanged (not copied, frozen, or checked for JSON serializability).

## In-memory module state

A store holds JSON-compatible values addressed by (module ID, key). Each module
writes through an access object bound to it, and can read any module's records.

```ts
import { createInMemoryStateStore, moduleId } from "realmlib";

const store = createInMemoryStateStore(); // new, empty, independent instance
const a = store.forModule(moduleId("module-a"));
const b = store.forModule(moduleId("module-b"));

a.set("counter", { value: 1, tags: ["x"] });
b.get(moduleId("module-a"), "counter"); // { value: 1, tags: ["x"] } (a copy)
b.get(moduleId("module-a"), "missing"); // undefined
a.delete("counter"); // true
```

- `get(owner, key)` reads from **any** module's namespace; `set(key, value)`
  and `delete(key)` affect **only the bound owner's** records. Ownership is an
  API boundary for trusted code, not a security mechanism.
- Direct changes are **immediate and in-memory only**: there is no
  persistence, multi-record atomicity, or rollback (for atomic multi-record
  changes, see [Executing an operation](#executing-an-operation)). The store
  does not use the module registry.
- Keys are nonblank, case-sensitive [storable](#identifiers-and-simulation-time) strings. Values must be `null`, booleans,
  strings, finite numbers other than `-0`, dense arrays, or plain objects of these. Anything
  else (`undefined`, `NaN`, class instances, `Date`, cycles, accessors, …)
  throws `TypeError` and leaves the existing record unchanged.
- Values are copied on `set` and on `get`, so mutating an input or a returned
  value never changes stored state.

## Executing an operation

`executeInMemoryOperation` validates one request with a registry and, if it is
accepted, runs a handler you supply **for that call** against an in-memory
store. The handler's changes are committed together, or not at all.

```ts
import { createInMemoryStateStore, createModuleRegistry, executeInMemoryOperation, moduleId } from "realmlib";
import type { OperationHandler } from "realmlib";

const registry = createModuleRegistry();
registry.register({
  id: moduleId("module-a"),
  operations: [{ name: "transfer", version: 1, validatePayload: (p) => typeof p === "number" && p > 0 }],
});

const store = createInMemoryStateStore();
const a = store.forModule(moduleId("module-a"));
a.set("from", { value: 10 });
a.set("to", { value: 0 });

const transfer: OperationHandler = (request, state) => {
  const amount = request.payload as number;
  const from = state.get(request.moduleId, "from") as { value: number };
  const to = state.get(request.moduleId, "to") as { value: number };
  if (from.value < amount) throw new Error("insufficient value");
  state.set("from", { value: from.value - amount });
  state.set("to", { value: to.value + amount });
};

const input = { moduleId: "module-a", operation: "transfer", payloadVersion: 1, payload: 4 };
executeInMemoryOperation(registry, store, input, transfer); // { ok: true, request }
a.get(moduleId("module-a"), "from"); // { value: 6 }

executeInMemoryOperation(registry, store, { ...input, payload: 100 }, transfer); // throws "insufficient value"
a.get(moduleId("module-a"), "from"); // still { value: 6 }: nothing was committed
```

- The registry validates the input once. A rejected input returns the
  registry's `{ ok: false, reason }` result; the handler is not called and the
  store is unchanged. On success the registry's `{ ok: true, request }` result is
  returned after the changes are committed.
- The handler is called once with the validated request and a **staged** state
  view bound to `request.moduleId`. `set` and `delete` are staged privately,
  with the same validation and copying as direct access; the handler's own reads
  see its staged changes, while every other reader sees the committed values
  until the handler returns.
- **Rollback on error:** if the handler throws (including an invalid staged
  value), none of its changes are committed and the original error propagates.
- Handlers must be synchronous. A non-function handler, or one returning a
  Promise or other thenable, throws `TypeError` and commits nothing.
- The staged view is valid only during the call; using it afterwards throws.
  Executing another operation against the same store from inside a handler
  throws. Only stores from `createInMemoryStateStore()` are supported.
- Choosing which handler belongs to which operation is the caller's job:
  there is no handler registry. Only changes made through the staged view are
  covered. To run operations at simulation times, see
  [Scheduling work](#scheduling-work).

## Scheduling work

A scheduler queues operation requests for simulation times and runs them
**only when you advance it**, through a callback you supply to that call.
There are no timers, no wall-clock reads, and no background work. Its clock,
queue, ordering sequence, and work-ID history live in a
[scheduler storage](#scheduler-storage); `createInMemoryScheduler()` uses new
in-memory storage.

```ts
import { createInMemoryScheduler, executeInMemoryOperation, moduleId, simTime, workItemId } from "realmlib";

// registry, store, and transfer as in "Executing an operation" above.
const scheduler = createInMemoryScheduler(); // clock at simTime(0); or pass a starting SimTime

await scheduler.schedule({
  id: workItemId("job-1"),
  at: simTime(1_000),
  request: { moduleId: moduleId("module-a"), operation: "transfer", payloadVersion: 1, payload: 4 },
});

const result = await scheduler.advanceTo(simTime(5_000), 100, (work) => {
  // Throw on failure: a normal return counts as success and removes the item.
  const outcome = executeInMemoryOperation(registry, store, work.request, transfer);
  if (!outcome.ok) throw new Error(`rejected: ${outcome.reason}`);
});
result; // { now: 5000, executed: 1, reachedTarget: true }
```

- **Every method returns a Promise**, and errors are reported as rejections:
  `now()`, `pendingCount()`, `schedule()`, and `advanceTo()`. The `execute`
  callback itself must still be synchronous.
- `schedule(work)` validates the work ID, time (not earlier than `now()`), and
  request envelope (module ID, nonblank storable operation name, positive safe-integer
  version) and stores a **copy**, taken when `schedule()` is called. The payload
  must be a `StateValue` (see [In-memory module state](#in-memory-module-state)).
  Validation is structural only: the registry is not consulted. Invalid input
  rejects and changes nothing. It resolves to a `ScheduleOutcome` (see
  [Resubmitting work](#resubmitting-work)).
- `schedule()` and `advanceTo()` calls on one scheduler take effect one at a
  time, in call order, so unawaited `schedule()` calls keep their call order.
  `now()` and `pendingCount()` read storage directly and see only calls that
  have taken effect.
- `advanceTo(target, maxOperations, execute)` runs items due **at or before**
  `target`, ordered by time and then by insertion order. Before each callback,
  the clock is set to that item's time. Each callback receives a fresh copy of
  the work. `maxOperations` must be a positive safe integer.
- When all due work has run, the clock moves to `target` and `reachedTarget` is
  `true`. If the limit stops it first, `reachedTarget` is `false`, the clock
  stays at the last executed item's time, and the remaining due work stays
  queued: call `advanceTo()` again to continue.
- **`execute` must throw on failure.** If it throws, that item stays pending,
  the clock stays at its time, the promise rejects with that error, and items
  that already succeeded in the same call stay completed. A callback that
  returns a Promise or thenable rejects with `TypeError` and the item stays
  pending; callbacks are never awaited, and other return values are ignored.
- **Callbacks cannot enqueue work:** while an `advanceTo()` is in flight, from a
  callback or elsewhere, `schedule()` and `advanceTo()` on the same scheduler
  reject. `now()` and `pendingCount()` may be called; a callback cannot await
  them, but with in-memory storage the promises resolve to the values at the
  time of the call.
- The scheduler does not choose handlers, call `executeInMemoryOperation()` for
  you, cancel work, or make queued work atomic with state changes.

### Resubmitting work

A `WorkItemId` names **one immutable work request for the storage's
lifetime**. Submitting the same request again is safe, before or after it runs,
so a caller that lost a `schedule()` reply can simply repeat it:

| Stored under the ID | Same request | Different request |
|---------------------|--------------|-------------------|
| Nothing | resolves `"accepted"`: queued as new work | — |
| Pending work | resolves `"already-pending"` | rejects `WorkIdConflictError` (`status: "pending"`) |
| A completion receipt | resolves `"already-completed"` | rejects `WorkIdConflictError` (`status: "completed"`) |

- **Same request** means the incoming work, after the usual validation, matches
  what was stored when the ID was first accepted: the same `at`, `moduleId`,
  `operation`, and `payloadVersion` (compared exactly, so `" op"` is not
  `"op"`), and a structurally equal `payload`: object keys may be in any
  order, but every nested value, array element order, and the
  array/object distinction must match. The insertion sequence is assigned by
  storage and is not compared.
- Validation runs first, so invalid input (for example a nested `-0` where the
  stored payload has `0`) rejects with `TypeError` or `RangeError`, never as a
  match or a conflict.
- A recognized repeat or a conflict **changes nothing**: no sequence is
  consumed, the original item keeps its sequence and queue position, and a
  receipt is not touched. The repeat of completed work is recognized even
  though its time is now in the past, and its callback is not run again.
- Storage still rejects inserting an occupied ID itself; the scheduler's
  lookup only classifies repeats. One scheduler per storage is still assumed.

**API change:** `schedule()` now resolves to `ScheduleOutcome`
(`"accepted" | "already-pending" | "already-completed"`) instead of `void`,
and an identical repeat now resolves instead of rejecting. A conflicting
repeat still rejects, now with `WorkIdConflictError` (an `Error`; messages
still say "is already pending" or "has already completed"). `SchedulerStorage`
has a new required method, `readWork(id)` (below).

**API change (from synchronous):** `schedule(work): void` →
`Promise<void>`, `advanceTo(...): AdvanceResult` → `Promise<AdvanceResult>`,
`now(): SimTime` → `Promise<SimTime>`, `pendingCount(): number` →
`Promise<number>`. The `InMemoryScheduler` type is now `Scheduler`.
`createInMemoryScheduler(initialTime?)` is unchanged.

### Scheduler storage

`createScheduler(storage)` is the one scheduler implementation;
`createInMemoryScheduler(t)` is `createScheduler(createInMemorySchedulerStorage(t))`.
The scheduler owns ordering, validation, and advancement policy. A
`SchedulerStorage` owns the authoritative data and only reads and changes it:

| Method | Reads or changes |
|--------|------------------|
| `readClock()`, `writeClock(now)` | The simulation clock |
| `readNextSequence()` | The next ordering sequence number |
| `insertPending(work, nextSequence)` | Adds a pending `StoredWork` (`id`, `at`, `sequence`, `request`) and sets the next sequence, together |
| `readDue(until, limit)` | At most `limit` pending items due at or before `until`, ordered by (`at`, `sequence`) |
| `countPending()` | The number of pending items |
| `readWorkIdStatus(id)` | `"pending"`, `"completed"`, or `undefined` |
| `readWork(id)` | `{ status, work }`: the pending `StoredWork`, or the original work of a completion receipt; `undefined` if unused |
| `markCompleted(id)` | Removes a pending item and keeps its ID as completed |

- Every method returns a Promise. The scheduler validates values before writing
  them; storage must return validated values, and returned objects belong to
  the caller. Storage rejects inserting an occupied ID or a sequence that does
  not increase or is not a nonnegative safe integer (including `-0`), and
  completing an ID that is not pending.
- **Ordering key:** `(at, sequence)`. `schedule()` assigns the stored next
  sequence and stores the next one, so sequences are never reused, even after
  the queue empties. Rejected work consumes none.
- **Commit points:** `schedule()` inserts once its checks pass. `advanceTo()`
  writes the clock before each callback, marks the item completed after the
  callback returns, and writes `target` to the clock if it reaches it.
- **Optional `runWork(work, run)`:** storage may instead run each item as a
  unit: set the clock to `work.at`, call `run()` (the callback), and mark the
  item completed together with whatever it collected, or, if `run()` throws,
  discard that, keep the item pending with the clock at `work.at`, and rethrow.
  The scheduler then calls it in place of the separate `writeClock()` and
  `markCompleted()`. In-memory and plain PostgreSQL storage do not define it;
  see [Atomic PostgreSQL operations](#atomic-postgresql-operations).
- **Lifetime:** storage outlives schedulers. A new `createScheduler(storage)`
  continues from the stored clock, pending work, next sequence, and completed
  IDs; it does not reset them. Use one scheduler per storage at a time.
- `createInMemorySchedulerStorage(initialTime?)` starts with the clock at
  `initialTime` (default `simTime(0)`), next sequence `0`, and no work. It keeps
  each completed item's original work as its receipt. Its data lives in that
  object and is never persisted.
- The fields correspond to `realmlib.runtime_state` (`now_ms`, `next_sequence`)
  and `realmlib.work_items` (`status` `'pending'` or `'completed'`; a completed
  item's time is the clock when it completed). See
  [PostgreSQL scheduler storage](#postgresql-scheduler-storage).

## Seeded randomness

`createSeededRandom` creates an independent pseudorandom stream from an explicit
seed or a snapshot. Passing a stream as the optional last argument of
`executeInMemoryOperation()` makes its draws part of the operation: they are
kept only if the operation commits.

```ts
import { createSeededRandom, executeInMemoryOperation } from "realmlib";
import type { OperationHandler, RandomSnapshot } from "realmlib";

// registry, store, and input as in "Executing an operation" above.
const random = createSeededRandom(12345); // unsigned 32-bit seed; never implicit

const roll: OperationHandler = (request, state, rng) => {
  state.set("roll", rng!.nextFloat()); // [0, 1)
};
executeInMemoryOperation(registry, store, input, roll, random); // draw committed with the state

const saved: RandomSnapshot = random.snapshot(); // { algorithm: "xoshiro128ss-v1", words: [...] }
const copy = createSeededRandom(JSON.parse(JSON.stringify(saved))); // continues identically
```

- **Not cryptographically secure.** The generator is xoshiro128\*\* 1.1 with
  realmlib's own seed expansion; the `"xoshiro128ss-v1"` tag pins the exact
  sequence, so equal seeds or snapshots always produce equal draws.
- `nextFloat()` returns a number in `[0, 1)` from one 32-bit output. Calling it
  directly on a stream advances that stream immediately.
- Seeds are integers `0` through `4_294_967_295`; snapshots must carry the known
  algorithm tag and four such words, not all zero. `-0` is rejected in both.
  Wrong types throw `TypeError`, out-of-range values `RangeError`; nothing is
  coerced. Snapshots are copied in and out, so mutating one never affects a stream.
- **Rollback on failure:** inside an operation the handler's third argument
  draws from a private working copy. If validation fails, the handler throws
  (including an invalid staged value) or returns a Promise or thenable, the
  stream keeps its pre-operation position, so a retry reproduces the same
  draws. On success the draws are committed with the state changes, even if
  the handler changed no state.
- The handler's source is valid only during the call; using it afterwards
  throws. While an operation holds a stream, drawing from it directly or
  executing another operation with it throws. Without a stream, the handler's
  third argument is `undefined`.
- Draws are covered only through the handler's source; a stream captured some
  other way is not rolled back. In a scheduler callback, pass the stream
  explicitly and keep throwing when execution returns `{ ok: false }`.

## PostgreSQL schema

[`migrations/001_initial_persistence.sql`](migrations/001_initial_persistence.sql)
defines durable storage for one simulation in a dedicated `realmlib` schema,
targeting **PostgreSQL 18**. It is a plain SQL asset: nothing in the library
imports or applies it. [PostgreSQL scheduler storage](#postgresql-scheduler-storage)
uses its `runtime_state` and `work_items` tables.

| Table                    | Holds                                                                 |
|--------------------------|-----------------------------------------------------------------------|
| `realmlib.runtime_state` | The singleton row (`singleton_id = 1`): simulation clock, next work sequence number, optional random snapshot, and stored-data format version |
| `realmlib.state_records` | The current value at each (module ID, key) address                     |
| `realmlib.work_items`    | Pending scheduled work and receipts of completed work, which keep their work ID and sequence; a partial index orders pending work by time, then sequence |

- **Not yet automated:** applying the migration (there is no runner or
  migration-history table) and creating the `runtime_state` row are left to
  the application. The file has no transaction control, so apply it in one
  transaction, for example `psql --single-transaction --file migrations/001_initial_persistence.sql`.
- **UTF8 only:** the migration raises an error, creating nothing, unless the
  database's `server_encoding` is `UTF8` (the encoding realmlib's text
  validation matches). Create the database with `ENCODING 'UTF8'` if your
  cluster's default differs.
- Values are stored as `JSON` (not `JSONB`) so serialized text is kept
  unchanged. Times, sequences, and payload versions are `BIGINT` limited to the
  JavaScript safe-integer range. These checks are a backstop: values must still
  be validated in JavaScript (for example, to reject `-0`) before writing and
  after reading.

The schema test is opt-in. It applies the migration to a **separate,
disposable** database inside a transaction, checks the constraints, and rolls
everything back; it refuses to run if a `realmlib` schema already exists. It
needs `psql` and is skipped unless the variable is set:

```sh
REALMLIB_TEST_DATABASE_URL=postgresql://user@host/realmlib_scratch bun test tests/postgres-schema.test.ts
```

## PostgreSQL scheduler storage

`createPostgresSchedulerStorage(client)` is a `SchedulerStorage` over the
migrated schema. Use it with `createScheduler()` exactly like in-memory storage.

```ts
import pg from "pg";
import { createPostgresSchedulerStorage, createScheduler, initializePostgresSchedulerStorage, simTime } from "realmlib";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }); // yours to create and end
await initializePostgresSchedulerStorage(pool, simTime(0)); // once, for a new simulation
const scheduler = createScheduler(createPostgresSchedulerStorage(pool));
// ... schedule() and advanceTo() as usual ...
await pool.end();
```

- **The caller owns the connection.** `client` is anything with
  `query(text, values) => Promise<{ rows }>`, such as a `pg` `Client`, `Pool`, or
  `PoolClient`. realmlib does not depend on or import `pg`, and creating storage
  runs no queries. Nothing opens or closes connections, reads the environment,
  applies the migration, or advances time for you.
- **Initialization is explicit.** `initializePostgresSchedulerStorage(client,
  initialTime?, random?)` inserts the `runtime_state` row (clock `initialTime`,
  default `simTime(0)`; next sequence `0`; random snapshot `random`, validated
  first, default none; format version `1`). It
  first requires `server_encoding` and the connection's `client_encoding` to be
  `UTF8`, and it rejects if the row already exists or `work_items` has rows, so
  it never overwrites. Storage methods reject when the row is missing; they never
  recreate it.
- **Columns used:** `runtime_state.now_ms`, `next_sequence`, and
  `format_version` (only `1` is accepted), plus every column of `work_items`.
  `markCompleted()` sets `status = 'completed'` and `completed_at_ms` to the
  **stored simulation clock**, never wall time, and keeps the row as the
  receipt, so its ID and sequence are never reused. The receipt keeps every
  request column, so `readWork()` returns the original request after
  completion, also from a new adapter or process. `random_snapshot` and
  `state_records` are used only by the
  [operation runtime](#atomic-postgresql-operations).
- `readDue()` is ordered by `(at_ms, sequence)` and limited in SQL.
  `insertPending()` inserts the row and advances `next_sequence` in **one
  statement**, so a duplicate ID, stale sequence, or failed insert consumes no
  sequence.
- **Validation:** inputs are validated before they are serialized (so `-0`,
  non-finite numbers, JavaScript-only whitespace such as U+00A0, U+0000, and
  unpaired surrogates are rejected; the schema's `btrim()` checks would accept
  the whitespace, and `pg` would silently replace an unpaired surrogate with
  U+FFFD). This matches exactly what a UTF8 database accepts, which is why
  initialization requires UTF8. A database's server encoding cannot change
  after creation, but each connection must also stay at the default UTF8
  `client_encoding`; do not override it with `client_encoding` or
  `PGCLIENTENCODING`. Values read
  back are validated too: BIGINT columns are read as text and must be decimal
  integers in their field's safe range, and JSON is read as text and must be a
  valid `StateValue`. Invalid persisted data rejects with `TypeError`. Database
  errors propagate; only a work-ID key violation is rethrown as a duplicate-ID
  `Error` whose `cause` is the original.
- **Not atomic across an operation by itself.** Each method is one statement,
  atomic by itself. This storage alone does not commit an operation's state
  changes, random draws, queue change, and clock together; the
  [operation runtime](#atomic-postgresql-operations) does. Resubmitting a
  `schedule()` is safe (see [Resubmitting work](#resubmitting-work)); nothing
  is retried automatically.
- **One driver per database.** Use one scheduler against a given database at a
  time. This is a precondition; it is not enforced, and concurrent drivers are
  not arbitrated.

Its tests run the shared storage contract plus PostgreSQL boundary cases. They
are opt-in under the same variable as the schema test: they apply the migration
to the named **disposable** database, refuse to run if a `realmlib` schema
already exists, and drop the schema afterwards. Without the variable they are
reported as skipped, not passed.

```sh
REALMLIB_TEST_DATABASE_URL=postgresql://user@host/realmlib_scratch bun test
```

`pg` and `@types/pg` are development dependencies, used only by these tests.

## Atomic PostgreSQL operations

`loadPostgresOperationRuntime(client)` makes the database, not an in-memory
copy, authoritative for scheduled operations: each successfully executed work
item commits **all** of its effects in **one PostgreSQL transaction**.

```ts
import pg from "pg";
import { createSeededRandom, initializePostgresSchedulerStorage, loadPostgresOperationRuntime, moduleId, simTime } from "realmlib";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL }); // yours to connect and end
await client.connect();
// Once, for a new simulation; the random stream is optional.
await initializePostgresSchedulerStorage(client, simTime(0), createSeededRandom(12345).snapshot());

const runtime = await loadPostgresOperationRuntime(client);
// registry and transfer as in "Executing an operation" above; schedule() as usual.
await runtime.scheduler.advanceTo(simTime(5_000), 100, (work) => {
  const outcome = runtime.execute(registry, work.request, transfer);
  if (!outcome.ok) throw new Error(`rejected: ${outcome.reason}`);
});
runtime.read(moduleId("module-a"), "from"); // committed value
await client.end();
```

- **Transaction boundary:** one per executed item: `BEGIN`; set `now_ms` to the
  item's time; the callback runs; upsert or delete its module's
  `state_records`; write `random_snapshot` (if a stream is configured);
  complete the `work_items` row (`completed_at_ms` is the clock inside the
  transaction, so the item's time); `COMMIT`. A multi-item `advanceTo()` is not
  one transaction: earlier items stay committed if a later one fails. Advancing
  the clock to the target, or with no work, is its own single statement, as
  before. Execution never changes `next_sequence`, because callbacks cannot
  schedule work.
- **One dedicated connection:** `client` must be a single connection, such as
  a `pg` `Client` or a `PoolClient` held for the runtime's lifetime, not inside
  a transaction and not used by anything else meanwhile. A `pg` `Pool` is
  refused, because each of its queries may use a different connection.
  Creating, releasing, and closing the connection, applying the migration, and
  initializing remain the caller's job. Nothing happens at import.
- **Loading** reads `state_records` and `random_snapshot` in one read-only
  transaction, validating them like any persisted data (for example, `-0` or an
  invalid snapshot rejects with `TypeError`). Handlers read state
  synchronously, so the runtime keeps these committed values in memory.
- **Visible only after `COMMIT`:** `runtime.execute()` stages the handler's
  changes and draws exactly as `executeInMemoryOperation()` does, with the same
  validation, ownership, and copying. They are published to `read()`,
  `randomSnapshot()`, and later handlers only after `COMMIT` succeeds;
  otherwise they are discarded, so a failed attempt consumes no draws.
- **Handler failure** (the callback throws or returns a thenable): the
  transaction rolls back, then the clock is set to the item's time by a
  separate statement, matching the scheduler's established behavior. The item
  stays pending and its ID reserved; the error propagates.
- **Database failure** before `COMMIT`: the transaction rolls back, including
  its clock change, and the database error propagates; the clock is not moved
  separately. If `COMMIT` itself is rejected by the server (for example by a
  deferred constraint), nothing committed and the runtime stays usable.
- **Unknown outcome:** if `COMMIT` fails without the server reporting an error
  (for example the reply is lost with the connection), that is not taken as a
  rollback, and the staged effects are never published. The runtime sends
  `ROLLBACK` (which never commits; it ends a transaction whose `COMMIT` never
  arrived), then, on the same connection, reads the item's `work_items` row,
  `state_records`, and `random_snapshot` in one read-only snapshot, checking
  that it is not inside the item's transaction. It compares the row with the
  work being executed (ID, time, sequence, module, operation, payload version,
  and payload, as in [Resubmitting work](#resubmitting-work)):
  - **Completed**, matching, with `completed_at_ms` at the item's time: the
    item committed. The in-memory state and random stream are replaced by the
    values just read, and `advanceTo()` continues with the next item. The
    handler is not run again.
  - **Pending**, matching: it did not commit. The in-memory views are replaced
    by the values read (unchanged, since nothing committed), and `advanceTo()`
    rejects with `CommitNotConfirmedError`, whose `cause` is the `COMMIT`
    error. The item stays pending with the clock where it was before the item
    (as for any database failure); it is **not** run again until you call
    `advanceTo()` again. The runtime stays usable.
  - **Anything else** (the `ROLLBACK` or the read fails, for example because
    the connection is gone; the row is missing, unreadable, or holds a
    different request or completion time): `CommitOutcomeUnknownError`, and
    the runtime refuses all further use, including `read()` and its
    scheduler. Load a new runtime on a working connection: it reads the
    durable outcome, and resubmitting the request then reports
    `"already-pending"` or `"already-completed"`. A failed `ROLLBACK` after a
    handler failure likewise makes the runtime unusable.

  There is no reconnection or retry loop: only the one connection the runtime
  was given is used.
- **One operation per item:** `runtime.execute()` works only inside a callback
  of `runtime.scheduler` (or another scheduler over `runtime.storage`), at most
  once per item. A callback that runs no operation completes with only its
  clock and receipt.
- **Not covered:** external side effects of handlers (the database guarantee
  covers only the simulation's database effects, not exactly-once delivery),
  automatic retries, crash recovery, and concurrent drivers. Use one runtime
  per database at a time.

**API additions:** `loadPostgresOperationRuntime`, `PostgresOperationRuntime`,
`CommitOutcomeUnknownError`; an optional `runWork()` on `SchedulerStorage`; an
optional third `random` argument to `initializePostgresSchedulerStorage()`.
Existing signatures and in-memory behavior are unchanged.

**Later additions:** `CommitNotConfirmedError`; `CommitOutcomeUnknownError` is
now thrown only when the durable record does not settle the outcome. See also
the `schedule()` changes under [Resubmitting work](#resubmitting-work).
