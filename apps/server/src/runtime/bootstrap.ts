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
import { HTTPException } from "hono/http-exception";
import { openStore, PgQueue, runWorker } from "@fabric/runtime";
import type { Queue, RuntimeStore, RuntimeTx, WorkerPorts } from "@fabric/runtime";
import type { ToolRegistry } from "@fabric/tools";
import { createRegistry } from "@fabric/tools";
import { builtinTools } from "@fabric/tools/builtin";
import { hostTools } from "@fabric/tools/host";
import {
  encryptedTableVault,
  ensureVaultSchema,
  envFallbackVault,
  loadOrCreateMasterKey,
  type Vault,
} from "@fabric/tools/vault";
import { createModelPort } from "@fabric/llm";
import { createDb, schema, sql } from "@fabric/db";
import type { Db } from "@fabric/db";
import {
  dbProposalStore,
  definitionAccess,
  danaSessionDef,
  legacyBridges,
  specialistSessionDef,
  sessionTools,
  withBridges,
  withSessionContext,
  withToolset,
  type SessionBridgeEngines,
} from "@fabric/agents/session";
import type { ProposalActions, SpecialistAgent } from "@fabric/agents/session";
import { recallFacts } from "@fabric/agents/assistant";
import { InProcessLiveBus, type LiveBus } from "./live-bus";
import { createTestModelPort, type TestModelOptions } from "./test-model";
import { enqueuePurgeOnActivity, runPurgeLoop } from "./purge";
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
  /** Test-model variant: `chunked` streams the reply in 5 increments 30 ms
   * apart (S6); `slow` in 20 increments 50 ms apart, ~1 s per call (R16). */
  MODEL_VARIANT?: "chunked" | "slow";
  /** The app database (the proposal read model and the transition's side
   * effects, S8a); absent = the session surface runs without proposals. */
  DATABASE_URL?: string;
  /** DEMO_RECORDING_KEY: what a Fast-forward splices into after a bridge handoff (S8b). */
  DEMO_RECORDING_KEY?: string;
  /** T14: the root of the per-agent work dirs (`agents/<id>` under it). */
  FABRIC_WORK_DIR?: string;
  /** T14: the vault's master key file; created 0600 on first boot. */
  FABRIC_MASTER_KEY_FILE?: string;
  /** T14: the inbox `send` sends from; unset leaves `send` out of the registry. */
  FABRIC_SEND_FROM?: string;
};

export type FabricRuntime = {
  store: RuntimeStore;
  queue: Queue;
  /** The session live bus (S6): append notifies and model deltas, in-process. */
  live: LiveBus;
  /** The proposal store behind the loop's `propose_*` tools and the decision
   * endpoint (S8a); undefined without an app database. */
  proposals?: ProposalActions;
  /** The agents' secret vault (T14): the encrypted table behind the env
   * fallback, keyed by FABRIC_MASTER_KEY_FILE. */
  vault: Vault;
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
 * The turn definition a new session's stream is stamped with (S7, ANY-56; S9,
 * ANY-59; T14, ANY-81): Dana's for `agentId: "dana"` — the loop knobs, the
 * system prompt and the tool schemas from `danaSessionDef`, the per-turn cap
 * from DANA_TURN_COST_CAP_USD — the specialist's (built from the agent's
 * registry record) for any other known agent, and the S5 placeholder only when
 * no snapshot is loaded; under a loaded one an unknown agent raises the create
 * route's 404. Incognito sessions carry no recall tool, which is what keeps the
 * memory path shut (PRODUCT §10.7). The env var is read here, at stamp time; the
 * parsed-env object the server builds strips unknown keys, and the definition is
 * not a port.
 *
 * T14: async, because the stamp reads stores (M3, M6) — and, when the tool
 * registry seam is set, the agent's own row wears the toolset: the registry
 * tools its rows name, access per row policy. Unset seam or no mapped rows:
 * the definition is exactly as before.
 */
export async function sessionTurnDefinition(
  agentId: string,
  opts: { incognito?: boolean } = {}
): Promise<Record<string, unknown>> {
  let def: Record<string, unknown>;
  if (agentId !== "dana") {
    const agent = sessionAgents.get(agentId);
    if (agent !== undefined) def = specialistSessionDef(agent, { incognito: opts.incognito === true });
    // A loaded snapshot makes the id space closed: an unknown agent is a 404
    // raised before the create route's transaction touches any stream (S9).
    else if (sessionAgentsLoaded) throw new HTTPException(404, { message: `unknown agent: ${agentId}` });
    else def = { ...SESSION_TURN_DEF };
  } else {
    const raw = process.env.DANA_TURN_COST_CAP_USD;
    const parsed = raw === undefined ? undefined : Number(raw);
    // S8b: the legacy-engine bridges ride Dana's definition — the `once` effects
    // and the S2 disposition kinds (handoff → team/its id, errand → agent/browser).
    def = withBridges(
      danaSessionDef({
        incognito: opts.incognito === true,
        ...(parsed !== undefined && Number.isFinite(parsed) ? { turnCostCapUsd: parsed } : {}),
      }),
    ) as unknown as Record<string, unknown>;
  }

  // T14: the row is the definition layer (D5) — the tools its names map to,
  // access per policy, in registry order. No registry, no row, no survivors:
  // the stamp is the pre-T14 definition, byte for byte.
  const registry = sessionToolRegistry;
  if (registry === undefined) return def;
  const rows = sessionAgents.get(agentId)?.tools ?? [];
  const access = definitionAccess(rows, new Set(registry.names()));
  return withToolset(def as never, { registry, access }) as Record<string, unknown>;
}

