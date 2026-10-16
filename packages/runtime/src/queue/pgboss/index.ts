// The pg-boss v12 Queue adapter (ANY-33 R7): the RUNTIME §4 contract on top of
// pg-boss's queues, one pg-boss queue per job type.
//
// Mapping, per the card:
// - `decide` and every other `serialPerStream` type: pg-boss `groupConcurrency: 1`
//   with the group id set to the stream on send — one run per (type, stream).
// - Every other type: `groupConcurrency` set to the per-workspace cap with the
//   group id set to the workspace — the cap is enforced database-side in fetch.
// - `heartbeatSeconds` per type from the type table; the max-run cap rides on
//   `expireSeconds`, so the lease window is min(last beat + heartbeat,
//   claim + max run) exactly as RUNTIME §4 defines it. A lapse is reclaimed by
//   the expiry pass a claim runs when the fetch comes up empty, as attempt+1.
// - `key` rides on `singletonKey`; dedupe is checked at enqueue and re-checked
//   at commit; a completed or dead key re-enqueues as a new job.
// - `complete`/`defer` are claim-fenced writes buffered into the caller's
//   commit (the shape of pg-boss's own settle/defer SQL, plus the claim
//   identity); `heartbeat` is applied at once. A stale lease throws at the
//   call; a lease lost between call and apply leaves the applied write a
//   no-op, so it can never land on a replacement claim.
// - Expiry, retry, dead: native pg-boss. `retryLimit`/`retryDelay` from the type
//   table; a lapse or retryable failure requeues as attempt+1, retries run out
//   into `failed` (= dead, `output.message` = lastError).
//
// Two deliberate deviations, both consequences of pg-boss's shipped behaviour:
// - Retry delay is the type's `retryBackoffMs` held constant across attempts,
//   not the doubling schedule: pg-boss's exponential backoff multiplies by a
//   random factor, and the conformance's exact re-claim instants (Q7) would
//   flake on a delay sampled above the boundary.
// - A terminal failure (non-retryable, or retries exhausted) lands through one
//   attempt-fenced UPDATE mirroring pg-boss's own terminal fail branch (same
//   id; state/completed_on/output). `fail()` always requeues while
//   `retryCount < retryLimit` and has no per-call terminal form.
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PgBoss, fromPglite } from "pg-boss";
import type { JobWithMetadata } from "pg-boss";
import {
  DEFAULT_PER_WORKSPACE_CONCURRENCY,
  DEFAULT_TYPE_CONFIG,
  DEFAULT_TYPE_CONFIGS,
} from "../types";
import type {
  Queue,
  QueueJob,
  QueueJobInput,
  QueueJobStatus,
  QueueLease,
  QueueOptions,
  QueueTx,
  QueueTypeConfig,
} from "../types";

/** Anything with `query`; `pg`'s Pool and a PGlite instance both qualify. */
export interface MinimalPg {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

export type PgBossQueueConnection =
  | { kind: "postgres"; connectionString: string }
  | { kind: "pglite"; pglite: MinimalPg };

export interface PgBossQueueOptions extends QueueOptions {
  connection: PgBossQueueConnection;
  /** pg-boss schema. Instances may share one only if used one at a time. */
  schema?: string;
  /** A pg-boss TestClock: every `now` the caller passes is injected into it. */
  testClock?: import("pg-boss").TestClock;
  /** Called once per SQL statement the adapter or its pg-boss instance runs;
   * the bench's traffic counter. */
  onQuery?: (sql: string) => void;
}

/** The LISTEN channel pg-boss derives from the schema (plans.notifyChannelSql):
 * `pgboss_` + the first 24 hex chars of sha224(schema). A claimer listens on it
 * directly to wake on insert instead of polling. */
export function notifyChannelFor(schema: string): string {
  const normalized = schema.trim().toLowerCase() || "pgboss";
  return `pgboss_${createHash("sha224").update(normalized).digest("hex").slice(0, 24)}`;
}

const PGBOSS_STATES: Record<string, QueueJobStatus> = {
  created: "pending",
  retry: "pending",
  active: "leased",
  completed: "completed",
  failed: "dead",
  cancelled: "dead",
};

interface Intent {
  run: () => Promise<void>;
}

export class PgBossQueue implements Queue {
  readonly #options: PgBossQueueOptions;
  readonly #configs: Map<string, QueueTypeConfig>;
  readonly #perWorkspaceConcurrency: number;
  #boss: PgBoss | null = null;
  #pool: Pool | null = null;
  #sessionStatements: string[] = [];
  #ready: Promise<void>;
  #intents: Intent[] = [];
  #drain: Promise<void> | null = null;
  #queuesReady = new Set<string>();

