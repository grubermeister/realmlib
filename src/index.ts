/**
 * Public entry point for the realmlib simulation library.
 * Importing this module must have no application or runtime side effects.
 */
export { entityId, moduleId, workItemId } from "./identifiers.ts";
export type { EntityId, ModuleId, WorkItemId } from "./identifiers.ts";
export { simTime } from "./sim-time.ts";
export type { SimTime } from "./sim-time.ts";
export { createModuleRegistry } from "./module-registry.ts";
export type {
  ModuleDefinition,
  ModuleRegistry,
  OperationDefinition,
  OperationRequest,
  OperationValidationResult,
} from "./module-registry.ts";
export { createInMemoryStateStore } from "./in-memory-state.ts";
export type { InMemoryStateStore, ModuleStateAccess, StateValue } from "./in-memory-state.ts";
export { executeInMemoryOperation } from "./execute-in-memory-operation.ts";
export type { OperationHandler } from "./execute-in-memory-operation.ts";
export { createScheduler } from "./scheduler.ts";
export type {
  AdvanceResult,
  ScheduledWork,
  Scheduler,
  SchedulerStorage,
  StoredWork,
  WorkIdStatus,
} from "./scheduler.ts";
export { createInMemoryScheduler, createInMemorySchedulerStorage } from "./in-memory-scheduler.ts";
export { createPostgresSchedulerStorage, initializePostgresSchedulerStorage } from "./postgres-scheduler-storage.ts";
export type { PostgresQueryable } from "./postgres-scheduler-storage.ts";
export { createSeededRandom } from "./seeded-random.ts";
export type { RandomSnapshot, RandomSource, SeededRandom } from "./seeded-random.ts";
