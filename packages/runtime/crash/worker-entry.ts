// The crash-suite worker entry (ANY-37 R11, RUNTIME §15.3): boots ONE worker
// as its own OS process against the scenario's database — PGlite `dataDir` or
// a Postgres URL — with the crash fakes behind the ports, the crash switches
// applied per the scenario flags, and the claim-logging queue wrapper. Then it
// drains the board until quiet (nothing claimable AND no live job) and exits
// 0; a board that never settles — KM1, leases that never expire — hits the
// settle timeout and exits 1, which is itself the assertion's evidence.
//
// Run by the harness (crash/run.ts) as:
//   node --import tsx crash/worker-entry.ts '<json config>'
// The config is the whole command line: no env, no cwd games, deterministic.
import { PgliteAdapter } from "../src/store/pglite";
import { runUntilIdle, type WorkerPorts } from "../src/workers/loop";
import { migrate } from "../src/store/migrate";
import { openStore } from "../src/store/store";
import type { RuntimeStore, StoredEvent, ReadStreamOptions, RuntimeTx } from "../src/store/types";
import { PgQueue } from "../src/queue/pg";
import type { Queue, QueueTypeConfig } from "../src/queue/types";
import {
  CRASH_WORKER_TYPES,
  leaseNeverExpires,
  dropCausationIndex,
  appendWithoutCausationDedupe,
  effectBlind,
  withoutIdempotencyKey,
} from "../src/testing/crash-switches";
import { CrashModel, CrashSurface, CrashTools, logEvent, sleep } from "./fakes";
import type { ModelScriptEntry, ToolScriptSpec, SurfaceScriptSpec } from "./fakes";
import { wrapQueue } from "./queue-wrap";

/** Everything the child needs; JSON on argv so no state crosses the border. */
export interface WorkerEntryConfig {
  workerId: string;
  driver: { kind: "pglite"; dataDir: string } | { kind: "postgres"; url: string };
  logFile: string;
  dir: string;
  model: readonly ModelScriptEntry[];
  tools: Record<string, ToolScriptSpec>;
  surface: SurfaceScriptSpec;
  /** Hold the next claim after this job key completes at this barrier (K3). */
  blockClaimAfterCompleteOf?: { key: string; barrier: string };
  switches: {
    leaseNeverExpires?: boolean;
    appendNoDedupe?: boolean;
    effectBlind?: boolean;
    noDeliverKey?: boolean;
  };
  /** Lease window for every type; small so a killed job is reclaimed fast. */
  leaseMs?: number;
  settleTimeoutMs: number;
}

/** The five loop types with the crash run's fast leases. */
function crashTypeConfigs(cfg: WorkerEntryConfig): Record<string, Partial<QueueTypeConfig>> {
  const fast: Record<string, Partial<QueueTypeConfig>> = Object.fromEntries(
    CRASH_WORKER_TYPES.map((type) => [type, { maxRunMs: 300_000, heartbeatMs: cfg.leaseMs ?? 250 }])
  );
  if (cfg.switches.leaseNeverExpires) {
    Object.assign(fast, leaseNeverExpires());
  }
  return fast;
}

/** One store over the adapter the queue shares — `transaction` is the seam the
 * handlers use; `readStream` mirrors store.ts's SELECT so the object honestly
 * satisfies RuntimeStore (the handlers never call it; the crash harness
 * asserts through `openStore` proper after the processes exit). */
function storeOver(adapter: PgliteAdapter): RuntimeStore {
  return {
    transaction: (fn) => adapter.transaction(fn),
    readStream: async (streamId: string, options: ReadStreamOptions): Promise<StoredEvent[]> => {
      const rows = await adapter.query(
        `select id, workspace_id, stream_id, seq, type, class, v, actor, causation, ts, payload
         from events where stream_id = $1 and workspace_id = $2 order by seq asc`,
        [streamId, options.workspaceId]
      );
      return rows.map(toStoredEvent);
    },
    close: () => adapter.close(),
  };
}

function toStoredEvent(row: Record<string, unknown>): StoredEvent {
  const ts: unknown = row.ts;
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    streamId: String(row.stream_id),
    seq: Number(row.seq),
    type: String(row.type),
    class: String(row.class),
    v: Number(row.v),
    actor: String(row.actor),
    causation: row.causation === null || row.causation === undefined ? null : String(row.causation),
    ts: ts instanceof Date ? ts.toISOString() : String(ts),
    payload: row.payload,
  };
}

