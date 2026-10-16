// Data contracts for the runtime queue (RUNTIME §4, ANY-32). Time is injected:
// every method that depends on "now" takes it as a parameter, and no
// implementation reads the clock — tests stay deterministic.

/** The slice of the host transaction a Queue plugs into. Queue writes are
 * buffered and land exactly when the host commits — never on rollback. The
 * runtime store's `RuntimeTx` satisfies this structurally. */
export interface QueueTx {
  /** Registered at most once per hook; runs when the host commits, never on rollback. */
  onCommit(hook: () => unknown): void;
}

/** One job as the caller enqueues it; the id is the queue's. */
export interface QueueJobInput {
  /** Job type — the rows of RUNTIME §4's two tables key on it. */
  type: string;
  /** Idempotency key: at most one live (pending or leased) job per key. */
  key: string;
  /** Owning stream, for the per-stream serial types. */
  streamId?: string;
  workspaceId: string;
  /** Injected-clock instant the job becomes claimable; defaults to 0 (at once). */
  runAt?: number;
  payload?: unknown;
}

export type QueueJobStatus = "pending" | "leased" | "completed" | "dead";

/** One job as the queue stores it; `get` returns this view. */
export interface QueueJob {
  id: string;
  type: string;
  key: string;
  streamId: string | null;
  workspaceId: string;
  runAt: number;
  payload?: unknown;
  status: QueueJobStatus;
  /** Runs started, including the current lease. */
  attempts: number;
  /** Message of the last failure; null until one. */
  lastError: string | null;
}

/** Permission to run one job once, returned by `claim`. */
export interface QueueLease {
  jobId: string;
  /** The 1-based run the lease covers; a reclaimed job leases as attempt+1. */
  attempt: number;
  workerId: string;
  type: string;
  key: string;
  streamId: string | null;
  workspaceId: string;
  /** The claim's identity, epoch ms (T16): the fence beyond the (worker id,
   * attempt) pair, which a defer's re-claim hands back unchanged — the lease
   * that deferred must read as stale against the job it left, on every
   * adapter. Only leases built by hand in tests may leave it unset; those
   * keep the pair-only fence. */
  claimAt?: number;
}

/** Per-type tuning: RUNTIME §4's second table. */
export interface QueueTypeConfig {
  /** Hard cap on one run, measured from the claim. */
  maxRunMs: number;
  /** Heartbeat interval. null: the type is not heartbeated, and the lease
   * window is the whole max run. */
  heartbeatMs: number | null;
  /** Retries after the initial run; Infinity for the run-until-done types. */
  maxRetries: number;
  /** Delay before retry n: min(retryBackoffMs * 2^(n-1), retryBackoffMaxMs). */
  retryBackoffMs: number;
  retryBackoffMaxMs?: number;
  /** At most one leased run per (type, stream) — decide's serial queue. */
  serialPerStream?: boolean;
}

/** RUNTIME §4's second table, as defaults. Starting values; the spike adjusts
 * them. The conformance suite pins these numbers — change the two together. */
export const DEFAULT_TYPE_CONFIGS: Record<string, QueueTypeConfig> = {
  decide: {
    maxRunMs: 30_000,
    heartbeatMs: null,
    maxRetries: 3,
    retryBackoffMs: 1_000,
    serialPerStream: true,
  },
  "llm.call": { maxRunMs: 600_000, heartbeatMs: 60_000, maxRetries: 2, retryBackoffMs: 60_000 },
  "tool.exec": { maxRunMs: 3_660_000, heartbeatMs: 30_000, maxRetries: 3, retryBackoffMs: 30_000 },
  "delegate.resolve": {
    maxRunMs: 30_000,
    heartbeatMs: null,
    maxRetries: Number.POSITIVE_INFINITY,
    retryBackoffMs: 30_000,
  },
  "run.finalize": {
    maxRunMs: 30_000,
    heartbeatMs: null,
    maxRetries: Number.POSITIVE_INFINITY,
    retryBackoffMs: 30_000,
  },
  deliver: {
    maxRunMs: 30_000,
    heartbeatMs: null,
    maxRetries: Number.POSITIVE_INFINITY,
    retryBackoffMs: 60_000,
    retryBackoffMaxMs: 86_400_000,
  },
};

