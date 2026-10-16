// The durable Queue (ANY-34 R8): RUNTIME §4's contract on the own `jobs` table —
// the 2026-10-12 decision in docs/RUNTIME.md §14 (own table; the pg-boss probe
// passed 11/12 conformance cases and idled at ~79 queries/min against a 60
// budget, so the rule chose the table we write).
//
// Shape:
// - `claim` is ONE statement: a CTE takes the oldest eligible row `for update
//   skip locked` — two workers on separate connections never share a claim —
//   and the UPDATE leases it. The per-stream serial rule and the per-workspace
//   cap are filters in the same snapshot; the lease is `lease_until` =
//   min(now + heartbeat, claim + max run); the max run anchors on
//   `run_started_at`; retries requeue through `run_at`.
// - `enqueue`/`complete` take the caller's transaction. A tx with `query` (the
//   store's RuntimeTx) is written in-transaction, so the job lands in the same
//   commit as the events that caused it and a rollback leaves nothing; a bare
//   `QueueTx` (the conformance's, tests') is staged behind `onCommit` and
//   applied right after, the key dedupe re-checked at apply.
// - Wake: committed writes resolve in-process waiters, and on Postgres also
//   NOTIFY a channel that a listener connection re-broadcasts (cross-process).
//   `claimWaiting` is the consumer side: registered-before-claim wake with an
//   injected backstop. The queue never reads the clock — every `now` is a param.
//
// Known scale limits, recorded for the epic: the cap/serial filters count
// committed rows, so two concurrent claims can transiently over-issue the
// per-workspace cap by one; the wake NOTIFY is best-effort and the backstop
// covers a lost signal.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { Adapter } from "../../store/adapter";
import { migrate } from "../../store/migrate";
import {
  DEFAULT_PER_WORKSPACE_CONCURRENCY,
  DEFAULT_TYPE_CONFIG,
  DEFAULT_TYPE_CONFIGS,
} from "../types";
import type {
  ClaimWaitingOptions,
  Queue,
  QueueJob,
  QueueJobInput,
  QueueLease,
  QueueOptions,
  QueueTx,
  QueueTypeConfig,
} from "../types";

/** Anything with `query`: `pg`'s Pool, a PGlite instance, the store's adapter.
 * `exec`, where present, runs a multi-statement script (the migrations). */
export interface MinimalPg {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
  exec?(sql: string): Promise<unknown>;
}

/** The caller's write path: `pg`-shaped result rows. */
type Exec = (sql: string, values?: unknown[]) => Promise<{ rows: any[] }>;

export type PgQueueConnection =
  | { kind: "pglite"; pglite: MinimalPg }
  /** A ready database; the queue migrates it on first use, idempotently. */
  | { kind: "postgres"; connectionString: string; poolSize?: number }
  /** An admin URL: the queue creates (and, on `close`, drops) its own database. */
  | { kind: "postgresAdmin"; adminUrl: string };

export interface PgQueueOptions extends QueueOptions {
  connection: PgQueueConnection;
  /** Job ids; the default is a random uuid. The conformance pins qjob-N. */
  generateId?: () => string;
  /** The LISTEN/NOTIFY wake channel; one name per database is enough. */
  wakeChannel?: string;
  /** Test hook (R17 Z5): false silences the cross-process NOTIFY leg; the
   * in-process wake and the claim-wait backstop still deliver. */
  wakeNotify?: boolean;
}

const DEFAULT_WAKE_CHANNEL = "fabric_queue_wake";
const STALE = "stale lease: job";

/** Per-database schema work, serialized within the process: two queues opening
 * the same database must not race the migration's check-then-insert. */
const schemaGuards = new Map<string, Promise<unknown>>();
function guarded(key: string, run: () => Promise<void>): Promise<void> {
  const previous = schemaGuards.get(key) ?? Promise.resolve();
  const next = previous.then(run, run);
  schemaGuards.set(
    key,
    next.catch(() => undefined)
  );
  return next;
}

/** Staged applies not yet written, keyed per database: `#settle` waits for the
 * database's outstanding applies, so an operation following any queue's
 `commit()` — on a sibling instance too — never observes the pre-insert
 * snapshot (the R8.4 two-worker race). The instance's own drain is `#drain`;
 * this covers the pool-per-instance shape where the commit's writes land on
 * another queue's connection. */
const stagedApplies = new Map<string | object, Set<Promise<void>>>();

