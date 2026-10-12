// fold: the pure projection of a session or run log onto AgentState (RUNTIME section 5.1).
// It is the one function that must be pure and deterministic (section 2): no I/O, no clock,
// no randomness — the same log always folds to the same state, and the input is never
// touched. Telemetry is skipped (isFact, section 2). Facts are applied in seq order; a log
// with a gap or a duplicate seq is a broken stream and raises FoldError.
import { isFact } from "../events/schemas";
import { parseEvent } from "../events/parse";
import type { EVENT_PAYLOAD_SCHEMAS } from "../events/schemas";

/** The agent or team definition snapshot; `run.created` supplies it for runs, the session's agent version for sessions. */
export type Definition = Record<string, unknown>;

/** A `tool.call` payload, keyed by callId while it has no `tool.completed`/`tool.interrupted`. */
export type ToolCall = (typeof EVENT_PAYLOAD_SCHEMAS)["tool.call"]["_output"];

/** The last fact of the log: the trigger and payload the agent-loop rules read (RUNTIME section 5.1). */
export type LastFact = { readonly type: string; readonly payload: unknown };

/** A `human.requested` payload, keyed by waitId while it has no `human.responded`. */
export type Wait = (typeof EVENT_PAYLOAD_SCHEMAS)["human.requested"]["_output"];

/** An input a turn has not consumed yet: `message.received`, `delegation.result` or `human.responded`. */
export type PendingInput = { readonly type: string; readonly payload: unknown };

/** Exactly the AgentState of RUNTIME section 5.1. */
export type AgentState = {
  status: "idle" | "running" | "waiting" | "blocked" | "finished" | "stopped";
  def: Definition;
  turn: number;
  pendingInputs: PendingInput[];
  calls: number;
  openToolCalls: Map<string, ToolCall>;
  waits: Map<string, Wait>;
  costUsd: number;
  /** Cost of the `llm.completed`s of the current turn; reset when a turn starts (section 5.1 rule 1). */
  turnCostUsd: number;
  reservedUsd: number;
  compactedUpTo: number;
  cancelRequested: boolean;
  /** The last fact, typed and upcasted — the agent loop's rules read their trigger and payload from it. */
  lastFact: LastFact | null;
  /** Attempts made on the current call: bumped by `ll.failed`, reset by `ll.requested` (section 5.1 rule 5). */
  callAttempt: number;
};

/** A starting state; every field falls back to the fresh-session default (section 5.1). */
export type FoldInit = Partial<AgentState>;

/** Raised for a broken log: a seq gap or duplicate, named in the message. */
export class FoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FoldError";
  }
}

/** The statuses a run never leaves come from `run.blocked` / `run.stopped` / `run.finished`. */
/** run.* facts that close the run, mapped to the status they freeze. */
const RUN_CLOSED = {
  "run.blocked": "blocked",
  "run.stopped": "stopped",
  "run.finished": "finished",
} as const satisfies Record<string, AgentState["status"]>;

/** Event types the fold parks as pending inputs until a turn's first `llm.requested`. */
const INPUT_TYPES = ["message.received", "delegation.result", "human.responded"] as const;

function seqOf(event: unknown): number {
  const seq = (event as { seq?: unknown } | null | undefined)?.seq;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) {
    throw new FoldError(`event seq must be a positive integer, got ${String(seq)}`);
  }
  return seq;
}

/** A copy of the log in seq order; gaps and duplicates raise, naming the seq. */
function inSeqOrder(events: readonly unknown[]): unknown[] {
  const ordered = [...events].sort((a, b) => seqOf(a) - seqOf(b));
  let previous: number | undefined;
  for (const event of ordered) {
    const seq = seqOf(event);
    if (previous !== undefined) {
      if (seq === previous) throw new FoldError(`duplicate event seq ${seq}`);
      if (seq > previous + 1) throw new FoldError(`event seq gap: no event ${previous + 1} before ${seq}`);
    }
    previous = seq;
  }
  return ordered;
}

