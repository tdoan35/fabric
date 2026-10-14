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
import { createTestModelPort } from "./test-model";

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
};

export type FabricRuntime = {
  store: RuntimeStore;
  queue: Queue;
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

/** The worker ports. Tools arrive with S7/S8; the app surface is a no-op that
 * succeeds — the client reads the stream, the receipt only closes the job. */
function workerPorts(env: RuntimeEnv): WorkerPorts {
  const model = env.MODEL_PORT === "test" ? createTestModelPort() : createModelPort();
  return {
    model,
    tools: {
      run: async (name) => ({ ok: false, error: `no tools are wired yet (S7/S8): ${name}` }),
      describe: () => undefined,
    },
    surface: {
      send: async () => ({}),
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

  const signal = new AbortController();
  const loops =
    opts.worker === false
      ? []
      : Array.from({ length: concurrency }, (_, index) =>
          runWorker({
            store,
            queue,
            ports: workerPorts(env),
            workerId: `fabric-runtime-${process.pid}-${index}-${randomUUID().slice(0, 8)}`,
            signal: signal.signal,
            pollIntervalMs: 200,
          }),
        );

  let stopped = false;
  const runtime: FabricRuntime = {
    store,
    queue,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      signal.abort();
      await Promise.allSettled(loops); // the pass in flight drains; no new claim starts
      await queue.close();
      await store.close();
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
