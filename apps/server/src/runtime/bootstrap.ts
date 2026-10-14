// The runtime bootstrap (S5, ANY-54; RUNTIME §8 "Local (one process)"): the
// server hosts one store, one queue and the worker pool in-process. The store
// is Postgres at RUNTIME_DATABASE_URL (the direct, unpooled URL) when set, and
// PGlite at RUNTIME_PGLITE_DIR (default .data/runtime) otherwise; migrations
// run on start. The queue is the R8 implementation over the same database — on
// PGlite through a single-transaction facade, because the store owns the
// embedded instance and the queue's standalone claims must see the same rows.
//
// Sessions are commands (RUNTIME §13): the routes append facts and raise the
// `decide` job in one transaction (RUNTIME §2); the worker drains the rest.
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { openStore, PgQueue, runWorker } from "@fabric/runtime";
import type { Queue, RuntimeStore, RuntimeTx, WorkerPorts } from "@fabric/runtime";
import { createModelPort } from "@fabric/llm";
import { createDb } from "@fabric/db";
import type { Db } from "@fabric/db";
import {
  dbProposalStore,
  danaSessionDef,
  legacyBridges,
  sessionTools,
  withBridges,
  withSessionContext,
  type SessionBridgeEngines,
} from "@fabric/agents/session";
import type { ProposalActions } from "@fabric/agents/session";
import { recallFacts } from "@fabric/agents/assistant";
import { InProcessLiveBus, type LiveBus } from "./live-bus";
import { createTestModelPort, type TestModelOptions } from "./test-model";
import { hub } from "../services/hub";
import { runtime as appRuntime } from "../services/runtime";

/** One workspace until tenancy (ANY-46). */
export const RUNTIME_WORKSPACE = "local";

/** The server configuration the runtime reads; a subset of `env`. */
export type RuntimeEnv = {
  /** Direct (unpooled) Postgres for the event log and queue; unset = PGlite. */
  RUNTIME_DATABASE_URL?: string;
  /** PGlite data dir when RUNTIME_DATABASE_URL is unset; default .data/runtime. */
  RUNTIME_PGLITE_DIR?: string;
  /** Worker job concurrency; the queue's per-workspace cap. Default 4. */
  RUNTIME_CONCURRENCY?: number;
  /** `ai` (the real port, default) or `test` (the echo double). */
  MODEL_PORT?: "ai" | "test";
  /** Test-model variant: `chunked` streams the reply in 5 chunks 30 ms apart (S6). */
  MODEL_VARIANT?: "chunked";
  /** The app database (the proposal read model and the transition's side
   * effects, S8a); absent = the session surface runs without proposals. */
  DATABASE_URL?: string;
  /** DEMO_RECORDING_KEY: what a Fast-forward splices into after a bridge handoff (S8b). */
  DEMO_RECORDING_KEY?: string;
};

export type FabricRuntime = {
  store: RuntimeStore;
  queue: Queue;
  /** The session live bus (S6): append notifies and model deltas, in-process. */
  live: LiveBus;
  /** The proposal store behind the loop's `propose_*` tools and the decision
   * endpoint (S8a); undefined without an app database. */
  proposals?: ProposalActions;
  /** Drains the workers, then closes queue and store. Idempotent. */
  stop: () => Promise<void>;
};

/** The turn definition until S7 replaces it with Dana's (card ANY-54). */
export const SESSION_TURN_DEF = {
  tools: [],
  maxSteps: 6,
  surfaces: ["app"],
  turnCostCapUsd: null as number | null,
};

/**
 * The turn definition a new session's stream is stamped with (S7, ANY-56):
 * Dana's for `agentId: "dana"` — the loop knobs, the system prompt and the tool
 * schemas from `danaSessionDef`, the per-turn cap from DANA_TURN_COST_CAP_USD —
* and the S5 placeholder for every other agent until S9. Incognito sessions
* carry no recall tool, which is what keeps the memory path shut (PRODUCT
* §10.7). The env var is read here, at stamp time; the parsed-env object the
* server builds strips unknown keys, and the definition is not a port.
 */
