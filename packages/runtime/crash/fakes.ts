// Crash-suite fakes (ANY-37 R11, RUNTIME §15.3): the model, tool and surface
// ports the kill -9 scenarios run against, built for a SEPARATE-PROCESS
// worker. Two things the in-memory fakes (src/testing/fake-*) cannot do:
//
// - Block mid-call at a named barrier, so the harness can kill the process at
//   a known point. A barrier writes `<dir>/barrier-<name>` exactly once (the
//   latch: a retrying worker that re-enters the entry sees the marker and does
//   NOT block again) and then waits for `<dir>/release-<name>` — the harness
//   either SIGKILLs the process (the wait never ends) or writes the release.
// - Record every attempt to a JSONL log file, which survives the kill: the
//   log, not process memory, is the cross-process truth the harness asserts
//   on. Script routing counts RESOLVED attempts per system/tool/target in the
//   log, so the worker that takes over mid-attempt re-enters the same entry.
//
// Deliberately self-typed against the port shapes (like the src/testing
// fakes): no import of ../src/ports at runtime, only type-only at the top.
import { existsSync, appendFileSync, writeFileSync, readFileSync } from "node:fs";

/** One line of the crash log; `ev` discriminates. */
export type CrashLogEntry =
  | { t: number; ev: "model-call"; system: string; resolved: boolean; note?: string }
  | { t: number; ev: "tool-run"; tool: string; resolved: boolean }
  | {
      t: number;
      ev: "surface-send";
      target: string;
      key: string | null;
      resolved: boolean;
      receipt: string | null;
      /** True when the idempotency key absorbed a repeat attempt. */
      deduped?: boolean;
    }
  | { t: number; ev: "claim"; worker: string; type: string; key: string; attempt: number }
  | { t: number; ev: "settle-timeout"; liveJobs: number };

/** Append one entry; the file is the shared cross-process log. */
export function logEvent(logFile: string, entry: CrashLogEntry): void {
  appendFileSync(logFile, `${JSON.stringify(entry)}\n`, "utf8");
}

/** The whole log, parsed; unreadable lines are skipped (a torn final write
 * after a kill -9 is expected and must not fail the read). */
export function readLog(logFile: string): CrashLogEntry[] {
  if (!existsSync(logFile)) return [];
  const out: CrashLogEntry[] = [];
  for (const line of readFileSync(logFile, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      out.push(JSON.parse(trimmed) as CrashLogEntry);
    } catch {
      // torn tail line — the kill's artifact
    }
  }
  return out;
}

/** Wait until the file exists; resolves false on timeout. */
export async function waitForFile(path: string, timeoutMs: number, pollMs = 20): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(path)) return true;
    if (Date.now() > deadline) return false;
    await sleep(pollMs);
  }
}

export function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * The barrier: first caller writes the marker and blocks until released (or
 * killed); later callers — the worker that took over — return at once. The
 * marker doubles as the harness's "the process reached the kill point"
 * signal.
 */
export async function barrier(dir: string, name: string): Promise<void> {
  const marker = `${dir}/barrier-${name}`;
  try {
    writeFileSync(marker, String(Date.now()), { flag: "wx" });
  } catch {
    return; // the latch: this barrier already held the first attempt
  }
  const release = `${dir}/release-${name}`;
  const deadline = Date.now() + 15 * 60_000;
  while (!existsSync(release)) {
    if (Date.now() > deadline) return;
    await sleep(15);
  }
}

// -- the model -----------------------------------------------------------------

/** One scripted model call: matched by system prompt, consumed in order per
 * system, counted by RESOLVED calls in the log (a blocked-and-killed attempt
 * does not consume its entry — the retry re-enters it, unblocked by the
 * barrier latch). */
export interface ModelScriptEntry {
  system: string;
  text?: string;
  toolCalls?: readonly Record<string, unknown>[];
  costUsd: number;
  /** Barrier to hold the call at, before it resolves. */
  block?: string;
}

export class CrashModel {
  readonly #script: readonly ModelScriptEntry[];
  readonly #logFile: string;
  readonly #dir: string;

  constructor(script: readonly ModelScriptEntry[], logFile: string, dir: string) {
    this.#script = script;
    this.#logFile = logFile;
    this.#dir = dir;
  }

  async call(request: {
    system: string;
    messages: readonly unknown[];
    tools: readonly unknown[];
  }): Promise<{
    text: string;
    toolCalls: Record<string, unknown>[];
    usage: { inputTokens: number; outputTokens: number; costUsd: number };
    finishReason: string;
  }> {
    logEvent(this.#logFile, { t: Date.now(), ev: "model-call", system: request.system, resolved: false });
    const entry = this.#entryFor(request.system);
    if (entry.block !== undefined) await barrier(this.#dir, entry.block);
    logEvent(this.#logFile, { t: Date.now(), ev: "model-call", system: request.system, resolved: true, ...noteOf(request) });
    return {
      text: entry.text ?? "",
      toolCalls: (entry.toolCalls ?? []).map((call) => ({ ...call })),
      usage: { inputTokens: 0, outputTokens: 0, costUsd: entry.costUsd },
      finishReason: "stop",
    };
  }

  #entryFor(system: string): ModelScriptEntry {
    const mine = this.#script.filter((entry) => entry.system === system);
    const resolved = readLog(this.#logFile).filter(
      (line) => line.ev === "model-call" && line.system === system && line.resolved
    ).length;
    const entry = mine[resolved];
    if (entry === undefined) {
      throw new Error(`CrashModel: no script entry #${resolved} for system "${system}"`);
    }
    return entry;
  }
}

/** The last tool-role message the worker handed the model, if any — the
 * log's window onto what the rebuilt conversation carried (K2: the
 * `tool.interrupted` note). */
function noteOf(request: { messages: readonly unknown[] }): { note: string } | Record<string, never> {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index] as { role?: unknown; text?: unknown } | undefined;
    if (message !== undefined && message.role === "tool" && typeof message.text === "string") {
      return { note: message.text };
    }
  }
  return {};
}

