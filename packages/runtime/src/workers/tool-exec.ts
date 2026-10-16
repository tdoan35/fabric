// The `tool.exec` job handler (RUNTIME §4, §6): run the one tool the stream's
// `tool.call` names, stream its terminal lines into the log as `tool.result`
// telemetry, and append `tool.completed` — plus `artifact.created` and
// `memory.written` when the result carries them — with `causation =
// <stream>:<callId>`, the job key, so R5's unique index and the recorded-
// result guard make a re-run append nothing twice (W11b).
//
// The attempt is two-phase (R14): the read (done-guard, the call, the
// recovery) and the record (telemetry, completion facts, the re-decide, the
// lease) are each one transaction, and the tool itself runs BETWEEN them,
// outside any store transaction — a long call must not hold the store's
// connection (PGlite's one connection is serialized; Postgres would pin a
// pool client for the whole run). The record phase re-checks the done-guard:
// a result that arrives after another runner's is discarded and the lease is
// completed tolerantly, exactly like the recorded path.
//
// Recovery is by effect class (§6): a retry — the lease's attempt > 1 — that
// finds no recorded result reruns `read`/`idempotent` tools, and records
// `tool.interrupted` instead of running `rerunnable` and `once` a second
// time; `once` additionally asks a human whether the first attempt landed,
// passing the provider's idempotency key through in the prompt when the call
// carried one. Recovery stays in the read transaction — its facts, the
// re-decide and the lease completion commit together, with no tool run. The
// port is the run-scoped adapter: whoever assembles the deps binds it to the
// run's effective access; the handler passes the call through, with the
// lease's workspace and the stream's session agent (S2) in the io.
import type { Queue, QueueLease } from "../queue/types";
import type { ToolEffect, ToolPort, ToolRunResult } from "../ports";
import type { SandboxSlots } from "../slots";
import { append } from "../store/store";
import type { EventInput, RuntimeStore, RuntimeTx } from "../store/types";
import { enqueueReDecides, readEventRows, type EventRow } from "./decide";

export type ToolExecJobDeps = {
  store: RuntimeStore;
  queue: Queue;
  /** The run-scoped tool port, bound to the run's effective access upstream. */
  tools: ToolPort;
  /** The workspace's sandbox slots (T16); absent on host mode, whose calls
   * hold no slot and run exactly as before. */
  slots?: SandboxSlots;
  /** Injected clock, handed to the queue's retry bookkeeping. */
  now?: () => number;
};

/** §6's rerunnable note: the model sees it as the result and decides anew. */
const INTERRUPTED_NOTE = "interrupted by a restart; effects may be partial";

/** §6's once escalation: did the first attempt's effects land? */
const HUMAN_PROMPT = "check whether this happened";

/** T16: a slot-refused job comes back this much later, attempt untouched. */
const SLOT_DEFER_MS = 2_000;

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

/** The queue priority of a stream's tool calls (T16): chat turns — `session:`
 * streams — rank ahead of everything else. */
function slotPriority(streamId: string): number {
  return streamId.startsWith("session:") ? 0 : 1;
}

/** T16: the call's slot-wait ledger, read off the stream's rows: the position
 * the fold's `queuedCalls` rule still reports — the latest `tool.queued`'s
 * position when no later `tool.dequeued`, completion or interruption for the
 * call follows it, null once the call is not waiting — plus how many
 * `tool.queued` and `tool.dequeued` facts the call has already recorded. The
 * counts give each transition its own identity (its causation's ordinal), so
 * a later waiting period — or a return to an earlier position — records
 * instead of deduplicating into an earlier fact, while the fold-position
 * comparison below suppresses repeated observations of the current state. */
function queuedStateOf(
  rows: readonly EventRow[],
  callId: string
): { position: number | null; queuedCount: number; dequeuedCount: number } {
  let queuedCount = 0;
  let dequeuedCount = 0;
  let position: number | null = null;
  let closed = false; // a dequeue, completion or interruption newer than the newest wait
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.class !== "fact") continue;
    const payload = isRecord(row.payload) ? row.payload : {};
    if (payload.callId !== callId) continue;
    if (row.type === "tool.queued") {
      queuedCount += 1;
      if (position === null && !closed) position = Number(payload.position);
    } else if (row.type === "tool.dequeued") {
      dequeuedCount += 1;
      closed = true;
    } else if (row.type === "tool.completed" || row.type === "tool.interrupted") {
      closed = true;
    }
  }
  return { position, queuedCount, dequeuedCount };
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

/** The folded `session.agentId` (S2): the last `session.created`'s agent —
 * undefined when the stream hosts no session (a run). */
function sessionAgentId(rows: readonly EventRow[]): string | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.type !== "session.created") continue;
    const payload = isRecord(row.payload) ? row.payload : {};
    if (typeof payload.agentId === "string") return payload.agentId;
  }
  return undefined;
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