  constructor(options: PgBossQueueOptions) {
    this.#options = options;
    this.#perWorkspaceConcurrency =
      options.perWorkspaceConcurrency ?? DEFAULT_PER_WORKSPACE_CONCURRENCY;
    this.#configs = new Map(Object.entries(DEFAULT_TYPE_CONFIGS));
    for (const [type, override] of Object.entries(options.typeConfigs ?? {})) {
      const base = this.#configs.get(type) ?? DEFAULT_TYPE_CONFIG;
      this.#configs.set(type, { ...base, ...override });
    }
    this.#ready = this.#init();
  }

  async #init(): Promise<void> {
    const { connection, schema = "pgboss", testClock } = this.#options;
    const log = this.#options.onQuery;
    if (connection.kind === "postgres") {
      // The adapter's own pool carries every statement, pg-boss's included
      // (the db wrapper below routes them all here).
      this.#pool = new Pool({ connectionString: connection.connectionString, max: 4 });
      this.#pool.on("error", () => {});
      // pg-boss hands its session statements (the schema clock's SET) to the
      // db wrapper below before its first statement; every physical
      // connection this pool opens applies them, so job_now() agrees
      // everywhere.
      this.#pool.on("connect", (client) => {
        for (const statement of this.#sessionStatements) void client.query(statement);
      });
    }
    const counted = <T extends { executeSql: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> }>(
      db: T,
    ): T => {
      if (!log) return db;
      return {
        ...db,
        executeSql: async (text: string, values?: unknown[]) => {
          log(text);
          return db.executeSql(text, values);
        },
      } as T;
    };
    const config: Record<string, unknown> = { schema };
    if (connection.kind === "postgres") {
      // One pool for everything, so the bench's onQuery sees every statement.
      config.db = counted({
        executeSql: (text: string, values?: unknown[]) => this.#pool!.query(text, values as never),
        // The session statements (the schema clock) run in the connect hook.
        setSessionStatements: async (statements: string[]) => {
          this.#sessionStatements = statements;
        },
      });
    }
    if (connection.kind === "pglite") {
      config.db = counted(fromPglite(connection.pglite as never));
    }
    if (testClock) config.clock = testClock;
    // A quiet instance: the adapter drives expiry from claim, so no background
    // supervision pass, no stats pipeline, no registry. Idle traffic is the
    // claim path's alone; bench:queue measures it. The monitor gate (the only
    // expiry path) is set to its 1s floor so a claim's expiry pass is always
    // due instead of rate-limited against the wall clock.
    config.supervise = false;
    config.monitorIntervalSeconds = 1;
    config.persistQueueStats = false;
    config.persistWarnings = false;
    config.registerInstance = false;
    const boss = new PgBoss(config);
    boss.on("error", () => {});
    await boss.start();
    this.#boss = boss;
  }

  /** The underlying pg-boss instance, for the bench harness's counters. */
  get pgboss(): PgBoss | null {
    return this.#boss;
  }

  /** Release the pg-boss pool and the adapter's. The harness calls this. */
  async close(): Promise<void> {
    await this.#ready;
    const boss = this.#boss;
    this.#boss = null;
    await boss?.stop({ close: true, graceful: false });
    if (this.#pool) await this.#pool.end();
    this.#pool = null;
  }

  async enqueue(tx: QueueTx, job: QueueJobInput): Promise<QueueJob> {
    await this.#settle();
    const existing = await this.#findLiveByKey(job.key);
    if (existing) return existing;
    const record: QueueJob = {
      id: randomUUID(),
      type: job.type,
      key: job.key,
      streamId: job.streamId ?? null,
      workspaceId: job.workspaceId,
      runAt: job.runAt ?? 0,
      payload: job.payload,
      status: "pending",
      attempts: 0,
      lastError: null,
    };
    tx.onCommit(() => {
      this.#intents.push({
        run: async () => {
          // Re-checked at apply time, so same-tx duplicates collapse into one.
            const live = await this.#findLiveByKey(record.key);
          if (live) return;
          await this.#ensureQueue(record.type);
          const config = this.#configFor(record.type);
          await this.#boss!.send(
            record.type,
            {
              fabric: { streamId: record.streamId, workspaceId: record.workspaceId },
              payload: record.payload,
            },
            {
              id: record.id,
              singletonKey: record.key,
              startAfter: new Date(record.runAt),
              group: config.serialPerStream
                ? { id: record.streamId ?? `job:${record.id}` }
                : { id: record.workspaceId },
            },
          );
        },
      });
      this.#kick();
    });
    return { ...record };
  }

  async claim(workerId: string, types: readonly string[], now: number): Promise<QueueLease | null> {
    await this.#settle();
    await this.#injectNow(now);
    for (const type of types) {
      const lease = await this.#claimType(type, workerId);
      if (lease) return lease;
    }
    // Nothing claimable: a lapsed lease sits in `active` until expired, so run
    // the expiry pass once over the known queues and retry.
    await this.#expire();
    for (const type of types) {
      const lease = await this.#claimType(type, workerId);
      if (lease) return lease;
    }
    return null;
  }

  async #claimType(type: string, workerId: string): Promise<QueueLease | null> {
    const boss = this.#boss;
    if (!boss) return null;
    await this.#ensureQueue(type);
    const config = this.#configFor(type);
    const groupConcurrency = config.serialPerStream
      ? { default: 1 }
      : { default: this.#perWorkspaceConcurrency };
    const fetched = await boss.fetch(type, {
      batchSize: 1,
      includeMetadata: true,
      groupConcurrency,
    });
    const job = fetched[0] as JobWithMetadata | undefined;
    if (!job) return null;
    const data = job.data as { fabric?: { streamId?: string | null; workspaceId?: string }; payload?: unknown };
    return {
      jobId: job.id,
      attempt: job.retryCount + 1,
      workerId,
      type,
      key: job.singletonKey ?? "",
      streamId: data?.fabric?.streamId ?? null,
      workspaceId: data?.fabric?.workspaceId ?? "",
      // The claim's identity (T16): the row's `started_on` — the fence beyond
      // the attempt, so a lease the same attempt re-claimed reads as stale.
      ...(job.startedOn !== undefined && job.startedOn !== null
        ? { claimAt: new Date(job.startedOn).getTime() }
        : {}),
    };
  }

  async heartbeat(lease: QueueLease, now: number): Promise<void> {
    await this.#settle();
    await this.#injectNow(now);
    await this.#ensureQueue(lease.type);
    // The claim-identity fence (T16) before the touch: a lease the same
    // attempt re-claimed — the defer's re-claim — is stale, which the
    // attempt-only touch cannot see.
    if (lease.claimAt !== undefined) {
      const schema = this.#options.schema ?? "pgboss";
      const { rows } = await this.#exec(
        `SELECT started_on FROM ${schema}.job WHERE id = $1::uuid AND state = 'active'`,
        [lease.jobId],
      );
      const row = rows[0] as { started_on: string | Date } | undefined;
      if (row === undefined || toMs(row.started_on) !== lease.claimAt) {
        throw new Error(staleMessage(lease));
      }
    }
    // Attempt-fenced touch: a lease lost since the call updates no rows.
    const response = (await this.#boss!.touch(lease.type, {
      id: lease.jobId,
      retryCount: lease.attempt - 1,
    })) as { affected?: number };
    if ((response.affected ?? 0) === 0) throw new Error(staleMessage(lease));
  }

  async complete(tx: QueueTx, lease: QueueLease): Promise<void> {
    await this.#settle();
    await this.#requireCurrentLease(lease);
    const schema = this.#options.schema ?? "pgboss";
    const fence = claimFence(lease, 3);
    tx.onCommit(() => {
      this.#intents.push({
        run: async () => {
          // The completion as one claim-fenced UPDATE — the SET/WHERE shape of
          // pg-boss's own complete (state, completed_on via job_now, output
          // empty; the flow bookkeeping it also carries stays at its row
          // defaults here) plus the claim identity: attempt-fenced alone,
          // this buffered apply would land on a claim taken after the call.
          await this.#exec(
            `UPDATE ${schema}.job
             SET state = 'completed', completed_on = ${schema}.job_now(), output = null
             WHERE id = $1::uuid AND state = 'active' AND retry_count = $2${fence.sql}`,
            [lease.jobId, lease.attempt - 1, ...fence.params],
          );
        },
      });
      this.#kick();
    });
  }

  async defer(tx: QueueTx, lease: QueueLease, runAt: number): Promise<void> {
    await this.#settle();
    await this.#requireCurrentLease(lease);
    const schema = this.#options.schema ?? "pgboss";
    const fence = claimFence(lease, 4);
    tx.onCommit(() => {
      this.#intents.push({
        run: async () => {
          // Back to `retry` — the pending state pg-boss refetches past
          // start_after — with `start_after` at runAt. `started_on` goes too:
          // the fetch counts a refetch of a started job as the NEXT attempt
          // (retry_count + 1 when started_on is set), and a queue wait is not
          // a retry — the refetch must be the SAME attempt. The claim
          // identity rides in the WHERE (T16): a buffered defer applied after
          // its claim was lost and re-taken must miss, not revert the
          // replacement claim to pending.
          await this.#exec(
            `UPDATE ${schema}.job
             SET state = 'retry', start_after = $2::timestamptz, started_on = null
             WHERE id = $1::uuid AND state = 'active' AND retry_count = $3${fence.sql}`,
            [lease.jobId, new Date(runAt).toISOString(), lease.attempt - 1, ...fence.params],
          );
        },
      });
      this.#kick();
    });
  }

  async fail(
    lease: QueueLease,
    error: Error,
    options: { retryable: boolean },
    now: number,
  ): Promise<void> {
    await this.#settle();
    await this.#injectNow(now);
    await this.#ensureQueue(lease.type);
    const config = this.#configFor(lease.type);
    await this.#requireCurrentLease(lease);
    const output = { message: error.message };
    if (options.retryable && lease.attempt <= config.maxRetries) {
      // Native fenced fail: requeues as `retry` with the type's delay; the
      // next claim is the next attempt.
      await this.#boss!.fail(lease.type, { id: lease.jobId, retryCount: lease.attempt - 1 }, output);
      return;
    }
    // Terminal: retries exhausted, or the failure is not retryable. The same
    // end state pg-boss's terminal branch produces, fenced on the attempt and
    // the claim identity (T16) — the write must not land on a claim taken
    // after the one the caller holds. (A stale lease already threw above, at
    // the call-time check; a lease lost in the window since is left alone,
    // as with every applied write.)
    const schema = this.#options.schema ?? "pgboss";
    const fence = claimFence(lease, 4);
    await this.#exec(
      `UPDATE ${schema}.job
       SET state = 'failed', completed_on = ${schema}.job_now(), output = $2::jsonb
       WHERE id = $1::uuid AND state = 'active' AND retry_count = $3${fence.sql}`,
      [lease.jobId, JSON.stringify(output), lease.attempt - 1, ...fence.params],
    );
  }

  async get(jobId: string): Promise<QueueJob | null> {
    await this.#settle();
    const schema = this.#options.schema ?? "pgboss";
    const { rows } = await this.#exec(
      `SELECT id, name, data, singleton_key, state, retry_count, started_on, start_after, output
       FROM ${schema}.job WHERE id = $1::uuid`,
      [jobId],
    );
    const row = rows[0] as
      | {
          id: string;
          name: string;
          data: { fabric?: { streamId: string | null; workspaceId: string }; payload?: unknown };
          singleton_key: string | null;
          state: string;
          retry_count: number;
          started_on: string | null;
          start_after: string | Date;
          output: { message?: string } | null;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      type: row.name,
      key: row.singleton_key ?? "",
      streamId: row.data?.fabric?.streamId ?? null,
      workspaceId: row.data?.fabric?.workspaceId ?? "",
      runAt: new Date(row.start_after).getTime(),
      payload: row.data?.payload,
      status: PGBOSS_STATES[row.state] ?? "dead",
      attempts: row.retry_count + (row.started_on ? 1 : 0),
      lastError: row.output?.message ?? null,
    };
  }

  // Internals

  #configFor(type: string): QueueTypeConfig {
    return this.#configs.get(type) ?? DEFAULT_TYPE_CONFIG;
  }

  /** Injected time: move the attached TestClock so pg-boss's SQL (through
   * `job_now()`) and timers agree with the caller's `now`. No-op otherwise. */
  async #injectNow(now: number): Promise<void> {
    const clock = this.#options.testClock;
    if (!clock) return;
    if (clock.now() !== now) await clock.setTime(now);
  }

  async #exec(query: string, values?: unknown[]): Promise<{ rows: any[] }> {
    this.#options.onQuery?.(query);
    if (this.#pool) return this.#pool.query(query, values);
    const connection = this.#options.connection;
    if (connection.kind === "pglite") return connection.pglite.query(query, values as never);
    throw new Error("PgBossQueue: no connection to run admin SQL on");
  }

  /** The live (pending | leased) job holding this key, as the public view. */
  async #findLiveByKey(key: string): Promise<QueueJob | null> {
    const schema = this.#options.schema ?? "pgboss";
    const { rows } = await this.#exec(
      `SELECT id, name, data, singleton_key, state, retry_count, started_on, start_after
       FROM ${schema}.job
       WHERE singleton_key = $1 AND state IN ('created', 'retry', 'active')
       ORDER BY created_on
       LIMIT 1`,
      [key],
    );
    const row = rows[0] as
      | {
          id: string;
          name: string;
          data: { fabric?: { streamId: string | null; workspaceId: string }; payload?: unknown };
          singleton_key: string | null;
          state: string;
          retry_count: number;
          started_on: string | null;
          start_after: string | Date;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      type: row.name,
      key: row.singleton_key ?? "",
      streamId: row.data?.fabric?.streamId ?? null,
      workspaceId: row.data?.fabric?.workspaceId ?? "",
      runAt: new Date(row.start_after).getTime(),
      payload: row.data?.payload,
      status: PGBOSS_STATES[row.state] ?? "pending",
      attempts: row.retry_count + (row.started_on ? 1 : 0),
      lastError: null,
    };
  }

  async #requireCurrentLease(lease: QueueLease): Promise<void> {
    const schema = this.#options.schema ?? "pgboss";
    const { rows } = await this.#exec(
      `SELECT state, retry_count, started_on FROM ${schema}.job WHERE id = $1::uuid`,
      [lease.jobId],
    );
    const row = rows[0] as
      | { state: string; retry_count: number; started_on: string | Date | null }
      | undefined;
    if (!row || row.state !== "active" || row.retry_count !== lease.attempt - 1) {
      throw new Error(staleMessage(lease));
    }
    // The claim-identity fence (T16): a lease whose job left it and came back
    // on the SAME attempt — the defer's re-claim — is still stale.
    if (lease.claimAt !== undefined && toMs(row.started_on) !== lease.claimAt) {
      throw new Error(staleMessage(lease));
    }
  }

  async #ensureQueue(type: string): Promise<void> {
    if (this.#queuesReady.has(type) || !this.#boss) return;
    const name = type; // one pg-boss queue per job type
    if (!(await this.#boss.getQueue(name))) {
      const config = this.#configFor(type);
      await this.#boss.createQueue(name, {
        policy: "standard",
        // In-statement wake: the insert NOTIFYs the queue's channel when the
        // job is runnable, so a LISTENing claimer skips the poll backstop.
        notify: true,
        // The max-run cap: expiry bounds the lease from the claim.
        expireInSeconds: Math.max(1, Math.ceil(config.maxRunMs / 1000)),
        // The heartbeat window; pg-boss requires >= 10s when set.
        ...(config.heartbeatMs
          ? { heartbeatSeconds: Math.max(10, Math.round(config.heartbeatMs / 1000)) }
          : {}),
        retryLimit: Number.isFinite(config.maxRetries) ? Math.min(config.maxRetries, 2 ** 31 - 1) : 2 ** 31 - 1,
        // Constant delay: see the header note on pg-boss's jittered backoff.
        retryDelay: Math.max(1, Math.round(config.retryBackoffMs / 1000)),
        retryBackoff: false,
      });
    }
    this.#queuesReady.add(type);
  }

  /** Reclaim lapsed leases. pg-boss's own expire would requeue through the
   * row's `retryDelay`, but a lapsed lease is claimable at once (RUNTIME §4):
   * one state-guarded UPDATE per pass, with the native expire's two conditions
   * and its retry/dead split. */
  async #expire(): Promise<void> {
    if (this.#queuesReady.size === 0) return;
    const schema = this.#options.schema ?? "pgboss";
    await this.#exec(
      `WITH due AS (
         SELECT id FROM ${schema}.job
         WHERE name = ANY($1::text[]) AND state = 'active'
           AND ( (started_on + expire_seconds * interval '1s') < ${schema}.job_now()
              OR (heartbeat_seconds IS NOT NULL
                  AND (heartbeat_on + heartbeat_seconds * interval '1s') < ${schema}.job_now()) )
       )
       UPDATE ${schema}.job j
       SET state = (CASE WHEN j.retry_count >= j.retry_limit THEN 'failed' ELSE 'retry' END)::${schema}.job_state,
           start_after = ${schema}.job_now(),
           completed_on = (CASE WHEN j.retry_count >= j.retry_limit THEN ${schema}.job_now() END),
           output = (CASE WHEN j.retry_count >= j.retry_limit
                          THEN $2::jsonb
                          ELSE j.output END)
       FROM due
       WHERE j.id = due.id`,
      [[...this.#queuesReady], JSON.stringify({ message: "lease lapsed" })],
    );
  }

  #kick(): void {
    if (this.#drain) return;
    this.#drain = this.#drainLoop();
  }

  async #drainLoop(): Promise<void> {
    try {
      while (this.#intents.length > 0) {
        const intent = this.#intents.shift()!;
        await intent.run();
      }
    } finally {
      this.#drain = null;
    }
  }

  #settle(): Promise<void> {
    return this.#ready.then(() => this.#drain ?? Promise.resolve());
  }
}

