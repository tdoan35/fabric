// Data contracts for the runtime store (RUNTIME §2). The envelope mirrors
// @fabric/core's `TypedEvent`: what readStream returns must pass `parseEvent` as-is.
export type Row = Record<string, unknown>;

/** A handle inside `store.transaction`; every query runs in the enclosing transaction. */
export interface RuntimeTx {
  query(sql: string, params?: readonly unknown[]): Promise<Row[]>;
  /** Hooks run once the enclosing transaction has committed; never on rollback. */
  onCommit(hook: () => unknown): void;
}

/** One event as the caller appends it; `id`, `ts` and `seq` are the store's. */
export interface EventInput {
  type: string;
  actor: string;
  payload: unknown;
  /** Payload version; defaults to 1. */
  v?: number;
  /** The job that produced the event, or null/absent for API appends. */
  causation?: string | null;
}

export interface AppendBatch {
  streamId: string;
  events: readonly EventInput[];
}

/** Per-batch outcome, aligned with the batches passed to `append`. */
export interface AppendResult {
  duplicate: boolean;
}

/** The queue port (R6/R8): called inside the transaction for every fact-bearing stream. */
export type EnqueuePort = (
  tx: RuntimeTx,
  job: { type: string; streamId: string }
) => void | Promise<void>;

export interface AppendOptions {
  /** Called after commit, once per touched stream, with `<workspace>:<stream>:<seq>`. */
  onNotify?: (note: string) => unknown;
  /** The queue port; invoked inside the transaction with `decide` jobs. */
  enqueue?: EnqueuePort;
}

export interface ReadStreamOptions {
  workspaceId: string;
  /** First sequence number to return (inclusive). */
  fromSeq?: number;
  /** Drop telemetry, returning only the events the fold reads. */
  factsOnly?: boolean;
}

/** A stored event: exactly the envelope `parseEvent` accepts. */
export interface StoredEvent {
  id: string;
  workspaceId: string;
  streamId: string;
  seq: number;
  type: string;
  class: string;
  v: number;
  actor: string;
  causation: string | null;
  ts: string;
  payload: unknown;
}

export type StoreConfig =
  | { driver: "pglite"; dataDir?: string }
  | { driver: "postgres"; url: string };

export interface RuntimeStore {
  /** Runs `fn` inside one transaction; a throw rolls everything back. */
  transaction<T>(fn: (tx: RuntimeTx) => Promise<T>): Promise<T>;
  /** The stream's events in `seq` order, scoped to the workspace. */
  readStream(streamId: string, options: ReadStreamOptions): Promise<StoredEvent[]>;
  close(): Promise<void>;
}