const CLAIM_SQL = `
with cfg as (
  select * from jsonb_to_recordset($4::jsonb)
    as t(type text, max_run_ms bigint, heartbeat_ms bigint, serial boolean)
),
candidate as (
  select k.id
  from jobs k
  join cfg c on c.type = k.type
  where k.type = any($2::text[])
    and k.run_at <= $1::bigint
    and (k.status = 'pending'
      or (k.status = 'leased' and k.lease_until is not null and k.lease_until <= $1::bigint))
    and (coalesce(c.serial, false) = false or not exists (
      select 1 from jobs o
      where o.type = k.type
        and o.stream_id is not distinct from k.stream_id
        and o.status = 'leased'
        and o.id <> k.id))
    and (select count(*) from jobs w
         where w.workspace_id = k.workspace_id and w.status = 'leased') < $3::int
  order by k.run_at, k.seq
  limit 1
  for update of k skip locked
)
update jobs j
set status = 'leased',
    worker_id = $5,
    attempts = j.attempts + 1,
    run_started_at = $1::bigint,
    lease_until = $1::bigint + least(coalesce(c.heartbeat_ms, c.max_run_ms), c.max_run_ms)
from candidate, cfg c
where j.id = candidate.id
  and c.type = j.type
returning j.id, j.type, j.key, j.stream_id, j.workspace_id, j.attempts
`;

function staleMessage(lease: QueueLease): string {
  return `${STALE} ${lease.jobId} is not leased to ${lease.workerId} at attempt ${lease.attempt}`;
}

/** The store's RuntimeTx, structurally: `query` plus the inherited hook seam. */
type RuntimeTxLike = QueueTx & {
  query(sql: string, params?: readonly unknown[]): Promise<Record<string, unknown>[]>;
};

function isRuntimeTx(tx: QueueTx): tx is RuntimeTxLike {
  return typeof (tx as { query?: unknown }).query === "function";
}

interface Intent {
  run: () => Promise<void>;
}

export class PgQueue implements Queue {
  readonly #options: PgQueueOptions;
  readonly #configs: Map<string, QueueTypeConfig>;
  readonly #perWorkspaceConcurrency: number;
  #pool: Pool | null = null;
  #connectionUrl: string | null = null;
  #pglite: MinimalPg | null = null;
  #listener: import("pg").Client | null = null;
  #createdDatabase: string | null = null;
  #adminUrl: string | null = null;
  #ready: Promise<void>;
  #intents: Intent[] = [];
  #drain: Promise<void> | null = null;
  #wakeWaiters = new Set<() => void>();
  /** The listener connection's liveness: null once dropped (error or end); a
   * claim re-LISTENs lazily — never eagerly, never on a timer (R17). */
  #listenerPending: Promise<void> | null = null;
  /** Where this queue's staged applies are registered (the database, or the
   * PGlite instance); null only before init. */
  #stagedKey: string | object | null = null;
  /** Resolve sides of this instance's outstanding staged applies; the drain's
   * end is the latest point any of them can be waiting on. */
  #stagedResolvers = new Set<() => void>();

  constructor(options: PgQueueOptions) {
    this.#options = options;
    this.#perWorkspaceConcurrency =
      options.perWorkspaceConcurrency ?? DEFAULT_PER_WORKSPACE_CONCURRENCY;
    this.#configs = new Map(Object.entries(DEFAULT_TYPE_CONFIGS));
    for (const [type, override] of Object.entries(options.typeConfigs ?? {})) {
      const base = this.#configs.get(type) ?? DEFAULT_TYPE_CONFIG;
      this.#configs.set(type, { ...base, ...override });
    }
    this.#ready = this.#init();
    // An unused queue's failed init must not surface as an unhandled rejection.
    this.#ready.catch(() => undefined);
  }

