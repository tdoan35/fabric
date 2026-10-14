// The `tool.exec` job handler (RUNTIME §4, §6): run the one tool the stream's
// `tool.call` names, stream its terminal lines into the log as `tool.result`
// telemetry, and append `tool.completed` — plus `artifact.created` and
// `memory.written` when the result carries them — with `causation =
// <stream>:<callId>`, the job key, so R5's unique index and the recorded-
// result guard make a re-run append nothing twice (W11b).
//
// Recovery is by effect class (§6): a retry — the lease's attempt > 1 — that
// finds no recorded result reruns `read`/`idempotent` tools, and records
// `tool.interrupted` instead of running `rerunnable` and `once` a second
// time; `once` additionally asks a human whether the first attempt landed,
// passing the provider's idempotency key through in the prompt when the call
// carried one. The port is the run-scoped adapter: whoever assembles the deps
// binds it to the run's effective access; the handler passes the call through.
//
// The whole attempt is one transaction (the telemetry, the facts and the
// lease's completion commit together), so a crash leaves the retry the
// no-result state the effect classes are for.
import type { Queue, QueueLease } from "../queue/types";
import type { ToolEffect, ToolPort, ToolRunResult } from "../ports";
import { append } from "../store/store";
import type { EventInput, RuntimeStore } from "../store/types";
import { enqueueReDecides, readEventRows, type EventRow } from "./decide";

export type ToolExecJobDeps = {
  store: RuntimeStore;
  queue: Queue;
  /** The run-scoped tool port, bound to the run's effective access upstream. */
  tools: ToolPort;
  /** Injected clock, handed to the queue's retry bookkeeping. */
  now?: () => number;
};

/** §6's rerunnable note: the model sees it as the result and decides anew. */
const INTERRUPTED_NOTE = "interrupted by a restart; effects may be partial";

/** §6's once escalation: did the first attempt's effects land? */
const HUMAN_PROMPT = "check whether this happened";

const EFFECTS: readonly ToolEffect[] = ["read", "idempotent", "rerunnable", "once"];
const MEMORY_OPS: readonly string[] = ["add", "update", "forget"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isEffect = (value: unknown): value is ToolEffect =>
  typeof value === "string" && (EFFECTS as readonly string[]).includes(value);

/** `<stream>:<callId>` — stream ids carry colons, so split on the first key prefix. */
function callIdFromKey(key: string, streamId: string): string | null {
  if (!key.startsWith(`${streamId}:`)) return null;
  const callId = key.slice(streamId.length + 1);
  return callId.length > 0 ? callId : null;
}

/** The latest `tool.call` the job names, payload and all. */
function findToolCall(rows: readonly EventRow[], callId: string): Record<string, unknown> | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.type !== "tool.call") continue;
    const payload = isRecord(row.payload) ? row.payload : {};
    if (payload.callId === callId) return payload;
  }
  return null;
}

/** The effect class: the `tool.call`'s declaration, else the registry's, else
 * `read` — the safe default, a re-run of an unclassified tool. */
function effectOf(payload: Record<string, unknown>, tools: ToolPort, tool: string): ToolEffect {
  if (isEffect(payload.effect)) return payload.effect;
  return tools.describe(tool)?.effect ?? "read";
}

/** The terminal-line telemetry batch: one `tool.result` per line, seq-ordered,
 * causation-suffixed off the job key like every other per-event mark. */
function telemetryBatch(key: string, lines: readonly string[]): EventInput[] {
  return lines.map((line, n) => ({
    type: "tool.result",
    actor: "tool.exec",
    payload: { line, kind: "term" },
    causation: `${key}:tool.result:${n}`,
  }));
}

/** The result facts: `artifact.created` / `memory.written` projected from the
 * result's `artifact` / `memory` records when it carries well-formed ones —
 * the memory fact is `contentRef`-shaped, the text lives outside the log —
 * then `tool.completed`, the call's terminal fact, last. */