function staleMessage(lease: QueueLease): string {
  return `stale lease: job ${lease.jobId} is not leased to ${lease.workerId} at attempt ${lease.attempt}`;
}

/** The applied write's claim-identity clause (T16): a defer's re-claim hands
 * the same (worker, attempt) pair back, so only the claim's own instant — the
 * row's `started_on` — separates the live lease from the one that gave the
 * job back. The call-time check cannot fence the write: a buffered apply
 * lands after the caller's commit, by which point the claim may have been
 * lost and re-taken, so the WHERE carries the instant too. Both sides
 * truncate to milliseconds — the precision `claimAt` was read at; a real
 * clock's `job_now()` is finer. Leases without the instant (hand-built in
 * tests) keep the pair-only fence. `at` is the placeholder index the clause's
 * parameter lands on, per statement. */
function claimFence(lease: QueueLease, at: number): { sql: string; params: unknown[] } {
  return lease.claimAt === undefined
    ? { sql: "", params: [] }
    : {
        sql: ` AND date_trunc('milliseconds', started_on) = $${at}::timestamptz`,
        params: [new Date(lease.claimAt).toISOString()],
      };
}

/** A pg timestamp (Date or ISO string, null when never started) as epoch ms. */
function toMs(value: string | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return new Date(value).getTime();
}