/** The done-guard: a fact already caused by this key on this stream (W11b). */
async function recordedAlready(
  tx: RuntimeTx,
  streamId: string,
  workspaceId: string,
  key: string
): Promise<unknown[]> {
  return tx.query(
    `select 1 from events where stream_id = $1 and workspace_id = $2 and causation = $3 and class = 'fact' limit 1`,
    [streamId, workspaceId, key]
  );
}

/** The result is durable; complete the lease, tolerating the runner that got
 * there first — its completion is the proof the guard saw. */
async function completeTolerantly(store: RuntimeStore, queue: Queue, lease: QueueLease): Promise<void> {
  try {
    await store.transaction((tx) => queue.complete(tx, lease));
  } catch (error) {
    const job = await queue.get(lease.jobId);
    if (job?.status !== "completed") throw error;
  }
}

/** The job-failure path: the lease fails retryably per the type's config and
 * the error rethrows, so the runner sees the failure too. */
async function failRetryably(lease: QueueLease, deps: ToolExecJobDeps, error: unknown): Promise<never> {
  await deps.queue.fail(
    lease,
    error instanceof Error ? error : new Error(String(error)),
    { retryable: true },
    (deps.now ?? (() => Date.now()))()
  );
  throw error;
}

/**
 * Run one claimed `tool.exec` job, in two phases around the tool run. A tool
 * failure is a result (`tool.completed { ok: false }`), not a job failure;
 * job-level errors fail the lease per the type's retry config and rethrow, so
 * the runner sees the failure too — the retry re-enters through the
 * effect-class recovery.
 */