export function sessionTurnDefinition(
  agentId: string,
  opts: { incognito?: boolean } = {}
): Record<string, unknown> {
  if (agentId !== "dana") return SESSION_TURN_DEF;
  const raw = process.env.DANA_TURN_COST_CAP_USD;
  const parsed = raw === undefined ? undefined : Number(raw);
  // S8b: the legacy-engine bridges ride Dana's definition — the `once` effects
  // and the S2 disposition kinds (handoff → team/its id, errand → agent/browser).
  return withBridges(
    danaSessionDef({
      incognito: opts.incognito === true,
      ...(parsed !== undefined && Number.isFinite(parsed) ? { turnCostCapUsd: parsed } : {}),
    }),
  );
}

/** The append enqueue port: one `decide` per touched stream, keyed on the
 * post-append head so a rerun cannot double-queue (RUNTIME §4). */
export function enqueueDecide(queue: Queue) {
  return async (tx: RuntimeTx, job: { type: string; streamId: string }): Promise<void> => {
    const head = await tx.query("select head from streams where id = $1", [job.streamId]);
    await queue.enqueue(tx, {
      type: "decide",
      key: `decide:${job.streamId}:h${Number(head[0]?.head ?? 0)}:api`,
      streamId: job.streamId,
      workspaceId: RUNTIME_WORKSPACE,
    });
  };
}

/** The bridge engines bound to the app runtime (`services/runtime.ts`): the
 * legacy handoff/errand path, resolved lazily — nothing opens until a bridge
 * actually runs, so a deployment without an app database only fails at call
 * time, inside the tool result. */
const appBridges = (): SessionBridgeEngines =>
  legacyBridges({
    app: () => appRuntime(),
    publish: (e) => hub.publishApp(e),
    recordingKey: process.env.DEMO_RECORDING_KEY,
  });

/** The worker ports. S7: the model port wears the session context wrapper (the
 * turn's recall lands in the system prompt; sessions without the recall tool —
 * incognito, runs — pass through untouched) and the ToolPort is the session
 * registry (`recall`, effect `read`; the S8a proposal writers and the S8b
 * legacy-engine bridges when wired). The app surface remains a no-op that
 * succeeds — the client reads the stream, the receipt only closes the job.
 * S6: model deltas ride the live bus, attributed by the enclosing transaction's
 * scan (see `wireLiveBus`) — the port's callback carries text only. */
export function workerPorts(
  env: RuntimeEnv,
  live: LiveBus,
  proposals: ProposalActions | undefined,
  store: RuntimeStore,
): WorkerPorts {
  const variant: TestModelOptions | undefined =
    env.MODEL_VARIANT === "chunked" ? { chunks: 5, intervalMs: 30 } : undefined;
  const model = env.MODEL_PORT === "test" ? createTestModelPort(variant) : createModelPort();
  return {
    model: withSessionContext(model, recallFacts),
    tools: sessionTools({
      recall: recallFacts,
      bridges: appBridges(),
      ...(proposals !== undefined
        ? { proposals: { store: proposals, loop: { store, workspace: RUNTIME_WORKSPACE } } }
        : {}),
    }),
    surface: {
      send: async () => ({}),
    },
    onDelta: (delta) => {
      const scan = liveScan.getStore();
      if (scan?.stream !== undefined && scan.call !== undefined) {
        live.delta(scan.stream, { turn: scan.call.turn, callNo: scan.call.callNo, text: delta.text });
      }
    },
  };
}

/** The queue's statements ride the store's adapter — one PGlite, one serialized
 * transaction chain. Two seams make that safe:
 *
 *  1. Every `store.transaction` is wrapped to remember its tx, so a queue call
 *     from inside a handler's transaction (complete/fail re-check the lease on
 *     the queue's own connection) JOINS the enclosing transaction instead of
 *     deadlocking on the chain behind it.
 *  2. Standalone statements (claims, the loop's heartbeats) run as their own
 *    single-statement transaction, exactly like the adapter treats a bare
 *    query — serialized with, never nested in, handler work.
 */