async function main(): Promise<void> {
  const cfg = JSON.parse(process.argv[2] ?? "{}") as WorkerEntryConfig;
  let store: RuntimeStore;
  let queue: Queue;
  let closeAll: () => Promise<void>;

  if (cfg.driver.kind === "pglite") {
    const adapter = new PgliteAdapter(cfg.driver.dataDir);
    await migrate(adapter);
    const pglite = {
      query: async (sql: string, values?: unknown[]) => ({
        rows: await adapter.query(sql, (values ?? []) as never),
      }),
      exec: (sql: string) => adapter.exec(sql),
    };
    queue = new PgQueue({ connection: { kind: "pglite", pglite }, typeConfigs: crashTypeConfigs(cfg) });
    store = storeOver(adapter);
    closeAll = async () => {
      await queue.close();
      await store.close();
    };
  } else {
    store = await openStore({ driver: "postgres", url: cfg.driver.url });
    queue = new PgQueue({
      connection: { kind: "postgres", connectionString: cfg.driver.url, poolSize: 3 },
      typeConfigs: crashTypeConfigs(cfg),
    });
    closeAll = async () => {
      await queue.close();
      await store.close();
    };
  }

  // KM2's database half: the index append's `on conflict` leans on.
  if (cfg.switches.appendNoDedupe) {
    await store.transaction((tx: RuntimeTx) => dropCausationIndex(tx));
  }

  const model = new CrashModel(cfg.model, cfg.logFile, cfg.dir);
  const tools = new CrashTools(cfg.tools, cfg.logFile, cfg.dir);
  const surface = new CrashSurface(cfg.surface, cfg.logFile, cfg.dir);
  const ports: WorkerPorts = {
    model,
    tools: cfg.switches.effectBlind ? effectBlind(tools) : tools,
    surface: cfg.switches.noDeliverKey ? withoutIdempotencyKey(surface) : surface,
  };

  const effectiveStore = cfg.switches.appendNoDedupe ? appendWithoutCausationDedupe(store) : store;
  const effectiveQueue = wrapQueue(queue, {
    logFile: cfg.logFile,
    dir: cfg.dir,
    ...(cfg.blockClaimAfterCompleteOf !== undefined ? { blockClaimAfterCompleteOf: cfg.blockClaimAfterCompleteOf } : {}),
  });

  // Drain until quiet. "Quiet" is FACT-head stability, not job-count: a
  // settled board can still hold a dead-lease reclaim (KM1), and only facts
  // move the fold — so two stable fact-head reads an interval apart, after a
  // drained pass, mean nothing moves at all and the settle timeout is the
  // honest exit.
  const startedAt = Date.now();
  const factHead = async (): Promise<number> => {
    const rows = await store.transaction(async (tx) => {
      const head = await tx.query(
        "select coalesce(max(seq), 0)::int as h from events where class = 'fact'"
      );
      return Number(head[0]?.h ?? 0);
 });
    return rows;
  };
  let stableReads = 0;
  let lastHead = -1;
  for (;;) {
    await runUntilIdle(
      {
        store: effectiveStore,
        queue: effectiveQueue,
        ports,
        workerId: cfg.workerId,
      },
      // Small passes: the stability check must interleave with the drain,
      // not follow a thousand-claim burn.
      5
    );
    const head = await factHead();
    stableReads = head === lastHead ? stableReads + 1 : 0;
    lastHead = head;
    if (stableReads >= 2) break;
    if (Date.now() - startedAt > cfg.settleTimeoutMs) {
      const live = await store.transaction(async (tx) => {
        const rows = await tx.query("select count(*)::int as c from jobs where status in ('pending', 'leased')");
        return Number(rows[0]?.c ?? 0);
      });
      logEvent(cfg.logFile, { t: Date.now(), ev: "settle-timeout", liveJobs: live });
      await closeAll();
      process.exit(1);
    }
    await sleep(250);
  }
  await closeAll();
  process.exit(0);
}

main().catch((error) => {
  console.error("crash worker-entry failed:", error);
  process.exit(1);
});
