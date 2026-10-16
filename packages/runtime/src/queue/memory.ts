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
  ClaimWaitingOptions,
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
      this.#wake();
    });
    return publicView(record);
  }

  async claim(workerId: string, types: readonly string[], now: number): Promise<QueueLease | null> {
    const lease = this.claimSync(workerId, types, now);
    if (lease !== null) {
      // A new lease moves the idle-wait horizon (its expiry); wake the waiters.
      this.#wake();
    }
    return lease;
  }

  /** The claim, synchronously: shared by `claim` and the idle wait. */
  private claimSync(workerId: string, types: readonly string[], now: number): QueueLease | null {
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
        // The claim's identity (T16): the fence beyond (worker, attempt) —
        // a defer's re-claim hands the same pair back, and the lease that
        // deferred must read as stale against the job it left.
        claimAt: now,
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
      this.#wake();
    });
  }

  async defer(tx: QueueTx, lease: QueueLease, runAt: number): Promise<void> {
    const job = this.requireCurrentLease(lease);
    tx.onCommit(() => {
      // Re-checked at apply time: the lease may have been lost since.
      if (this.isCurrentLease(job, lease)) {
        job.status = "pending";
        job.runAt = runAt;
        // The attempt goes back: the run did no work, so the next claim
        // re-leases the same attempt and no recovery is owed.
        job.attempts = Math.max(0, job.attempts - 1);
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
    this.#wake();
  }

  async get(jobId: string): Promise<QueueJob | null> {
    const job = this.#jobs.get(jobId);
    return job ? publicView(job) : null;
  }

  /** The idle wait (R17): claim; on an empty board sleep until the earliest of
   * a wake, the backstop, the next due `run_at` or the next lease expiry —
   * among `types` — then claim again. `signal` aborting returns null
   * promptly, before or during a wait. */
  async claimWaiting(
    workerId: string,
    types: readonly string[],
    options: ClaimWaitingOptions
  ): Promise<QueueLease | null> {
    const unique = [...new Set(types)];
    if (unique.length === 0) return null;
    for (;;) {
      if (options.signal?.aborted === true) return null;
      let woken!: () => void;
      const wake = new Promise<void>((resolve) => (woken = resolve));
      const done: { value: boolean } = { value: false };
      const finish = () => {
        if (done.value) return;
        done.value = true;
        this.#wakeWaiters.delete(waiter);
        options.signal?.removeEventListener("abort", onAbort);
        woken();
      };
      const waiter = () => finish();
      const onAbort = () => finish();
      // Registered before the claim: no commit lands unseen.
      this.#wakeWaiters.add(waiter);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const backstop = setTimeout(() => finish(), options.backstopMs);
      (backstop as unknown as { unref?: () => void }).unref?.();

      const now = options.now();
      const lease = await this.claim(workerId, unique, now);
      if (lease !== null || options.signal?.aborted) {
        clearTimeout(backstop);
        finish();
        return lease;
      }

      // The horizon: the earliest due time or lease expiry among the types,
      // capped by the backstop.
      let horizon: number | undefined;
      for (const job of this.#jobs.values()) {
        if (!unique.includes(job.type)) continue;
        const at =
          job.status === "pending" && job.runAt > now
            ? job.runAt
            : job.status === "leased" && job.leaseExpiresAt !== null && job.leaseExpiresAt > now
              ? job.leaseExpiresAt
              : undefined;
        if (at !== undefined) horizon = horizon === undefined ? at : Math.min(horizon, at);
      }
      const backstopAt = now + options.backstopMs;
      const wakeAt = horizon !== undefined ? Math.min(horizon, backstopAt) : backstopAt;
      const delay = Math.max(0, wakeAt - options.now());
      if (delay > 0 && !done.value) {
        const horizonTimer = setTimeout(() => finish(), delay);
        (horizonTimer as unknown as { unref?: () => void }).unref?.();
        await wake;
        clearTimeout(horizonTimer);
      }
      clearTimeout(backstop);
    }
  }

  readonly #wakeWaiters = new Set<() => void>();
  /** In-process wake: any committed change to the claimable set, and any new
   * lease (its expiry is horizon data). */
  #wake(): void {
    for (const waiter of [...this.#wakeWaiters]) waiter();
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
      job.attempts === lease.attempt &&
      // The claim identity (T16): a defer's re-claim reuses the worker and
      // the attempt, so only the claim's own instant separates the live
      // lease from the one that gave the job back. A lease with no claim
      // instant (hand-built in tests) keeps the pair-only fence.
      (lease.claimAt === undefined || job.leaseClaimedAt === lease.claimAt)
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
