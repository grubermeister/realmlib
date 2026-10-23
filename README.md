# realmlib

`realmlib` is an independently maintained shared TypeScript library for Lattice
simulation infrastructure. It is intended to be imported by `edgelord` and other
Bun programs without depending on either.

It currently provides foundational value types (identifiers and simulation
time), a registry for validating operation requests, and an in-memory
module state store; it contains **no
simulation engine or behavior**.

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
registration and validation are all it does.

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
- Changes are **immediate and in-memory only**: there is no persistence,
  multi-record atomicity, or rollback. The store does not use the module
  registry.
- Keys are nonblank, case-sensitive strings. Values must be `null`, booleans,
  strings, finite numbers other than `-0`, dense arrays, or plain objects of these. Anything
  else (`undefined`, `NaN`, class instances, `Date`, cycles, accessors, …)
  throws `TypeError` and leaves the existing record unchanged.
- Values are copied on `set` and on `get`, so mutating an input or a returned
  value never changes stored state.