// -- the tools -----------------------------------------------------------------

/** One scripted run of a tool, in consumption order (resolved-count routing,
 * the model's rule). */
export interface ToolScriptRun {
  ok: boolean;
  result?: unknown;
  error?: string;
  lines?: readonly string[];
  block?: string;
}

export interface ToolScriptSpec {
  effect: "read" | "idempotent" | "rerunnable" | "once";
  runs: readonly ToolScriptRun[];
}

export class CrashTools {
  readonly #specs: Record<string, ToolScriptSpec>;
  readonly #logFile: string;
  readonly #dir: string;

  constructor(specs: Record<string, ToolScriptSpec>, logFile: string, dir: string) {
    this.#specs = specs;
    this.#logFile = logFile;
    this.#dir = dir;
  }

  async run(
    tool: string,
    args: Record<string, unknown>,
    io: { onLine?: (line: string) => void }
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    void args;
    logEvent(this.#logFile, { t: Date.now(), ev: "tool-run", tool, resolved: false });
    const run = this.#runFor(tool);
    if (run.block !== undefined) await barrier(this.#dir, run.block);
    for (const line of run.lines ?? []) io.onLine?.(line);
    logEvent(this.#logFile, { t: Date.now(), ev: "tool-run", tool, resolved: true });
    return {
      ok: run.ok,
      ...(run.result !== undefined ? { result: run.result } : {}),
      ...(run.error !== undefined ? { error: run.error } : {}),
    };
  }

  describe(tool: string): { name: string; effect: ToolScriptSpec["effect"] } | undefined {
    const spec = this.#specs[tool];
    return spec === undefined ? undefined : { name: tool, effect: spec.effect };
  }

  #runFor(tool: string): ToolScriptRun {
    const spec = this.#specs[tool];
    if (spec === undefined) throw new Error(`CrashTools: no spec for tool "${tool}"`);
    const resolved = readLog(this.#logFile).filter((line) => line.ev === "tool-run" && line.tool === tool && line.resolved)
      .length;
    const run = spec.runs[resolved];
    if (run === undefined) {
      throw new Error(`CrashTools: no scripted run #${resolved} for tool "${tool}"`);
    }
    return run;
  }
}

// -- the surface ---------------------------------------------------------------

export interface SurfaceScriptSpec {
  /** Hold the send of this target at the barrier, after the attempt is logged
   * but before the receipt returns — K5's kill point: the message left, the
   * recording never committed. */
  block?: { target: string; barrier: string };
}

export class CrashSurface {
  readonly #spec: SurfaceScriptSpec;
  readonly #logFile: string;
  readonly #dir: string;

  constructor(spec: SurfaceScriptSpec, logFile: string, dir: string) {
    this.#spec = spec;
    this.#logFile = logFile;
    this.#dir = dir;
  }

  async send(
    target: string,
    message: { text: string; subject?: string },
    options?: { idempotencyKey?: string }
  ): Promise<{ platformMessageId: string }> {
    void message;
    const key = options?.idempotencyKey ?? null;
    // The adapter-side dedupe the idempotency key buys: a repeat attempt with
    // a key that already earned a receipt returns that receipt and lands
    // nothing (KM4 strips the key, so every attempt lands).
    const prior = readLog(this.#logFile).find(
      (line) => line.ev === "surface-send" && line.key !== null && line.key === key && line.resolved
    );
    if (prior !== undefined && prior.ev === "surface-send") {
      logEvent(this.#logFile, {
        t: Date.now(),
        ev: "surface-send",
        target,
        key,
        resolved: true,
        receipt: prior.receipt,
        deduped: true,
      });
      return { platformMessageId: prior.receipt ?? "pm-?" };
    }
    logEvent(this.#logFile, { t: Date.now(), ev: "surface-send", target, key, resolved: false, receipt: null });
    const receipt = `pm-${readLog(this.#logFile).filter((line) => line.ev === "surface-send" && line.resolved).length + 1}`;
    logEvent(this.#logFile, { t: Date.now(), ev: "surface-send", target, key, resolved: true, receipt });
    // K5's kill point: the message left (the receipt is logged), the
    // handler's `message.delivered` has not committed — hold the return.
    if (this.#spec.block !== undefined && this.#spec.block.target === target) {
      await barrier(this.#dir, this.#spec.block.barrier);
    }
    return { platformMessageId: receipt };
  }
}