export async function handleToolExecJob(lease: QueueLease, deps: ToolExecJobDeps): Promise<void> {
  const { store, queue, tools } = deps;
  const streamId = lease.streamId;
  if (streamId === null) throw new Error("tool.exec job without a stream");
  const key = lease.key;
  const callId = callIdFromKey(key, streamId);
  if (callId === null) throw new Error(`tool.exec key ${key} does not parse as <stream>:<callId>`);

  // -- phase 1: read — the done-guard, the recovery, or the call to run ------
  let recorded = false;
  let staged: {
    tool: string;
    args: Record<string, unknown>;
    agentId: string | undefined;
    /** T16: the call holds a workspace sandbox slot before it runs. */
    wantSlot: boolean;
    /** T16: the position the call still waits at; null when not queued. */
    queuedPos: number | null;
    /** T16: the ordinal of the call's next `tool.queued` fact — one past the
     * waits already recorded, so a new waiting period (or a return to an
     * earlier position) is its own fact, never a deduplicate of an old one. */
    queuedSeq: number;
    /** T16: the ordinal of the call's next `tool.dequeued` fact. */
    dequeuedSeq: number;
  } | null = null;
  /** T16: the recovery branch finished a call that participates in the slot
   * protocol — its registration (waiter or crashed holder) goes back after
   * the read commits, never outliving the call. */
  let recoveredWithSlot = false;
  try {
    await store.transaction(async (tx) => {
      // W11b: the result already recorded — an at-least-once re-run. Skip the
      // run and the append; the tail completes the lease tolerantly.
      const done = await recordedAlready(tx, streamId, lease.workspaceId, key);
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

      // §6: a retry with no recorded result. read/idempotent run again (in
      // phase 2, below); rerunnable/once record the interruption instead of a
      // second run — here, in this same transaction: facts, re-decide, lease.
      const recover = lease.attempt > 1 && (effect === "rerunnable" || effect === "once");

      if (recover) {
        await append(tx, lease.workspaceId, [{ streamId, events: recoveryFacts(key, callId, effect, args) }]);
        // §2: the stream gained facts — the decide loop continues from them.
        await enqueueReDecides(tx, queue, lease.workspaceId, [streamId]);
        await queue.complete(tx, lease);
        // T16: the recovery is the call's terminal fact — a queued call's
        // waiter row (or a crashed attempt's held row) must not outlive it,
        // or the phantom ranks ahead of every later acquire forever.
        recoveredWithSlot = deps.slots !== undefined && (tools.needsSlot?.(tool) ?? false);
        return;
      }

      // T16: the slot gate opens only when the runtime wired slots and the
      // tool itself runs in a sandbox — host mode never asks.
      const wantSlot = deps.slots !== undefined && (tools.needsSlot?.(tool) ?? false);
      const wait = wantSlot
        ? queuedStateOf(rows, callId)
        : { position: null, queuedCount: 0, dequeuedCount: 0 };
      staged = {
        tool,
        args,
        agentId: sessionAgentId(rows),
        wantSlot,
        queuedPos: wait.position,
        queuedSeq: wait.queuedCount + 1,
        dequeuedSeq: wait.dequeuedCount + 1,
      };
    });
  } catch (error) {
    await failRetryably(lease, deps, error);
  }

  if (recorded) {
    await completeTolerantly(store, queue, lease);
    return;
  }
  if (recoveredWithSlot) await deps.slots?.release(key).catch(() => {});
  if (staged === null) return; // the recovery branch completed the lease in phase 1
  const { tool, args, agentId, wantSlot, queuedPos, queuedSeq, dequeuedSeq } = staged;

  // -- the slot gate (T16): between the read and the run ----------------------
  // The slot is held per tool call — this job's key — never per run, and a
  // chat turn's call ranks ahead of a run's. The wait is a fact: refused, the
  // handler appends `tool.queued` — one fact per transition, its ordinal in
  // the causation, so a later waiting period or a return to an earlier
  // position records instead of deduplicating into an old fact, while a
  // repeat of the position the fold still reports appends nothing — and
  // defers the job 2 s, attempt untouched; granted to a queued call, it
  // appends `tool.dequeued` (same ordinal scheme, one per waiting period)
  // with the wait — that re-decides, so the watchdog re-arms (§7). The whole
  // span from the acquire on is cleanup-guarded: once a grant is held, every
  // later failure — the dequeue fact, the run, the record — releases the
  // slot and follows the job's normal failure path, never a stranded hold.
  let heldSlot = false;
  try {
    if (wantSlot && deps.slots !== undefined) {
      const nowMs = (deps.now ?? (() => Date.now()))();
      const verdict = await deps.slots.acquire({
        workspaceId: lease.workspaceId,
        callKey: key,
        priority: slotPriority(streamId),
        now: nowMs,
      });
      if (!verdict.granted) {
        const events: EventInput[] = [];
        if (queuedPos !== verdict.position) {
          events.push({
            type: "tool.queued",
            actor: "tool.exec",
            payload: { callId, reason: "sandbox_slot", position: verdict.position },
            causation: `${key}:tool.queued:${queuedSeq}`,
          });
        }
        await store.transaction(async (tx) => {
          // Another runner may have recorded while this one asked for a slot:
          // then nothing defers and the waiter row goes back with the tail.
          const done = await recordedAlready(tx, streamId, lease.workspaceId, key);
          if (done.length > 0) {
            recorded = true;
            return;
          }
          if (events.length > 0) await append(tx, lease.workspaceId, [{ streamId, events }]);
          await queue.defer(tx, lease, nowMs + SLOT_DEFER_MS);
        });
        if (recorded) {
          await deps.slots.release(key).catch(() => {});
          await completeTolerantly(store, queue, lease);
        }
        return; // nothing runs; the job comes back on its own
      }
      // The grant is a held slot from here on — everything after it runs
      // under the cleanup below.
      heldSlot = true;
      if (queuedPos !== null) {
        await store.transaction(async (tx) => {
          await append(tx, lease.workspaceId, [
            {
              streamId,
              events: [
                {
                  type: "tool.dequeued",
                  actor: "tool.exec",
                  payload: { callId, waitedMs: Math.max(0, nowMs - verdict.since) },
                  causation: `${key}:tool.dequeued:${dequeuedSeq}`,
                },
              ],
            },
          ]);
          // §2: the dequeue re-decides, so the watchdog re-arms past the wait.
          await enqueueReDecides(tx, queue, lease.workspaceId, [streamId]);
        });
      }
    }

    // -- phase 2: the run, outside any store transaction ------------------------
    const lines: string[] = [];
    let result: ToolRunResult;
    let doneByOther = false;
    result = await tools.run(tool, args, {
      onLine: (line) => lines.push(line),
      callId, // ANY-72: the id a `once` tool derives its idempotency key from
      streamId, // ANY-57: the stream the body acts on (session tools)
      workspaceId: lease.workspaceId, // R14: the lease's workspace, no store read needed
      ...(agentId !== undefined ? { agentId } : {}), // S2: the session's agent; absent for runs
    });

    // -- phase 3: record — the guard, then appends, re-decide and lease --------
    await store.transaction(async (tx) => {
      const done = await recordedAlready(tx, streamId, lease.workspaceId, key);
      if (done.length > 0) {
        // Another runner recorded while this one ran: append nothing, discard
        // this result, complete tolerantly like the recorded path.
        doneByOther = true;
        return;
      }
      const batches: { streamId: string; events: EventInput[] }[] = [];
      if (lines.length > 0) batches.push({ streamId, events: telemetryBatch(key, lines) });
      batches.push({ streamId, events: completionFacts(key, callId, result) });
      await append(tx, lease.workspaceId, batches);

      // §2: the stream gained facts — the decide loop continues from them.
      await enqueueReDecides(tx, queue, lease.workspaceId, [streamId]);
      await queue.complete(tx, lease);
    });
    // T16: the record committed — the slot goes back with the completion (or
    // with the discard, when another runner recorded first); the failure path
    // releases in the catch below.
    if (heldSlot) await deps.slots?.release(key).catch(() => {});
    if (doneByOther) await completeTolerantly(store, queue, lease);
  } catch (error) {
    // T16: the failure path releases too — a failed call never holds a slot —
    // and the lease fails retryably so the job retries through the gate.
    if (heldSlot) await deps.slots?.release(key).catch(() => {});
    await failRetryably(lease, deps, error);
  }
}
