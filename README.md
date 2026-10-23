# realmlib

`realmlib` is an independently maintained shared TypeScript library for Lattice
simulation infrastructure. It is intended to be imported by `edgelord` and other
Bun programs without depending on either.

It currently provides foundational value types (identifiers and simulation
time), a registry for validating operation requests, an in-memory
module state store, atomic execution of a single operation against that
store, a manually advanced in-memory scheduler, and seeded random streams
whose draws commit with an operation; it contains **no simulation
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
- Keys are nonblank, case-sensitive strings. Values must be `null`, booleans,
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

An in-memory scheduler queues operation requests for simulation times and runs
them **only when you advance it**, through a callback you supply to that call.
There are no timers, no wall-clock reads, and no background work.

```ts
import { createInMemoryScheduler, executeInMemoryOperation, moduleId, simTime, workItemId } from "realmlib";

// registry, store, and transfer as in "Executing an operation" above.
const scheduler = createInMemoryScheduler(); // clock at simTime(0); or pass a starting SimTime

scheduler.schedule({
  id: workItemId("job-1"),
  at: simTime(1_000),
  request: { moduleId: moduleId("module-a"), operation: "transfer", payloadVersion: 1, payload: 4 },
});

const result = scheduler.advanceTo(simTime(5_000), 100, (work) => {
  // Throw on failure: a normal return counts as success and removes the item.
  const outcome = executeInMemoryOperation(registry, store, work.request, transfer);
  if (!outcome.ok) throw new Error(`rejected: ${outcome.reason}`);
});
result; // { now: 5000, executed: 1, reachedTarget: true }
```

- `schedule(work)` validates the work ID, time (not earlier than `now()`), and
  request envelope (module ID, nonblank operation name, positive safe-integer
  version) and stores a **copy**. The payload must be a `StateValue` (see
  [In-memory module state](#in-memory-module-state)). Validation is structural
  only: the registry is not consulted. Work IDs are **unique for the
  scheduler's lifetime**: an ID may not be reused while it is pending or after
  it has completed (the scheduler remembers every completed ID). Invalid input
  or a duplicate throws and changes nothing.
- `advanceTo(target, maxOperations, execute)` runs items due **at or before**
  `target`, ordered by time and then by insertion order. Before each callback,
  `now()` is set to that item's time. Each callback receives a fresh copy of
  the work. `maxOperations` must be a positive safe integer.
- When all due work has run, the clock moves to `target` and `reachedTarget` is
  `true`. If the limit stops it first, `reachedTarget` is `false`, the clock
  stays at the last executed item's time, and the remaining due work stays
  queued: call `advanceTo()` again to continue.
- **`execute` must throw on failure.** If it throws, that item stays pending,
  the clock stays at its time, the error propagates, and items that already
  succeeded in the same call stay completed. A callback that returns a Promise
  or thenable throws `TypeError` and the item stays pending; callbacks are never
  awaited, and other return values are ignored.
- **Callbacks cannot enqueue work:** calling `schedule()` or `advanceTo()` on the
  same scheduler during a callback throws. `now()` and `pendingCount()` may be
  read.
- The scheduler does not choose handlers, call `executeInMemoryOperation()` for
  you, persist its queue, cancel work, or make queued work atomic with state
  changes.

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
imports it, connects to a database, or uses its tables yet.

| Table                    | Holds                                                                 |
|--------------------------|-----------------------------------------------------------------------|
| `realmlib.runtime_state` | The singleton row (`singleton_id = 1`): simulation clock, next work sequence number, optional random snapshot, and stored-data format version |
| `realmlib.state_records` | The current value at each (module ID, key) address                     |
| `realmlib.work_items`    | Pending scheduled work and receipts of completed work, which keep their work ID and sequence; a partial index orders pending work by time, then sequence |

- **Not yet automated:** applying the migration (there is no runner or
  migration-history table) and creating the `runtime_state` row are left to
  the application. The file has no transaction control, so apply it in one
  transaction, for example `psql --single-transaction --file migrations/001_initial_persistence.sql`.
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