// The registry snapshot the stamp consults (S9, ANY-59): the agent records the
// registry route serves, loaded once at boot from the app database. Unloaded
// (unit tests, no app database) the stamp keeps the S5 placeholder for every
// non-Dana agent; loaded, an unknown id is the create route's 404.
const sessionAgents = new Map<string, SpecialistAgent>();
let sessionAgentsLoaded = false;

/** The registry snapshot seam: the boot loader and the tests meet here. */
export function setSessionAgents(records: readonly SpecialistAgent[]): void {
  sessionAgents.clear();
  for (const record of records) sessionAgents.set(record.id, record);
  sessionAgentsLoaded = true;
}

// The tool registry the stamp's toolset and the worker port's registry calls
// read (T14). Unset — the unit tests, `worker: false` boots without one — no
// registry tools exist: the stamp is the pre-T14 definition and the port serves
// the session tools only.
let sessionToolRegistry: ToolRegistry | undefined;

/** The tool-registry seam, S9's `setSessionAgents` twin: `startRuntime` installs
 * the step-0 + host registry; tests install their own (or `undefined`). */
export function setSessionToolRegistry(registry: ToolRegistry | undefined): void {
  sessionToolRegistry = registry;
}

/** The append enqueue port: one `decide` per touched stream, keyed on the
 * post-append head so a rerun cannot double-queue (RUNTIME §4) — plus, on
 incognito session streams, the S11 purge job whose deadline shadows the
 * activity this append carries (ANY-61). */
