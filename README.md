# realmlib

`realmlib` is an independently maintained shared TypeScript library for Lattice
simulation infrastructure. It is intended to be imported by `edgelord` and other
Bun programs without depending on either.

It currently provides only foundational value types (identifiers and simulation
time); it contains **no simulation engine or behavior**.

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
