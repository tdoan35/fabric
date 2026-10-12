// In-memory reference Queue (ANY-32 R6): the conformance suite's first
// customer, for tests. No real transactions — writes are staged against the
// host tx and land through its commit hooks; a rollback is just hooks that
// never run. Time is injected; the queue never reads the clock.
import {
  DEFAULT_PER_WORKSPACE_CONCURRENCY,
  DEFAULT_TYPE_CONFIG,
  DEFAULT_TYPE_CONFIGS,
} from "./types";
import type {
  Queue,
  QueueJob,
  QueueJobInput,
  QueueLease,
  QueueOptions,
  QueueTx,
  QueueTypeConfig,
} from "./types";

/** One job as stored, plus the lease bookkeeping the public view omits. */
interface MemJob extends QueueJob {
  leaseWorkerId: string | null;
  /** Injected-clock instant the current lease laps at; null while unleased. */
  leaseExpiresAt: number | null;
  /** Injected-clock instant of the current claim; anchors the max-run cap. */
  leaseClaimedAt: number | null;
}

function publicView(job: MemJob): QueueJob {
  return {
    id: job.id,
    type: job.type,
    key: job.key,
    streamId: job.streamId,
    workspaceId: job.workspaceId,
    runAt: job.runAt,
    payload: job.payload,
    status: job.status,
    attempts: job.attempts,
    lastError: job.lastError,
  };
}

export class MemoryQueue implements Queue {
  readonly #jobs = new Map<string, MemJob>();
  readonly #configs: Map<string, QueueTypeConfig>;
  readonly #perWorkspaceConcurrency: number;
  #seq = 0;

  constructor(options: QueueOptions = {}) {
    this.#perWorkspaceConcurrency =
      options.perWorkspaceConcurrency ?? DEFAULT_PER_WORKSPACE_CONCURRENCY;
    this.#configs = new Map(Object.entries(DEFAULT_TYPE_CONFIGS));
    for (const [type, override] of Object.entries(options.typeConfigs ?? {})) {
      const base = this.#configs.get(type) ?? DEFAULT_TYPE_CONFIG;
      this.#configs.set(type, { ...base, ...override });
    }
  }

  async enqueue(tx: QueueTx, job: QueueJobInput): Promise<QueueJob> {
    const duplicate = this.liveWithKey(job.key) as MemJob | undefined;
    if (duplicate) return publicView(duplicate);
    const record: MemJob = {
      id: `qjob-${++this.#seq}`,
      type: job.type,
      key: job.key,
      streamId: job.streamId ?? null,
      workspaceId: job.workspaceId,
      runAt: job.runAt ?? 0,
      payload: job.payload,
      status: "pending",
      attempts: 0,
      lastError: null,
      leaseWorkerId: null,
      leaseExpiresAt: null,
      leaseClaimedAt: null,
    };
    // Buffered until the host commits. The duplicate check runs again at apply
    // time, so two enqueues of one key inside a single tx still land as one.
    tx.onCommit(() => {
      if (this.liveWithKey(record.key)) return;
      this.#jobs.set(record.id, record);
    });
    return publicView(record);
  }

