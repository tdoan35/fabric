// decide: the agent loop's decision function (RUNTIME section 5.1, rules 1-6). Pure: `now` is an
// argument, every job key derives from the state and the definition, and the output is recorded,
// never replayed (section 2) — the same inputs always give the same events and jobs.
//
// The state is the fold's AgentState; the rules read their trigger and payload from `lastFact`
// (the last fact) because rules 2, 4 and 5 act on the last `llm.completed` / `llm.failed`, whose
// tool calls, text and error exist nowhere else. Rule 7 (compaction) belongs to `llm.call` (R9);
// child-run cancellation and delegation belong to R4 and are only reserved here.
import { parseStreamId } from "../streams";
import type { AgentState } from "../fold/fold";

/** The knobs the agent loop decides with; the caller supplies them from the definition snapshot. */
export type DecideDef = {
  /** Keys embed the stream id (section 4); decide learns it here. */
  streamId: string;
  /** Tools the run may execute. `ask_user` is reserved and routes to a wait; `delegate` is R4's. */
  tools: readonly string[];
  /** MAX_STEPS: the calls allowed before the turn ends without another model call. */
  maxSteps: number;
  /** The model recorded on `llm.requested`. */
  model?: string;
  /** How long an `ask_user` wait runs to its deadline; 5 minutes when the definition is silent. */
  askWaitMs?: number;
  /** Per-turn cost cap for sessions (ARCHITECTURE section 1, 2026-10-11; PRODUCT section 4.1). */
  turnCostCapUsd?: number | null;
  /** Total budget for runs; cost above `costUsd` blocks the run. Its presence marks a run. */
  budget?: { costUsd?: number } | null;
  /** Where a session's reply is delivered; one `deliver` job each. */
  surfaces?: readonly string[];
  /** The run's parent from `run.created` (null when the API created the run); present iff this is a run. */
  parent?: { runId?: string; sessionId?: string; callId?: string } | null;
  /** Effect class per allowed tool (section 6), recorded on the `tool.call`. */
  toolEffects?: Readonly<Record<string, "read" | "idempotent" | "rerunnable" | "once">>;
};

/** An event decide appends. The worker supplies the rest of the envelope (seq, ts, causation, ...). */
export type DecideEvent = { id?: string; type: string; payload: Record<string, unknown> };

/** A queued job: `type`, the idempotency `key` (section 4), the stream, and `runAt` for timers. */
export type DecideJob = {
  type: "llm.call" | "tool.exec" | "deliver" | "run.timer" | "delegate.resolve";
  key: string;
  streamId: string;
  runAt?: number;
};

/** The decision: events to append, jobs to queue — each possibly empty. */
export type Decision = { events: DecideEvent[]; jobs: DecideJob[] };

/** Deadline horizon for `ask_user` waits when the definition does not name one. */
const DEFAULT_ASK_WAIT_MS = 5 * 60_000;

/** The wait an `ask_user` call opens, derived from the turn and call so a re-decide cannot fork it. */
function waitIdFor(turn: number, callId: string): string {
  return `wait:${turn}:${callId}`;
}

/** The id of the agent.message copy of a turn's reply; the deliver keys hang off it. */
function messageId(streamId: string, turn: number): string {
  return `agent-message:${streamId}:${turn}`;
}

/** Rule 3/5/6's `llm.requested` plus its `llm.call` job, keyed per section 4. */
function requestModelCall(
  def: DecideDef,
  turn: number,
  callNo: number,
  events: DecideEvent[],
  jobs: DecideJob[]
): void {
  events.push({
    type: "llm.requested",
    payload: { turn, callNo, model: def.model ?? "default", params: {}, snapshotId: null },
  });
  jobs.push({ type: "llm.call", key: `${def.streamId}:${turn}:llm:${callNo}`, streamId: def.streamId });
}

/** The turn-ending of rule 4: a session copies the reply out to every surface; a run finishes. */
function endTurn(
  state: AgentState,
  def: DecideDef,
  reply: string,
  events: DecideEvent[],
  jobs: DecideJob[]
): void {
  if (isRun(def)) {
    events.push({ type: "run.finished", payload: { result: reply, costUsd: state.costUsd } });
    if (def.parent && (def.parent.runId || def.parent.sessionId)) {
      jobs.push({
        type: "delegate.resolve",
        key: `run:${runIdOf(def.streamId)}:resolve`,
        streamId: def.streamId,
      });
    }
    return;
  }
  const id = messageId(def.streamId, state.turn);
  events.push({ id, type: "agent.message", payload: { text: reply } });
  for (const target of def.surfaces ?? []) {
    jobs.push({ type: "deliver", key: `deliver:${id}:${target}`, streamId: def.streamId });
  }
}

/** A run carries `parent` from `run.created` (null when the API created it); a session does not. */
function isRun(def: DecideDef): boolean {
  return "parent" in def;
}

/** The rule 4-at-the-limit ending speaks the last completion's word; the fold kept it. */
function lastTextOf(state: AgentState): string {
  const payload = (state.lastFact?.payload ?? {}) as Record<string, unknown>;
  return typeof payload.text === "string" ? payload.text : "";
}

/**
 * The agent loop (RUNTIME section 5.1, rules 1-6, in order).
 * Rule 7 (compaction) belongs to `llm.call`; child cancellation and delegation arrive in R4.
 */
