// The worker loop (RUNTIME §4): claim a job, dispatch it to the handler whose
// type it names, heartbeat the long ones, complete or fail. `runWorker` is the
// daemon — it polls until its signal aborts; `runUntilIdle` drains the claimable
// set once and returns, the shape every test drives. The handlers own their
// completions and failures (each is one transaction); the loop only chooses
// them and keeps the lease alive.
//
// A job type without its port — `llm.call` without a model, `deliver` without
// a surface — fails loud: the worker's wiring is the caller's, and half a
// worker silently requeueing forever is worse than an error.
import type { ModelPort, SurfacePort, ToolPort } from "../ports";
import { DEFAULT_TYPE_CONFIG, DEFAULT_TYPE_CONFIGS } from "../queue/types";
import type { Queue, QueueLease } from "../queue/types";
import type { RuntimeStore } from "../store/types";
import { handleDecideJob } from "./decide";
import { handleDelegateResolveJob } from "./delegate-resolve";
import { handleDeliverJob } from "./deliver";
import { handleLlmCallJob } from "./ll-call";
import { handleToolExecJob } from "./tool-exec";

/** The job types this loop dispatches — the handlers RUNTIME §4 defines so far. */
export const WORKER_JOB_TYPES = ["decide", "llm.call", "tool.exec", "delegate.resolve", "deliver"] as const;

/** The ports the dispatched handlers run behind; absent ones fail their type loud. */
export type WorkerPorts = {
  model?: ModelPort;
  tools?: ToolPort;
  surface?: SurfacePort;
  /** Live-delta sink, handed straight to the model port (§8). */
  onDelta?: (delta: { text: string }) => void;
};

export type WorkerOptions = {
  store: RuntimeStore;
  queue: Queue;
  ports: WorkerPorts;
  workerId: string;
  /** Job types to claim; every type this loop dispatches when omitted. */
  types?: readonly string[];
  /** Injected clock for claims, heartbeats and failure bookkeeping. */
  now?: () => number;
  /** Idle-poll interval of the daemon; 1s when unset. */
  pollIntervalMs?: number;
  /** Stops the daemon when aborted. */
  signal?: AbortSignal;
};

const nowOf = (options: WorkerOptions): (() => number) => options.now ?? (() => Date.now());

/** Dispatch one claimed lease to its handler. */
async function dispatch(lease: QueueLease, options: WorkerOptions): Promise<void> {
  const { store, queue, ports } = options;
  const now = nowOf(options);
  const deps = { store, queue, now };
  switch (lease.type) {
    case "decide":
      return handleDecideJob(lease, deps);
    case "llm.call":
      if (ports.model === undefined) throw new Error("worker cannot run llm.call: no model port");
      return handleLlmCallJob(lease, {
        store,
        queue,
        model: ports.model,
        now,
        ...(ports.onDelta !== undefined ? { onDelta: ports.onDelta } : {}),
      });
    case "tool.exec":
      if (ports.tools === undefined) throw new Error("worker cannot run tool.exec: no tool port");
      return handleToolExecJob(lease, { store, queue, tools: ports.tools, now });
    case "delegate.resolve":
      return handleDelegateResolveJob(lease, deps);
    case "deliver":
      if (ports.surface === undefined) throw new Error("worker cannot run deliver: no surface port");
      return handleDeliverJob(lease, { store, queue, surface: ports.surface, now });
    default:
      throw new Error(`worker has no handler for job type ${lease.type}`);
  }
}

/** Heartbeat the lease per its type config while the handler runs; a stale
 * heartbeat (the job completed under us) is none of the loop's business. */
async function withHeartbeat<T>(lease: QueueLease, options: WorkerOptions, run: () => Promise<T>): Promise<T> {
  const config = DEFAULT_TYPE_CONFIGS[lease.type] ?? DEFAULT_TYPE_CONFIG;
  if (config.heartbeatMs === null || config.heartbeatMs === undefined) return run();
  const timer = setInterval(() => {
    options.queue.heartbeat(lease, nowOf(options)()).catch(() => {});
  }, config.heartbeatMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  try {
    return await run();
  } finally {
    clearInterval(timer);
  }
}

/** One claim-and-run pass; false when nothing was claimable. */
async function runOnce(options: WorkerOptions): Promise<boolean> {
  const lease = await options.queue.claim(
    options.workerId,
    options.types ?? WORKER_JOB_TYPES,
    nowOf(options)()
  );
  if (lease === null) return false;
  try {
    await withHeartbeat(lease, options, () => dispatch(lease, options));
  } catch {
    // the handler recorded the failure and the retry is backed off; the next
    // pass claims past it. A lease whose handler died before failing is
    // reclaimed once its window lapses — never spun on this instant.
  }
  return true;
}

/**
 * Drain the board: claim and run until nothing is claimable, returning the
 * number of jobs processed. The test's shape of the loop — deterministic, no
 * polling, no wall clock beyond the handlers' own.
 *
 * A handler pair can feed itself without end — the post-turn decide re-fires
 * on its own telemetry (RUNTIME §2 re-decides every append, telemetry
 * included) — so the drain is bounded: `maxPasses` claims at most, 1000 by
 * default, far above any honest cascade and reached in milliseconds. The
 * daemon has no such bound; it runs until its signal.
 */
export async function runUntilIdle(options: WorkerOptions, maxPasses = 1000): Promise<number> {
  let processed = 0;
  while (processed < maxPasses && (await runOnce(options))) processed += 1;
  return processed;
}

/**
 * The daemon: claim and run, idling `pollIntervalMs` between empty passes,
 * until the signal aborts. Errors never kill it — a failed job is the
 * handler's retry bookkeeping, a crashed one the lease's reclaim.
 */
export async function runWorker(options: WorkerOptions): Promise<void> {
  const pollMs = options.pollIntervalMs ?? 1_000;
  while (options.signal?.aborted !== true) {
    if (await runOnce(options)) continue;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, pollMs);
      (timer as unknown as { unref?: () => void }).unref?.();
    });
  }
}