function pgliteQueueBackend(store: RuntimeStore) {
  const innermost = new AsyncLocalStorage<{ tx: RuntimeTx }>();
  const wrapped = store as unknown as { transaction: (run: never) => Promise<unknown> };
  const original = store.transaction.bind(store);
  wrapped.transaction = (run: (tx: RuntimeTx) => Promise<unknown>) =>
    original((tx) => innermost.run({ tx }, () => run(tx)));

  const single = async (text: string, values: unknown[] = []) => {
    // Yield the loop: the worker's claim cycle is back-to-back ready promises
    // over one serialized adapter, and without a macrotask break here the
    // process starves its own timers (test windows, vitest's own).
    await new Promise((resolve) => setImmediate(resolve));
    return { rows: await store.transaction((tx) => tx.query(text, values)) };
  };
  return {
    query: async (text: string, values: unknown[] = []) => {
      const enclosing = innermost.getStore();
      return enclosing === undefined
        ? single(text, values)
        : { rows: await enclosing.tx.query(text, values) };
    },
  };
}

// -- the live bus wiring (S6) -------------------------------------------------

/** One transaction's observed session traffic, for the two S6 seams: the
 * post-commit `appended` notify, and the stream/call attribution the model's
 * `onDelta` needs (the port's callback carries the text only). */
interface LiveScan {
  /** Session streams touched, to the head this transaction leaves them at. */
  heads: Map<string, number>;
  /** Streams whose `ll.completed`/`ll.failed` landed here — end the call. */
  ended: Set<string>;
  /** The in-flight call: the latest `ll.requested` the transaction read. */
  call?: { turn: number; callNo: number };
  /** The session stream the transaction last touched. */
  stream?: string;
}

const liveScan = new AsyncLocalStorage<LiveScan>();

const isSession = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("session:");

function callOf(payload: unknown): { turn: number; callNo: number } | undefined {
  let value = payload;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const turn = record["turn"];
  const callNo = record["callNo"];
  if (typeof turn === "number" && typeof callNo === "number") return { turn, callNo };
  return undefined;
}

/** The traffic shapes of one append (store.ts), read off the transaction: the
 * head bump names the stream and its new seq; the event inserts carry the
 * completion that ends a call. Event rows read back in the same transaction
 * carry the `ll.requested` whose turn/callNo the live deltas inherit. */
function scanForLive(
  sql: string,
  params: readonly unknown[] | undefined,
  rows: unknown[],
  scan: LiveScan,
): void {
  if (sql.startsWith("update streams set head")) {
    const [streamId, head] = params ?? [];
    if (isSession(streamId)) {
      const seq = Number(head);
      if (Number.isInteger(seq)) {
        scan.heads.set(streamId, Math.max(seq, scan.heads.get(streamId) ?? 0));
        scan.stream = streamId;
      }
    }
    return;
  }
  if (sql.startsWith("insert into events") && params !== undefined) {
    const streamId = params[2];
    const type = params[4];
    if (isSession(streamId) && (type === "llm.completed" || type === "llm.failed")) {
      scan.ended.add(streamId);
    }
  }
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    if (record["type"] !== "llm.requested" || !isSession(record["stream_id"])) continue;
    const call = callOf(record["payload"]);
    if (call !== undefined) {
      scan.call = call;
      scan.stream = record["stream_id"];
    }
  }
}

/** S6's notify seam: every transaction's session appends end with a head bump,
 * so the wrapper watches for it, and fires `live.appended` once on commit —
 * the in-process leg of RUNTIME §8's "every append notifies its streams",
 * covering the route appends and the worker's fact appends alike. The same
 * scan attributes the model port's deltas (see `workerPorts`). */
function wireLiveBus(store: RuntimeStore, live: InProcessLiveBus): void {
  const previous = store.transaction.bind(store) as (
    run: (tx: RuntimeTx) => Promise<unknown>,
  ) => Promise<unknown>;
  (store as unknown as { transaction: unknown }).transaction = (
    run: (tx: RuntimeTx) => Promise<unknown>,
  ) =>
    previous((tx) => {
      const scan: LiveScan = { heads: new Map(), ended: new Set() };
      let armed = false;
      const wrapped: RuntimeTx = {
        query: async (sql, params) => {
          const rows = await tx.query(sql, params);
          scanForLive(sql, params, rows, scan);
          // One hook per transaction: it reads the scan's final state at commit.
          if (!armed && scan.stream !== undefined) {
            armed = true;
            tx.onCommit(() => {
              for (const [streamId, head] of scan.heads) {
                live.appended(streamId, head);
                if (scan.ended.has(streamId)) live.endCall(streamId);
              }
            });
          }
          return rows;
        },
        onCommit: (hook) => tx.onCommit(hook),
      };
      return liveScan.run(scan, () => run(wrapped));
    });
}