export function decideAgent(state: AgentState, def: DecideDef, now: number): Decision {
  const events: DecideEvent[] = [];
  const jobs: DecideJob[] = [];
  const stream = def.streamId;

  // A closed run never decides again; terminal statuses are sticky (section 5.1).
  if (state.status === "blocked" || state.status === "finished" || state.status === "stopped") {
    return { events, jobs };
  }

  // -- Rule 1: cancellation, then budget, then the session's per-turn cap -----------------------

  if (state.cancelRequested) {
    for (const callId of state.openToolCalls.keys()) {
      events.push({ type: "tool.completed", payload: { callId, ok: false, error: "cancelled" } });
    }
    events.push({ type: "run.stopped", payload: { by: "decide", text: "Cancellation requested." } });
    return { events, jobs };
  }

  const budgetCap = def.budget?.costUsd;
  if (typeof budgetCap === "number" && state.costUsd > budgetCap) {
    events.push({ type: "run.blocked", payload: { reason: "budget" } });
    return { events, jobs };
  }

  const last = state.lastFact;
  const lastType = last?.type;
  const lastPayload = (last?.payload ?? {}) as Record<string, unknown>;

  // -- Rule 2: the last completion asked for tools; policy-route each one ------------------------

  if (lastType === "llm.completed") {
    const toolCalls = Array.isArray(lastPayload.toolCalls) ? lastPayload.toolCalls : [];
    if (toolCalls.length > 0) {
      for (const call of toolCalls) {
        const record = (call ?? {}) as Record<string, unknown>;
        const name = typeof record.name === "string" ? record.name : "";
        const callId = typeof record.id === "string" ? record.id : "";
        const args = (record.args ?? {}) as Record<string, unknown>;

        if (!def.tools.includes(name)) {
          events.push({
            type: "tool.denied",
            payload: { tool: name, target: "", reason: "tool is not in the run's allowlist", callId },
          });
          continue;
        }
        if (name === "ask_user") {
          const waitId = waitIdFor(state.turn, callId);
          const deadline = now + (def.askWaitMs ?? DEFAULT_ASK_WAIT_MS);
          const prompt = typeof args.prompt === "string" ? args.prompt : "";
          events.push({
            type: "human.requested",
            payload: { waitId, kind: "answer", gated: false, prompt, deadline },
          });
          jobs.push({
            type: "run.timer",
            key: `${stream}:timer:${waitId}`,
            streamId: def.streamId,
            runAt: deadline,
          });
          continue;
        }
        // `delegate` routes through section 5.2 in R4; until then it is an ordinary call.
        events.push({
          type: "tool.call",
          payload: {
            tool: name,
            summary: typeof record.summary === "string" ? record.summary : "",
            callId,
            args,
            effect: def.toolEffects?.[name],
          },
        });
        jobs.push({ type: "tool.exec", key: `${stream}:${callId}`, streamId: def.streamId });
      }
      return { events, jobs };
    }

    // -- Rule 4: a completion with no tool calls is the turn's last word ------------------------
    endTurn(state, def, typeof lastPayload.text === "string" ? lastPayload.text : "", events, jobs);
    return { events, jobs };
  }

  // -- Rule 5: the call failed; one retry when retryable, else the turn ends with the news -------

  if (lastType === "llm.failed") {
    const callNo = typeof lastPayload.callNo === "number" ? lastPayload.callNo : state.calls;
    const error = typeof lastPayload.error === "string" ? lastPayload.error : "unknown error";
    // Rule 5: one retry per call (the fold counts the attempts); the second one ends the turn.
    if (lastPayload.retryable === true && state.callAttempt <= 1) {
      requestModelCall(def, state.turn, callNo, events, jobs);
      return { events, jobs };
    }
    endTurn(state, def, `The call failed: ${error}.`, events, jobs);
    return { events, jobs };
  }

  // -- Rules 3 and 4 at the limit: every call of the turn has resolved ---------------------------

  const resolved = lastType === "tool.completed" || lastType === "tool.interrupted";
  if (resolved && state.openToolCalls.size === 0 && state.calls > 0) {
    // The per-turn cap ends the turn before another model call is queued (rule 1, session cap):
    // the reply says so and offers delegation (PRODUCT section 4.1).
    const cap = def.turnCostCapUsd;
    if (typeof cap === "number" && state.turnCostUsd >= cap) {
      endTurn(
        state,
        def,
        `The turn's cost cap (${cap} USD) was reached; delegate the rest of the work to continue.`,
        events,
        jobs
      );
      return { events, jobs };
    }
    if (state.calls >= def.maxSteps) {
      // Rule 4 at MAX_STEPS: the turn ends on the last completion's word.
      endTurn(state, def, lastTextOf(state), events, jobs);
      return { events, jobs };
    }
    requestModelCall(def, state.turn, state.calls + 1, events, jobs);
    return { events, jobs };
  }

  // -- Rule 6: idle with pending inputs starts a turn ---------------------------------------------

  if (state.status === "idle" && state.pendingInputs.length > 0) {
    requestModelCall(def, state.turn + 1, 1, events, jobs);
  }

  // Rules 1-6 leave nothing to do: an open wait, tools in flight, a bare `llm.requested`...
  return { events, jobs };
}

/** The run id behind a run stream (`run:<id>`), for keys that name the run itself. */
export function runIdOf(streamId: string): string {
  return parseStreamId(streamId).id;
}