  async #init(): Promise<void> {
    const connection = this.#options.connection;
    let guardKey = `pglite:${randomUUID()}`;
    if (connection.kind === "pglite") {
      this.#pglite = connection.pglite;
      // Sibling queues over the same PGlite share the staged registry too.
      this.#stagedKey = connection.pglite;
    } else {
      let url: string;
      if (connection.kind === "postgresAdmin") {
        this.#adminUrl = connection.adminUrl;
        url = await this.#createDatabase(connection.adminUrl);
      } else {
        url = connection.connectionString;
      }
      guardKey = url;
      this.#stagedKey = url;
      this.#connectionUrl = url;
      this.#pool = new Pool({
        connectionString: url,
        max: connection.kind === "postgres" ? (connection.poolSize ?? 5) : 5,
      });
      // Idle-socket errors surface here after the work is done; never crash.
      this.#pool.on("error", () => undefined);
    }
    await guarded(guardKey, () => migrate(this.#shim()));
    if (this.#pool) await this.#listen();
  }

  /** The wake channel's cross-process leg: a dedicated connection LISTENs and
   * re-broadcasts to in-process waiters. Deliberately NOT a pool client — the
   * listener lives for the queue's lifetime, and pool.end must never wait on
   * it. A dropped listener marks itself gone and is re-established by the
   * next claim; until then the backstop delivers. Never a crash. */
  async #listen(): Promise<void> {
    if (!this.#connectionUrl) return;
    const { Client } = await import("pg");
    const client = new Client({ connectionString: this.#connectionUrl });
    const gone = (): void => {
      if (this.#listener === client) this.#listener = null;
      void client.end().catch(() => undefined);
    };
    client.on("error", gone);
    client.on("end", gone);
    try {
      await client.connect();
      await client.query(`listen ${this.#wakeChannel()}`);
      client.on("notification", () => this.#wake());
      this.#listener = client;
    } catch {
      await client.end().catch(() => undefined);
      // The backstop still delivers; the next claim retries.
    }
  }

  /** The lazy LISTEN leg: on entry to a claim, re-establish the listener if it
   * dropped. Serialized per instance; a no-op when healthy or closing. */
  async #ensureListener(): Promise<void> {
    if (this.#pool === null || this.#listener !== null || this.#listenerPending !== null) return;
    this.#listenerPending = this.#listen().finally(() => {
      this.#listenerPending = null;
    });
    await this.#listenerPending;
  }

  async #createDatabase(adminUrl: string): Promise<string> {
    const admin = new Pool({ connectionString: adminUrl });
    try {
      const database = `fabric_queue_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      await admin.query(`create database "${database}"`);
      this.#createdDatabase = database;
    } finally {
      await admin.end();
    }
    const url = new URL(adminUrl);
    url.pathname = `/${this.#createdDatabase}`;
    return url.toString();
  }

  /** The migration runner's seam: same runner, this queue's connection. */
  #shim(): Adapter {
    return {
      exec: async (sql) => {
        await this.#execScript(sql);
      },
      query: async (sql, params = []) => (await this.#exec(sql, params as unknown[])).rows,
      transaction: async (run) => {
        await this.#exec("begin");
        try {
          const value = await run({
            query: async (sql, params = []) => (await this.#exec(sql, params as unknown[])).rows,
            onCommit: () => undefined,
          });
          await this.#exec("commit");
          return value;
        } catch (error) {
          await this.#exec("rollback").catch(() => undefined);
          throw error;
        }
      },
      close: async () => undefined,
    };
  }

  // -- Queue ----------------------------------------------------------------

  async enqueue(tx: QueueTx, job: QueueJobInput): Promise<QueueJob> {
    await this.#settle();
    // Call-time dedupe, under the executor that sees this transaction's writes:
    // the caller's tx for the in-transaction path, the queue's connection for
    // the staged one (whose re-check at apply covers same-tx duplicates).
    const exec: Exec = isRuntimeTx(tx)
      ? async (sql, values) => ({
          rows: await tx.query(sql, (values ?? []) as readonly unknown[]),
        })
      : (sql, values) => this.#exec(sql, values);
    const existing = await this.#findLiveOn(exec, job.key);
    if (existing) return existing;
    const record: QueueJob = {
      id: this.#nextId(),
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
    if (isRuntimeTx(tx)) {
      // Inside the caller's transaction: commits and rolls back with the events.
      await this.#insertLive(exec, record);
      tx.onCommit(() => void this.#announce());
      return record;
    }
    tx.onCommit(() => {
      // Registered synchronously in the hook, BEFORE the apply is queued: any
      // later #settle on this database waits for this apply.
      this.#trackStaged();
      this.#intents.push({
        run: async () => {
          await this.#insertLive((sql, values) => this.#exec(sql, values), record);
          await this.#announce();
        },
      });
      this.#kick();
    });
    return { ...record };
  }

  async claim(workerId: string, types: readonly string[], now: number): Promise<QueueLease | null> {
    await this.#settle();
    await this.#ensureListener();
    const unique = [...new Set(types)];
    if (unique.length === 0) return null;
    const cfg = unique.map((type) => {
      const config = this.#configFor(type);
      return {
        type,
        max_run_ms: config.maxRunMs,
        heartbeat_ms: config.heartbeatMs,
        serial: config.serialPerStream ?? false,
      };
    });
    const { rows } = await this.#exec(CLAIM_SQL, [
      now,
      unique,
      this.#perWorkspaceConcurrency,
      JSON.stringify(cfg),
      workerId,
    ]);
    const row = rows[0];
    if (!row) return null;
    // A new lease changes the idle-wait horizon (its expiry); wake the waiters.
    void this.#announce().catch(() => undefined);
    return {
      jobId: String(row.id),
      attempt: Number(row.attempts),
      workerId,
      type: String(row.type),
      key: String(row.key),
      streamId: row.stream_id === null || row.stream_id === undefined ? null : String(row.stream_id),
      workspaceId: String(row.workspace_id),
    };
  }

  async heartbeat(lease: QueueLease, now: number): Promise<void> {
    await this.#settle();
    const config = this.#configFor(lease.type);
    const silence = config.heartbeatMs ?? config.maxRunMs;
    const result = await this.#exec(
      `update jobs
       set lease_until = least($1::bigint + $2::bigint, run_started_at + $3::bigint)
       where id = $4 and status = 'leased' and worker_id = $5 and attempts = $6
       returning id`,
      [now, silence, config.maxRunMs, lease.jobId, lease.workerId, lease.attempt]
    );
    if (result.rows.length === 0) throw new Error(staleMessage(lease));
  }

  async complete(tx: QueueTx, lease: QueueLease): Promise<void> {
    await this.#settle();
    // Call-time check: a lease lost since the caller's claim is a stale error.
    await this.#requireCurrentLease(lease);
    if (isRuntimeTx(tx)) {
      const exec: Exec = async (sql, values) => ({
        rows: await tx.query(sql, (values ?? []) as readonly unknown[]),
      });
      // Inside the caller's transaction: the rollback leaves it leased.
      await this.#applyComplete(exec, lease);
      tx.onCommit(() => void this.#announce());
      return;
    }
    tx.onCommit(() => {
      this.#intents.push({
        run: async () => {
          // Apply-time fence: a lease lost since the call is left as it stands.
          await this.#applyComplete((sql, values) => this.#exec(sql, values), lease);
          await this.#announce();
        },
      });
      this.#kick();
    });
  }

  async fail(
    lease: QueueLease,
    error: Error,
    options: { retryable: boolean },
    now: number
  ): Promise<void> {
    await this.#settle();
    const config = this.#configFor(lease.type);
    const fence = [lease.jobId, lease.workerId, lease.attempt];
    if (options.retryable && lease.attempt <= config.maxRetries) {
      const backoff = Math.min(
        config.retryBackoffMs * 2 ** (lease.attempt - 1),
        config.retryBackoffMaxMs ?? Number.MAX_SAFE_INTEGER
      );
      const result = await this.#exec(
        `update jobs
         set status = 'pending', last_error = $4, run_at = $5::bigint,
             worker_id = null, lease_until = null, run_started_at = null
         where id = $1 and status = 'leased' and worker_id = $2 and attempts = $3
         returning id`,
        [...fence, error.message, now + backoff]
      );
      if (result.rows.length === 0) throw new Error(staleMessage(lease));
      await this.#announce();
      return;
    }
    const result = await this.#exec(
      `update jobs
       set status = 'dead', last_error = $4, worker_id = null, lease_until = null, run_started_at = null
       where id = $1 and status = 'leased' and worker_id = $2 and attempts = $3
       returning id`,
      [...fence, error.message]
    );
    if (result.rows.length === 0) throw new Error(staleMessage(lease));
    await this.#announce();
  }

  async get(jobId: string): Promise<QueueJob | null> {
    await this.#settle();
    const { rows } = await this.#exec(
      `select id, type, key, stream_id, workspace_id, run_at, payload, status, attempts, last_error
       from jobs where id = $1`,
      [jobId]
    );
    const row = rows[0];
    return row ? this.#asJob(row) : null;
  }

  // -- Wake / the consumer side ---------------------------------------------

  /** The earliest instant an idle claim could succeed: the next pending
   * `run_at` after now, or the next `lease_until`, among `types`. One
   * statement per idle cycle; null when neither exists. */
  static readonly NEXT_WAKE_SQL = `
select min(wake_at) as wake_at from (
  select min(run_at) as wake_at from jobs
    where status = 'pending' and run_at > $1::bigint and type = any($2::text[])
  union all
  select min(lease_until) as wake_at from jobs
    where status = 'leased' and lease_until is not null
      and lease_until > $1::bigint and type = any($2::text[])
) t
`;

  async #nextWakeAt(types: readonly string[], now: number): Promise<number | undefined> {
    const { rows } = await this.#exec(PgQueue.NEXT_WAKE_SQL, [now, [...types]]);
    const raw = rows[0]?.wake_at;
    return raw === null || raw === undefined ? undefined : Number(raw);
  }

  /** Claims, on wake, the next due time, the next lease expiry or the injected
   * backstop — whichever is earliest — until something is claimed. The wake
   * listener registers BEFORE each claim, so a commit landing between the
   * claim and the wait can never be missed. `signal` aborting returns null
   * promptly, before or during a wait. A backstop of `Infinity` waits for
   * wake only. */
  async claimWaiting(
    workerId: string,
    types: readonly string[],
    options: ClaimWaitingOptions
  ): Promise<QueueLease | null> {
    await this.#settle();
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

      // The horizon: due times and lease expiries among the claimed types,
      // capped by the backstop. A horizon at/before now reclaims at once.
      // Measured from the claim's own `now`: a lease lapsing between the
      // claim and this query is still the horizon, not a 10-minute sleep.
      const backstopAt = now + options.backstopMs;
      const horizon = await this.#nextWakeAt(unique, now);
      const wakeAt = horizon !== undefined ? Math.min(horizon, backstopAt) : backstopAt;
      const delay = Math.max(0, wakeAt - options.now());
      if (delay > 0 && !done.value) {
        const horizonTimer = setTimeout(() => finish(), delay);
        (horizonTimer as unknown as { unref?: () => void }).unref?.();
        await wake;
        clearTimeout(horizonTimer);
      }
      // done.value is now true however the wait ended; the loop claims again.
      clearTimeout(backstop);
    }
  }

  /** Release the listener and the pool (and drop a self-created database). */
  async close(): Promise<void> {
    await this.#ready;
    const listener = this.#listener;
    this.#listener = null;
    if (listener) await listener.end().catch(() => undefined);
    const pool = this.#pool;
    this.#pool = null;
    this.#connectionUrl = null;
    this.#pglite = null;
    if (pool) await pool.end();
    const database = this.#createdDatabase;
    const adminUrl = this.#adminUrl;
    if (database !== null && adminUrl !== null) {
      const admin = new Pool({ connectionString: adminUrl });
      try {
        await admin.query(`drop database if exists "${database}" with (force)`);
      } catch {
        // A leftover test database; harmless.
      } finally {
        await admin.end();
      }
    }
  }

  // -- internals -------------------------------------------------------------

  #nextId(): string {
    return this.#options.generateId?.() ?? randomUUID();
  }

  #configFor(type: string): QueueTypeConfig {
    return this.#configs.get(type) ?? DEFAULT_TYPE_CONFIG;
  }

  #exec(sql: string, values: unknown[] = []): Promise<{ rows: any[] }> {
    this.#assertOpen();
    if (this.#pool) {
      // No values → the simple protocol: the only shape that runs the
      // multi-statement migration files. With values, extended, single stmt.
      return values.length > 0
        ? this.#pool.query(sql, values as never)
        : (this.#pool.query(sql) as Promise<{ rows: any[] }>);
    }
    return this.#pglite!.query(sql, values as never) as Promise<{ rows: any[] }>;
  }

  /** A multi-statement script (migrations): simple protocol on pg, `exec` on
   * PGlite-like connections that have it. */
  async #execScript(sql: string): Promise<void> {
    this.#assertOpen();
    if (this.#pool) {
      await this.#pool.query(sql);
      return;
    }
    const pglite = this.#pglite!;
    if (typeof pglite.exec === "function") {
      await pglite.exec(sql);
      return;
    }
    await pglite.query(sql);
  }

  #assertOpen(): void {
    if (!this.#pool && !this.#pglite) {
      throw new Error("PgQueue: the queue is closed");
    }
  }

  #asJob(row: Record<string, unknown>): QueueJob {
    return {
      id: String(row.id),
      type: String(row.type),
      key: String(row.key),
      streamId: row.stream_id === null || row.stream_id === undefined ? null : String(row.stream_id),
      workspaceId: String(row.workspace_id),
      runAt: row.run_at === null || row.run_at === undefined ? 0 : Number(row.run_at),
      payload: row.payload === undefined ? undefined : row.payload,
      status: row.status as QueueJob["status"],
      attempts: Number(row.attempts ?? 0),
      lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
    };
  }

  /** The live (pending | leased) job holding `key`, under `exec`'s snapshot —
   * the caller's transaction sees its own writes. */
  async #findLiveOn(exec: Exec, key: string): Promise<QueueJob | null> {
    const { rows } = await exec(
      `select id, type, key, stream_id, workspace_id, run_at, payload, status, attempts, last_error
       from jobs where key = $1 and status in ('pending', 'leased') order by seq limit 1`,
      [key]
    );
    return rows[0] ? this.#asJob(rows[0]) : null;
  }

  /** Dedupe then insert; the partial unique index is the backstop for a race
   * the check missed. Returns the job that actually holds the key. */
  async #insertLive(exec: Exec, record: QueueJob): Promise<QueueJob> {
    const existing = await this.#findLiveOn(exec, record.key);
    if (existing) return existing;
    const result = await exec(
      `insert into jobs (id, type, key, stream_id, workspace_id, run_at, payload, status, attempts, last_error)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, 'pending', 0, null)
       on conflict (key) where status in ('pending', 'leased') do nothing
       returning id`,
      [
        record.id,
        record.type,
        record.key,
        record.streamId,
        record.workspaceId,
        record.runAt,
        JSON.stringify(record.payload ?? null),
      ]
    );
    if (result.rows.length === 0) {
      return (await this.#findLiveOn(exec, record.key)) ?? record;
    }
    return record;
  }

  /** The fenced completion; no rows means the lease was lost since the call. */
  async #applyComplete(exec: Exec, lease: QueueLease): Promise<void> {
    await exec(
      `update jobs
       set status = 'completed', worker_id = null, lease_until = null, run_started_at = null
       where id = $1 and status = 'leased' and worker_id = $2 and attempts = $3`,
      [lease.jobId, lease.workerId, lease.attempt]
    );
  }

  async #requireCurrentLease(lease: QueueLease): Promise<void> {
    const { rows } = await this.#exec(`select status, worker_id, attempts from jobs where id = $1`, [
      lease.jobId,
    ]);
    const row = rows[0];
    const current =
      row !== undefined &&
      row.status === "leased" &&
      row.worker_id === lease.workerId &&
      Number(row.attempts) === lease.attempt;
    if (!current) throw new Error(staleMessage(lease));
  }

  /** In-process wake, plus the cross-process NOTIFY. Best effort: the claim
   * path's backstop covers a lost signal. */
  async #announce(): Promise<void> {
    this.#wake();
    if (this.#pool !== null && this.#options.wakeNotify !== false) {
      await this.#exec(`select pg_notify($1, '')`, [this.#wakeChannel()]).catch(() => undefined);
    }
  }

  #wake(): void {
    for (const waiter of [...this.#wakeWaiters]) waiter();
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
      // The drain ended — cleanly, or mid-loop on an error. Nothing further
      // runs for this batch: release this instance's staged waits so a
      // #settle on any queue sharing the database cannot hang on a dropped
      // intent (an apply lost to a failed sibling is the pre-existing
      // fire-and-forget semantics, unchanged).
      for (const resolve of this.#stagedResolvers) resolve();
      this.#stagedResolvers.clear();
    }
  }

  /** Register a not-yet-written staged apply under this queue's database key;
   * resolved when this instance's drain ends (the latest point the apply can
   * still be pending — the intents all run inside one drain). */
  #trackStaged(): void {
    const key = this.#stagedKey;
    if (key === null) return;
    let set = stagedApplies.get(key);
    if (!set) stagedApplies.set(key, (set = new Set()));
    let resolveApplied!: () => void;
    const applied = new Promise<void>((resolve) => (resolveApplied = resolve));
    set.add(applied);
    void applied.then(() => set?.delete(applied));
    this.#stagedResolvers.add(resolveApplied);
  }

  /** Init, then whatever commit hooks are still in flight, then this
   * database's outstanding staged applies — sibling queues' commits too, so a
   * claim after another instance's `commit()` cannot see the pre-insert
   * snapshot (R8.4). */
  #settle(): Promise<unknown> {
    const staged =
      this.#stagedKey !== null ? [...(stagedApplies.get(this.#stagedKey) ?? [])] : [];
    return this.#ready.then(() => Promise.all([this.#drain, ...staged]));
  }

  #wakeChannel(): string {
    return this.#options.wakeChannel ?? DEFAULT_WAKE_CHANNEL;
  }
}
