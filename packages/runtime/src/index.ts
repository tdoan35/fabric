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