let active: FabricRuntime | undefined;
/** The runtime the session routes talk to; `startRuntime` installs it. */
export function getRuntime(): FabricRuntime | undefined {
  return active;
}

export function setRuntime(runtime: FabricRuntime | undefined): void {
  active = runtime;
}

/**
 * Open the store, the queue over the same database, and -- unless
 * `opts.worker` is false -- RUNTIME_CONCURRENCY worker loops. Test hook:
 * `worker: false` boots the command surface with the board untouched (B5).
 */
export async function startRuntime(env: RuntimeEnv, opts: { worker?: boolean } = {}): Promise<FabricRuntime> {
  if (env.MODEL_PORT === "test" && process.env.NODE_ENV === "production") {
    throw new Error(
      "MODEL_PORT=test is the CI/smoke echo double, not a production model: the server refuses to start with MODEL_PORT=test when NODE_ENV=production",
    );
  }

  const store = env.RUNTIME_DATABASE_URL
    ? await openStore({ driver: "postgres", url: env.RUNTIME_DATABASE_URL })
    : await openStore({ driver: "pglite", dataDir: await pgliteDir(env) });

  const concurrency = Math.max(1, env.RUNTIME_CONCURRENCY ?? 4);
  const queue = env.RUNTIME_DATABASE_URL
    ? new PgQueue({
        connection: { kind: "postgres", connectionString: env.RUNTIME_DATABASE_URL },
        perWorkspaceConcurrency: concurrency,
      })
    : new PgQueue({
        connection: { kind: "pglite", pglite: pgliteQueueBackend(store) },
        perWorkspaceConcurrency: concurrency,
      });

  // Warm the queue before anything else runs: its one-time schema init takes
  // the same serialized path as every other statement, and a route transaction
  // that awaited it mid-transaction would deadlock the chain (PGlite is one
  // connection). An empty claim is the cheapest ready-barrier.
  await queue.claim("fabric-runtime-boot", [], Date.now());

  // S6: the session live bus. Wired after the queue's own transaction wrapper
  // so the notify scan sits outermost and sees every append's head bump.
  const live = new InProcessLiveBus();
  wireLiveBus(store, live);

  // S8a: the proposal store over the app database — the loop's `propose_*`
  // bodies write through it and the decision endpoint decides through it.
  let appDb: Db | undefined;
  let proposals: ProposalActions | undefined;
  if (env.DATABASE_URL !== undefined && env.DATABASE_URL !== "") {
    appDb = createDb(env.DATABASE_URL);
    proposals = dbProposalStore(appDb);
  }

  const signal = new AbortController();
  const loops =
    opts.worker === false
      ? []
      : Array.from({ length: concurrency }, (_, index) =>
          runWorker({
            store,
            queue,
            ports: workerPorts(env, live, proposals, store),
            workerId: `fabric-runtime-${process.pid}-${index}-${randomUUID().slice(0, 8)}`,
            signal: signal.signal,
            pollIntervalMs: 200,
          }),
        );

  let stopped = false;
  const runtime: FabricRuntime = {
    store,
    queue,
    live,
    ...(proposals !== undefined ? { proposals } : {}),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      signal.abort();
      await Promise.allSettled(loops); // the pass in flight drains; no new claim starts
      await queue.close();
      await store.close();
      await appDb?.close();
    },
  };
  setRuntime(runtime);
  return runtime;
}

async function pgliteDir(env: RuntimeEnv): Promise<string> {
  const dir = env.RUNTIME_PGLITE_DIR ?? path.join(".data", "runtime");
  await mkdir(dir, { recursive: true });
  return dir;
}