/** Fallback for the types the second table does not name (run.timer,
 * schedule.fire, learn, skills.maintain, org.review, ...). */
export const DEFAULT_TYPE_CONFIG: QueueTypeConfig = {
  maxRunMs: 300_000,
  heartbeatMs: null,
  maxRetries: 3,
  retryBackoffMs: 30_000,
};

/** Concurrent leased runs allowed in one workspace. */
export const DEFAULT_PER_WORKSPACE_CONCURRENCY = 4;

export interface QueueOptions {
  /** Concurrent leased runs allowed in one workspace. */
  perWorkspaceConcurrency?: number;
  /** Per-type overrides, merged onto the defaults above. */
  typeConfigs?: Record<string, Partial<QueueTypeConfig>>;
}

/** Builds a queue for the conformance suite (or production). */
export type QueueFactory = (options?: QueueOptions) => Queue;

/** The options of `claimWaiting`, the idle wait's single call. */
export interface ClaimWaitingOptions {
  /** Longest sleep after an empty claim, when no wake, due time or lease
   * expiry fires first. The backstop covers a lost wake; it is not the
   * cadence. */
  backstopMs: number;
  /** Injected clock, as everywhere: the queue never reads the clock itself. */
  now: () => number;
  /** Aborting returns `null` promptly, before or during the wait. */
  signal?: AbortSignal;
}

export interface Queue {
  /** Buffers the job into the tx: it exists once the host commits, and one
   * live job per `key` holds — a duplicate enqueue is a no-op returning the
   * live job. A completed or dead key may be re-enqueued as a new job. */
  enqueue(tx: QueueTx, job: QueueJobInput): Promise<QueueJob>;
  /** Leases the oldest eligible job — pending past `runAt`, or leased with a
   * lapsed lease (a reclaim, as attempt+1) — honouring the type filter, the
   * per-stream serial rule and the per-workspace cap. Null when none. */
  claim(workerId: string, types: readonly string[], now: number): Promise<QueueLease | null>;
  /** Extends the lease: heartbeat window from `now`, inside the max-run cap.
   * Throws on a stale lease (job since reclaimed, completed or failed). */
  heartbeat(lease: QueueLease, now: number): Promise<void>;
  /** Puts the leased job back to pending at `runAt` without failing it (T16):
   * the attempt is given back, so the next claim re-leases the SAME attempt —
   * a queue wait never becomes a retry — and the retry bookkeeping is
   * untouched. Throws on a stale lease, as `complete` does. */
  defer(tx: QueueTx, lease: QueueLease, runAt: number): Promise<void>;
  /** Marks the job done — buffered into the tx like any other write, so a
   * rollback leaves it leased and later reclaimable. Throws on a stale lease. */
  complete(tx: QueueTx, lease: QueueLease): Promise<void>;
  /** Records the failure. Retryable jobs requeue with backoff until the type's
   * retries run out, then go dead with the last error; non-retryable ones go
   * dead at once. Throws on a stale lease. */
  fail(
    lease: QueueLease,
    error: Error,
    options: { retryable: boolean },
    now: number,
  ): Promise<void>;
  /** The public view of one job, for ops surfaces and the conformance suite. */
  get(jobId: string): Promise<QueueJob | null>;
  /** The idle wait (R17), when the implementation supports it: claim once;
    * on an empty board sleep until the earliest of a wake, the backstop, the
    * earliest pending `run_at` after now, or the earliest running
    * `lease_until` — all among `types` — then claim again. Returns `null`
    * promptly when `signal` aborts. Absent: the caller polls `claim`. */
  claimWaiting?(
    workerId: string,
    types: readonly string[],
    options: ClaimWaitingOptions,
  ): Promise<QueueLease | null>;
}