export function enqueueDecide(queue: Queue) {
  return async (tx: RuntimeTx, job: { type: string; streamId: string }): Promise<void> => {
    const head = await tx.query("select head from streams where id = $1", [job.streamId]);
    await queue.enqueue(tx, {
      type: "decide",
      key: `decide:${job.streamId}:h${Number(head[0]?.head ?? 0)}:api`,
      streamId: job.streamId,
      workspaceId: RUNTIME_WORKSPACE,
    });
    await enqueuePurgeOnActivity(tx, queue, RUNTIME_WORKSPACE, job.streamId);
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

/** The per-call scope factory (T14): the session's identity plus the run dir —
 * `FABRIC_WORK_DIR/agents/<id>`, T10's layout, created on first use — and the
 * vault behind an arrow, so tools never see it. */
const sessionToolScopeOf =
  (env: RuntimeEnv, vault: Vault | undefined) =>
  async (io: { workspaceId: string; streamId: string; agentId: string; callId?: string }) => {
    const runDir = path.join(env.FABRIC_WORK_DIR ?? path.join(".data", "work"), "agents", io.agentId);
    await mkdir(runDir, { recursive: true });
    return {
      workspaceId: io.workspaceId,
      streamId: io.streamId,
      agentId: io.agentId,
      callId: io.callId,
      runDir,
      secret: (name: string) => {
        if (vault === undefined) return Promise.reject(new Error("no vault configured"));
        return vault.get(name, { agentId: io.agentId });
      },
    };
  };

/** The worker ports. S7: the model port wears the session context wrapper (the
 * turn's recall lands in the system prompt; sessions without the recall tool —
 * incognito, runs — pass through untouched) and the ToolPort is the session
 * registry (`recall`, effect `read`; the S8a proposal writers, the S8b
 * legacy-engine bridges and — T14 — the server's tool registry behind the
 * per-call scope, when the seam is set). The app surface remains a no-op that
 * succeeds — the client reads the stream, the receipt only closes the job.
 * S6/R15: model deltas ride the live bus, attributed by the call the worker
 * passes (`onDelta`'s second argument) — the model call runs outside any
 * store transaction, so no enclosing scan survives to it. */
export function workerPorts(
  env: RuntimeEnv,
  live: LiveBus,
  proposals: ProposalActions | undefined,
  store: RuntimeStore,
  vault?: Vault,
): WorkerPorts {
  const variant: TestModelOptions | undefined =
    env.MODEL_VARIANT === "chunked"
      ? { chunks: 5, intervalMs: 30 }
      : env.MODEL_VARIANT === "slow"
        ? { chunks: 20, intervalMs: 50 }
        : undefined;
  const model = env.MODEL_PORT === "test" ? createTestModelPort(variant) : createModelPort();
  return {
    model: withSessionContext(model, recallFacts),
    tools: sessionTools({
      recall: recallFacts,
      bridges: appBridges(),
      ...(proposals !== undefined
        ? { proposals: { store: proposals, loop: { store, workspace: RUNTIME_WORKSPACE } } }
        : {}),
      ...(sessionToolRegistry !== undefined
        ? { registry: { tools: sessionToolRegistry, scope: sessionToolScopeOf(env, vault) } }
        : {}),
    }),
    surface: {
      send: async () => ({}),
    },
    onDelta: (delta, call) => {
      live.delta(call.streamId, { turn: call.turn, callNo: call.callNo, text: delta.text });
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

/** One transaction's observed session traffic, for the post-commit `appended`
 * notify and the call-end it carries. (Through R14 the scan also attributed
 * the model's `onDelta`; R15's `ll.call` runs the model outside any
 * transaction and hands the attribution to the callback itself.) */
interface LiveScan {
  /** Session streams touched, to the head this transaction leaves them at. */
  heads: Map<string, number>;
  /** Streams whose `ll.completed`/`ll.failed` landed here — end the call. */
  ended: Set<string>;
  /** The session stream the transaction last touched. */
  stream?: string;
}

const liveScan = new AsyncLocalStorage<LiveScan>();

const isSession = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("session:");

/** The traffic shapes of one append (store.ts), read off the transaction: the
 * head bump names the stream and its new seq; the event inserts carry the
 * completion that ends a call. */
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

  // T14: the agents' vault — the encrypted table on this store behind the env
  // fallback, keyed by the master key file (created 0600 on first boot).
  await ensureVaultSchema(store);
  const masterKeyPath = env.FABRIC_MASTER_KEY_FILE ?? path.join(".data", "master.key");
  await mkdir(path.dirname(masterKeyPath), { recursive: true });
  const masterKey = await loadOrCreateMasterKey(masterKeyPath);
  const vault = envFallbackVault(encryptedTableVault(store, RUNTIME_WORKSPACE, masterKey), process.env);

  // T14: the tool registry — the step-0 set (`send` only when the identity is
  // configured) plus the host tools — installed through the seam, S9-style.
  const sendFrom = env.FABRIC_SEND_FROM;
  const registryDefs = [
    ...builtinTools({ sendFrom: sendFrom ?? "" }),
    ...hostTools(),
  ];
  setSessionToolRegistry(
    createRegistry(sendFrom === undefined ? registryDefs.filter((def) => def.name !== "send") : registryDefs),
  );

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

  // S9: the session agents snapshot -- the registry rows the stamp's specialist
  // definition and the create route's 404 read. Best-effort: a failure only
  // means specialist sessions stamp the placeholder until the next boot.
  if (appDb !== undefined) {
    try {
      const rows = await appDb.db
        .select({
          id: schema.agents.id,
          name: schema.agents.name,
          role: schema.agents.role,
          personality: schema.agents.personality,
          summary: schema.agents.summary,
          model: schema.agents.model,
          tools: schema.agents.tools,
          workspace: schema.agents.workspace,
        })
        .from(schema.agents)
        .where(sql`status = 'active'`);
      setSessionAgents(
        rows.map((row) => {
          const files = row.workspace?.files ?? [];
          const instructions = files
            .map((file) => file.body.trim())
            .filter((body) => body !== "")
            .join("\n\n");
          // T14: the definition layer rides the row — name and policy only.
          const tools = (row.tools ?? []).map(({ name, policy }) => ({ name, policy }));
          return {
            id: row.id,
            name: row.name,
            role: row.role,
            ...(instructions !== "" ? { instructions } : {}),
            ...(row.personality !== "" ? { personality: row.personality } : {}),
            ...(row.summary !== "" ? { summary: row.summary } : {}),
            ...(row.model !== "" ? { model: row.model } : {}),
            ...(tools.length > 0 ? { tools } : {}),
          };
        }),
      );
    } catch (error) {
      console.log(
        `[runtime] the session agents snapshot failed (${error instanceof Error ? error.message : String(error)}); specialist sessions stamp the placeholder`,
      );
    }
  }

  const signal = new AbortController();
  const loops =
    opts.worker === false
      ? []
      : Array.from({ length: concurrency }, (_, index) =>
          runWorker({
            store,
            queue,
            ports: workerPorts(env, live, proposals, store, vault),
            workerId: `fabric-runtime-${process.pid}-${index}-${randomUUID().slice(0, 8)}`,
            signal: signal.signal,
            pollIntervalMs: 200,
          }),
        );
  // S11: the incognito purge rides its own claim loop — `session.purge` is a
  // server-side job type the runtime worker loop does not dispatch.
  if (opts.worker !== false) {
    loops.push(
      runPurgeLoop(store, queue, signal.signal, `fabric-purge-${process.pid}-${randomUUID().slice(0, 8)}`),
    );
  }

  let stopped = false;
  const runtime: FabricRuntime = {
    store,
    queue,
    live,
    vault,
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