  async claim(workerId: string, types: readonly string[], now: number): Promise<QueueLease | null> {
    const wanted = new Set(types);
    const leasedPerWorkspace = new Map<string, number>();
    for (const job of this.#jobs.values()) {
      if (job.status === "leased") {
        leasedPerWorkspace.set(job.workspaceId, (leasedPerWorkspace.get(job.workspaceId) ?? 0) + 1);
      }
    }
    // Oldest runAt first; equal runAt keeps enqueue order (sort is stable).
    const eligible = [...this.#jobs.values()]
      .filter((job) => wanted.has(job.type))
      .filter(
        (job) =>
          (job.status === "pending" && job.runAt <= now) ||
          (job.status === "leased" && this.leaseExpired(job.leaseExpiresAt, now)),
      )
      .sort((a, b) => a.runAt - b.runAt);
    for (const job of eligible) {
      if (this.hasParallelSerialLease(job)) continue;
      const leased = leasedPerWorkspace.get(job.workspaceId) ?? 0;
      if (leased >= this.#perWorkspaceConcurrency) continue;
      job.attempts += 1;
      job.status = "leased";
      job.leaseWorkerId = workerId;
      job.leaseClaimedAt = now;
      this.refreshLease(job, job.leaseClaimedAt, now);
      return {
        jobId: job.id,
        attempt: job.attempts,
        workerId,
        type: job.type,
        key: job.key,
        streamId: job.streamId,
        workspaceId: job.workspaceId,
      };
    }
    return null;
  }

  async heartbeat(lease: QueueLease, now: number): Promise<void> {
    const job = this.requireCurrentLease(lease);
    this.refreshLease(job, job.leaseClaimedAt ?? now, now);
  }

  async complete(tx: QueueTx, lease: QueueLease): Promise<void> {
    const job = this.requireCurrentLease(lease);
    tx.onCommit(() => {
      // Re-checked at apply time: the lease may have been lost since.
      if (this.isCurrentLease(job, lease)) {
        job.status = "completed";
        this.clearLease(job);
      }
    });
  }

  async fail(
    lease: QueueLease,
    error: Error,
    options: { retryable: boolean },
    now: number,
  ): Promise<void> {
    const job = this.requireCurrentLease(lease);
    const config = this.configFor(job.type);
    job.lastError = error.message;
    if (options.retryable && job.attempts <= config.maxRetries) {
      const backoff = Math.min(
        config.retryBackoffMs * 2 ** (job.attempts - 1),
        config.retryBackoffMaxMs ?? Number.MAX_SAFE_INTEGER,
      );
      job.status = "pending";
      job.runAt = now + backoff;
      this.clearLease(job);
    } else {
      job.status = "dead";
      this.clearLease(job);
    }
  }

  async get(jobId: string): Promise<QueueJob | null> {
    const job = this.#jobs.get(jobId);
    return job ? publicView(job) : null;
  }

  /** Seam for the mutants: does a second leased run on this serial pair exist?
   * Overriding to always-false removes per-stream serialisation (QM1). */
  protected hasParallelSerialLease(job: QueueJob): boolean {
    if (job.streamId === null) return false;
    if (this.configFor(job.type).serialPerStream !== true) return false;
    return [...this.#jobs.values()].some(
      (other) =>
        other !== job &&
        other.status === "leased" &&
        other.type === job.type &&
        other.streamId === job.streamId,
    );
  }

  /** Seam for the mutants: has this lease lapsed? Overriding to always-false
   * makes leases immortal (QM2). */
  protected leaseExpired(expiresAt: number | null, now: number): boolean {
    return expiresAt !== null && expiresAt <= now;
  }

  /** Seam for the mutants: the live job holding this key. Overriding to
   * always-undefined drops enqueue dedupe (QM3). */
  protected liveWithKey(key: string): QueueJob | undefined {
    for (const job of this.#jobs.values()) {
      if (job.key === key && (job.status === "pending" || job.status === "leased")) return job;
    }
    return undefined;
  }

  private configFor(type: string): QueueTypeConfig {
    return this.#configs.get(type) ?? DEFAULT_TYPE_CONFIG;
  }

  /** Silence window from `now`, capped by the max run from the claim. */
  private refreshLease(job: MemJob, claimedAt: number, now: number): void {
    const config = this.configFor(job.type);
    const silence = config.heartbeatMs ?? Number.MAX_SAFE_INTEGER;
    job.leaseExpiresAt = Math.min(now + silence, claimedAt + config.maxRunMs);
  }

  private isCurrentLease(job: MemJob, lease: QueueLease): boolean {
    return (
      job.status === "leased" &&
      job.leaseWorkerId === lease.workerId &&
      job.attempts === lease.attempt
    );
  }

  private requireCurrentLease(lease: QueueLease): MemJob {
    const job = this.#jobs.get(lease.jobId);
    if (!job || !this.isCurrentLease(job, lease)) {
      throw new Error(
        `stale lease: job ${lease.jobId} is not leased to ${lease.workerId} at attempt ${lease.attempt}`,
      );
    }
    return job;
  }

  private clearLease(job: MemJob): void {
    job.leaseWorkerId = null;
    job.leaseExpiresAt = null;
    job.leaseClaimedAt = null;
  }
}
