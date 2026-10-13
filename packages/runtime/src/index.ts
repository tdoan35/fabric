// @fabric/runtime — durable event-log storage (RUNTIME §2): streams of events on PGlite
// and Postgres behind one driver seam, with transactional append and scoped reads —
// plus the job queue contracts and conformance suite (RUNTIME §4, ANY-32).
export { openStore, append } from "./store/store";
export type {
  AppendBatch,
  AppendOptions,
  AppendResult,
  EnqueuePort,
  EventInput,
  ReadStreamOptions,
  RuntimeStore,
  RuntimeTx,
  StoreConfig,
  StoredEvent,
} from "./store/types";

// Queue (RUNTIME §4): the interface any implementation honours, the in-memory
// reference implementation, and the conformance suite it must pass.
export { MemoryQueue } from "./queue/memory";
export { PgQueue } from "./queue/pg";
export type { PgQueueConnection, PgQueueOptions } from "./queue/pg";
export { queueConformanceCases, runQueueConformance } from "./queue/conformance";
export {
  DEFAULT_PER_WORKSPACE_CONCURRENCY,
  DEFAULT_TYPE_CONFIG,
  DEFAULT_TYPE_CONFIGS,
} from "./queue/types";
export type {
  Queue,
  QueueFactory,
  QueueJob,
  QueueJobInput,
  QueueJobStatus,
  QueueLease,
  QueueOptions,
  QueueTx,
  QueueTypeConfig,
} from "./queue/types";

// Worker ports (RUNTIME §4–§6, ANY-35 R9a): the seams the job handlers run
// behind, so no test or CI run reaches a real provider.
export { ModelError } from "./ports";
export type {
  ModelCallRequest,
  ModelDelta,
  ModelMessage,
  ModelPort,
  ModelResult,
  ModelTool,
  ModelUsage,
  SurfaceMessage,
  SurfacePort,
  SurfaceReceipt,
  ToolDescriptor,
  ToolEffect,
  ToolPort,
  ToolRunResult,
} from "./ports";

// The first job handlers (ANY-35 R9a): `decide` and `ll.call`.
export {
  handleDecideJob,
  type DecideJobDeps,
  type EventRow,
} from "./workers/index";
export { handleLlmCallJob, type LlmCallJobDeps } from "./workers/index";
export { handleToolExecJob, type ToolExecJobDeps } from "./workers/index";