function completionFacts(key: string, callId: string, result: ToolRunResult): EventInput[] {
  const facts: EventInput[] = [];
  const value = isRecord(result.result) ? result.result : {};

  if (isRecord(value.artifact) && typeof value.artifact.name === "string") {
    const artifact = value.artifact;
    facts.push({
      type: "artifact.created",
      actor: "tool.exec",
      payload: {
        name: artifact.name,
        ...(typeof artifact.artifactId === "string" ? { artifactId: artifact.artifactId } : {}),
      },
      causation: `${key}:artifact.created`,
    });
  }

  if (isRecord(value.memory)) {
    const memory = value.memory;
    if (
      typeof memory.scope === "string" &&
      typeof memory.itemId === "string" &&
      typeof memory.op === "string" &&
      MEMORY_OPS.includes(memory.op) &&
      typeof memory.contentRef === "string"
    ) {
      facts.push({
        type: "memory.written",
        actor: "tool.exec",
        payload: { scope: memory.scope, itemId: memory.itemId, op: memory.op, contentRef: memory.contentRef },
        causation: `${key}:memory.written`,
      });
    }
  }

  facts.push({
    type: "tool.completed",
    actor: "tool.exec",
    payload: {
      callId,
      ok: result.ok,
      ...(result.result !== undefined ? { result: result.result } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
    },
    causation: key,
  });
  return facts;
}

/** The recovery facts: `tool.interrupted` — the model's result — and, on
 * `once`, the human escalation, idempotency key passed through when the call
 * carried one. */
function recoveryFacts(
  key: string,
  callId: string,
  effect: ToolEffect,
  args: Record<string, unknown>
): EventInput[] {
  const events: EventInput[] = [
    {
      type: "tool.interrupted",
      actor: "tool.exec",
      payload: { callId, effect, note: INTERRUPTED_NOTE },
      causation: key,
    },
  ];
  if (effect === "once") {
    const idempotencyKey = typeof args.idempotencyKey === "string" ? args.idempotencyKey : undefined;
    events.push({
      type: "human.requested",
      actor: "tool.exec",
      payload: {
        waitId: `wait:recovered:${callId}`,
        kind: "confirm",
        gated: false,
        prompt:
          idempotencyKey === undefined ? HUMAN_PROMPT : `${HUMAN_PROMPT} (idempotency key: ${idempotencyKey})`,
        deadline: null,
      },
      causation: `${key}:human.requested`,
    });
  }
  return events;
}

/**
 * Run one claimed `tool.exec` job. A tool failure is a result
 * (`tool.completed { ok: false }`), not a job failure; job-level errors fail
 * the lease per the type's retry config and rethrow, so the runner sees the
 * failure too — the retry re-enters through the effect-class recovery.
 */
export async function handleToolExecJob(lease: QueueLease, deps: ToolExecJobDeps): Promise<void> {
  const { store, queue, tools } = deps;
  const now = deps.now ?? (() => Date.now());
  const streamId = lease.streamId;
  if (streamId === null) throw new Error("tool.exec job without a stream");
  const key = lease.key;
  const callId = callIdFromKey(key, streamId);
  if (callId === null) throw new Error(`tool.exec key ${key} does not parse as <stream>:<callId>`);

  let recorded = false;
  try {
    await store.transaction(async (tx) => {
      // W11b: the result already recorded — an at-least-once re-run. Skip the
      // run and the append; the tail completes the lease tolerantly.
      const done = await tx.query(
        `select 1 from events where stream_id = $1 and workspace_id = $2 and causation = $3 and class = 'fact' limit 1`,
        [streamId, lease.workspaceId, key]
      );
      if (done.length > 0) {
        recorded = true;
        return;
      }

      const rows = await readEventRows(tx, streamId, lease.workspaceId);
      const call = findToolCall(rows, callId);
      if (call === null) throw new Error(`tool.exec ${key}: no tool.call ${callId} on ${streamId}`);
      const tool = typeof call.tool === "string" ? call.tool : "";
      const args = isRecord(call.args) ? call.args : {};
      const effect = effectOf(call, tools, tool);

      // §6: a retry with no recorded result. read/idempotent run again;
      // rerunnable/once record the interruption instead of a second run.
      const recover = lease.attempt > 1 && (effect === "rerunnable" || effect === "once");

      if (recover) {
        await append(tx, lease.workspaceId, [{ streamId, events: recoveryFacts(key, callId, effect, args) }]);
      } else {
        const lines: string[] = [];
        const result: ToolRunResult = await tools.run(tool, args, {
          onLine: (line) => lines.push(line),
          callId, // ANY-72: the id a `once` tool derives its idempotency key from
          streamId, // ANY-57: the stream the body acts on (session tools)
        });
        const batches: { streamId: string; events: EventInput[] }[] = [];
        if (lines.length > 0) batches.push({ streamId, events: telemetryBatch(key, lines) });
        batches.push({ streamId, events: completionFacts(key, callId, result) });
        await append(tx, lease.workspaceId, batches);
      }

      // §2: the stream gained facts — the decide loop continues from them.
      await enqueueReDecides(tx, queue, lease.workspaceId, [streamId]);
      await queue.complete(tx, lease);
    });
  } catch (error) {
    await queue.fail(lease, error instanceof Error ? error : new Error(String(error)), {
      retryable: true,
    }, now());
    throw error;
  }
  if (recorded) {
    // The result is durable; complete the lease, tolerating the runner that
    // got there first — its completion is the proof the guard saw.
    try {
      await store.transaction((tx) => queue.complete(tx, lease));
    } catch (error) {
      const job = await queue.get(lease.jobId);
      if (job?.status !== "completed") throw error;
    }
  }
}
