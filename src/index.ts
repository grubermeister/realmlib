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
export { createInMemoryScheduler } from "./in-memory-scheduler.ts";
export type { AdvanceResult, InMemoryScheduler, ScheduledWork } from "./in-memory-scheduler.ts";
