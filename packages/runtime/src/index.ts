// @fabric/runtime — durable event-log storage (RUNTIME §2): streams of events on PGlite
// and Postgres behind one driver seam, with transactional append and scoped reads.
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
