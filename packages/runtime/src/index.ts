// @fabric/runtime — durable event-log storage (RUNTIME §2): streams of events on PGlite
// and Postgres behind one driver seam, with transactional append and scoped reads —
// plus the job queue contracts and conformance suite (RUNTIME §4, ANY-32).
export { openStore, append } from "./store/store";
export { listStreams, type ListedStream, type ListStreamsOptions } from "./store/list";
export { redactStream, ERASED, type RedactOptions } from "./store/redact";
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
// The remaining handlers and the worker loop (ANY-40 R9c).
export { handleDelegateResolveJob, type DelegateResolveJobDeps } from "./workers/index";
export { handleDeliverJob, type DeliverJobDeps } from "./workers/index";
export { runWorker, runUntilIdle, WORKER_JOB_TYPES, type WorkerOptions, type WorkerPorts } from "./workers/loop";

// The timer worker, the wait/cancel API and the append guard (ANY-36 R10).
// The timer handler is exported from its own module: the workers barrel lists
// the loop-dispatched handlers, and `run.timer` is claimed explicitly until
// the loop learns the type.
export { handleTimerJob, type TimerJobDeps } from "./workers/timer";
export { appendGuarded, cancel, type AppendGuardResult, type CancelOptions } from "./api/cancel";
export { respond } from "./api/respond";
export type { RespondOptions, RespondResult, RefusalReason } from "./api/respond";