export function fold(events: readonly unknown[], init: FoldInit = {}): AgentState {
  let def: Definition = { ...(init.def ?? {}) };
  let turn = init.turn ?? 0;
  let calls = init.calls ?? 0;
  let costUsd = init.costUsd ?? 0;
  let turnCostUsd = init.turnCostUsd ?? 0;
  let reservedUsd = init.reservedUsd ?? 0;
  let compactedUpTo = init.compactedUpTo ?? 0;
  let cancelRequested = init.cancelRequested ?? false;
  let lastFact: LastFact | null = init.lastFact ?? null;
  let callAttempt = init.callAttempt ?? 0;
  let pendingInputs: PendingInput[] = (init.pendingInputs ?? []).map((input) => ({ ...input }));
  const openToolCalls = new Map(init.openToolCalls);
  const waits = new Map(init.waits);

  // Terminal is sticky (R2.9): once set, from the init or a run.* fact, no later fact moves it.
  let terminal =
    init.status !== undefined && init.status in RUN_CLOSED ? (init.status as AgentState["status"]) : null;

  let inTurn = false;
  let started = false;
  let prevFactType: string | null = null; // the fact before this one: tells a retry from a turn start

  for (const raw of inSeqOrder(events)) {
    const type = (raw as { type?: unknown }).type;
    if (typeof type !== "string" || !isFact(type)) continue; // telemetry: only the UI reads it
    const event = parseEvent(raw);

    lastFact = { type: event.type, payload: event.payload };
    switch (event.type) {
      case "run.created":
        // The definition snapshot freezes the run's shape (section 2); it never changes after.
        def = { ...event.payload.definition };
        break;
      case "run.started":
        started = true;
        break;
      case "message.received":
      case "delegation.result":
      case "human.responded":
        pendingInputs = [...pendingInputs, { type: event.type, payload: event.payload }];
        if (event.type === "human.responded") waits.delete(event.payload.waitId);
        break;
      case "llm.requested": {
        // A retry re-asks the call that just failed: same callNo, same turn, attempt kept
        // (section 5.1 rule 5). Anything else is a fresh call -- and call 1 starts a turn.
        const retry = prevFactType === "llm.failed";
        if (!retry) callAttempt = 0;
        if (event.payload.callNo === 1 && !retry) {
          turn += 1;
          calls = 0;
          turnCostUsd = 0; // the per-turn meter restarts with the turn (section 5.1 rule 1)
          pendingInputs = []; // the turn's first call consumes the parked inputs
        }
        inTurn = true;
        break;
      }
      case "llm.completed": {
        calls += 1;
        costUsd += event.payload.usage.costUsd;
        turnCostUsd += event.payload.usage.costUsd;
        callAttempt = 0; // the call succeeded; its retry budget is spent
        // A reply with no tool calls is the turn's last word: the loop goes quiet (section 5.1 rule 4).
        if (event.payload.toolCalls.length === 0) inTurn = false;
        break;
      }
      case "llm.failed":
        callAttempt += 1; // rule 5's one-retry budget counts per call
        break;
      case "context.compacted":
        compactedUpTo = Math.max(compactedUpTo, event.payload.upToSeq);
        break;
      case "tool.call":
        // Legacy rows may lack callId; the event id keys them so they stay visible.
        openToolCalls.set(event.payload.callId ?? event.id, event.payload);
        break;
      case "tool.completed":
      case "tool.interrupted":
        openToolCalls.delete(event.payload.callId);
        break;
      case "human.requested":
        waits.set(event.payload.waitId, event.payload);
        break;
      case "run.cancel_requested":
        cancelRequested = true;
        break;
      default:
        if (event.type in RUN_CLOSED) {
          terminal = RUN_CLOSED[event.type as keyof typeof RUN_CLOSED];
        }
        break;
    }
    prevFactType = event.type;
  }

  const status: AgentState["status"] =
    terminal ??
    (waits.size > 0
      ? "waiting"
      : inTurn || started
        ? "running"
        : (init.status ?? "idle"));

  return {
    status,
    def,
    turn,
    pendingInputs,
    calls,
    openToolCalls,
    waits,
    costUsd,
    turnCostUsd,
    reservedUsd,
    compactedUpTo,
    cancelRequested,
    lastFact,
    callAttempt,
  };
}
