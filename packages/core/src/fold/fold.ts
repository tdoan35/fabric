// fold: the pure projection of a session or run log onto AgentState (RUNTIME section 5.1).
// It is the one function that must be pure and deterministic (section 2): no I/O, no clock,
// no randomness — the same log always folds to the same state, and the input is never
// touched. Telemetry is skipped (isFact, section 2). Facts are applied in seq order; a log
// with a gap or a duplicate seq is a broken stream and raises FoldError.
import { isFact } from "../events/schemas";
import { parseEvent } from "../events/parse";
import type { EVENT_PAYLOAD_SCHEMAS } from "../events/schemas";
import { DEFAULT_APPROVAL_MODE } from "../policy/policy";
import type { ApprovalMode } from "../policy/policy";

/** The agent or team definition snapshot; `run.created` supplies it for runs, the session's agent version for sessions. */
export type Definition = Record<string, unknown>;

/** A `tool.call` payload, keyed by callId while it has no `tool.completed`/`tool.interrupted`. */
export type ToolCall = (typeof EVENT_PAYLOAD_SCHEMAS)["tool.call"]["_output"];

/** A `tool.call` the turn's completions carried: the derived disposition's scan unit (S2). */
export type TurnToolCall = { name: string; args: Record<string, unknown> };

/** The last fact of the log: the trigger and payload the agent-loop rules read (RUNTIME section 5.1). */
export type LastFact = { readonly type: string; readonly payload: unknown };

/** A `human.requested` payload, keyed by waitId while it has no `human.responded`. */
export type Wait = (typeof EVENT_PAYLOAD_SCHEMAS)["human.requested"]["_output"];

/** The gated call an `approve` wait holds, from the request's `approval` payload (T3). */
export type ApprovalHold = NonNullable<Wait["approval"]>;

/** An input a turn has not consumed yet: `message.received`, `delegation.result` or `human.responded`. */
export type PendingInput = { readonly type: string; readonly payload: unknown };

/** A delegation this run has made that has not resolved: the reservation it holds, and its child. */
export type AgentDelegation = {
  /** The parent's `tool.call` id. */
  callId: string;
  /** The child run's id once the background ack named it; null while the parent's call is open. */
  childRunId: string | null;
  /** The budget reserved from this run for the child (RUNTIME section 7). */
  reservedUsd: number;
};

/** Exactly the AgentState of RUNTIME section 5.1. */
export type AgentState = {
  status: "idle" | "running" | "waiting" | "blocked" | "finished" | "stopped";
  def: Definition;
  turn: number;
  pendingInputs: PendingInput[];
  calls: number;
  openToolCalls: Map<string, ToolCall>;
  /** The calls whose latest fact is `tool.queued` (T16): they wait for a
   * workspace sandbox slot, so the stall watchdog stands down (section 7). */
  queuedCalls: string[];
  waits: Map<string, Wait>;
  costUsd: number;
  /** Cost of the `llm.completed`s of the current turn; reset when a turn starts (section 5.1 rule 1). */
  turnCostUsd: number;
  reservedUsd: number;
  /** The run's open delegations: the reservation each child holds (section 5.2, section 7). */
  delegations: AgentDelegation[];
  compactedUpTo: number;
  cancelRequested: boolean;
  /** The last fact, typed and upcasted — the agent loop's rules read their trigger and payload from it. */
  lastFact: LastFact | null;
  /** Attempts made on the current call: bumped by `ll.failed`, reset by `ll.requested` (section 5.1 rule 5). */
  callAttempt: number;
  /** The seq of the last event the fold saw, any class — the stream head the
   * stall watchdog arms and re-checks against (section 7). */
  head: number;
  /** The session this stream hosts, from `session.created`; null for runs and logs without one (S2). */
  session: { agentId: string; incognito: boolean } | null;
  /** True while a disposition stands for the turn; reset when a turn starts (S2). */
  turnDisposition: boolean;
  /** Every tool call the turn's completions carried, in order — the derived disposition's scan set (S2). */
  turnToolCalls: TurnToolCall[];
  /** The session's approval mode (PRODUCT §8.3): the latest `session.approval_mode_set`, else `ask` (T3). */
  approvalMode: ApprovalMode;
  /** Open approval waits by waitId: the call each holds until it resolves (approve/deny/expiry, T3). */
  approvals: Record<string, ApprovalHold>;
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
const INPUT_TYPES = ["message.received", "delegation.result", "human.responded", "proposal.decided"] as const;

function seqOf(event: unknown): number {
  const seq = (event as { seq?: unknown } | null | undefined)?.seq;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) {
    throw new FoldError(`event seq must be a positive integer, got ${String(seq)}`);
  }
  return seq;
}

/** The `result` of a completion, when it is a record — the delegation carrier's keys live there. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
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
  let delegations: AgentDelegation[] = (init.delegations ?? []).map((delegation) => ({ ...delegation }));
  let compactedUpTo = init.compactedUpTo ?? 0;
  let cancelRequested = init.cancelRequested ?? false;
  let lastFact: LastFact | null = init.lastFact ?? null;
  let callAttempt = init.callAttempt ?? 0;
  let session = init.session ?? null;
  let turnDisposition = init.turnDisposition ?? false;
  let turnToolCalls: TurnToolCall[] = (init.turnToolCalls ?? []).map((call) => ({ ...call }));
  let approvalMode: ApprovalMode = init.approvalMode ?? DEFAULT_APPROVAL_MODE;
  let approvals: Record<string, ApprovalHold> = { ...(init.approvals ?? {}) };
  let pendingInputs: PendingInput[] = (init.pendingInputs ?? []).map((input) => ({ ...input }));
  const openToolCalls = new Map(init.openToolCalls);
  let queuedCalls: string[] = [...(init.queuedCalls ?? [])];
  const waits = new Map(init.waits);

  // Terminal is sticky (R2.9): once set, from the init or a run.* fact, no later fact moves it.
  let terminal =
    init.status !== undefined && init.status in RUN_CLOSED ? (init.status as AgentState["status"]) : null;

  let inTurn = false;
  let started = false;
  let head = init.head ?? 0; // the watchdog's progress token: the last seq seen, any class
  let prevFactType: string | null = null; // the fact before this one: tells a retry from a turn start

  const ordered = inSeqOrder(events);
  for (const raw of ordered) {
    const type = (raw as { type?: unknown }).type;
    if (typeof type !== "string" || !isFact(type)) continue; // telemetry: only the UI reads it
    head = seqOf(raw);
    const event = parseEvent(raw);

    // The disposition never becomes the loop's last fact: the rules read the
    // completion / tool result the turn acted on (S2).
    if (event.type !== "disposition.recorded") {
      lastFact = { type: event.type, payload: event.payload };
    }
    switch (event.type) {
      case "run.created":
        // The definition snapshot freezes the run's shape (section 2); it never changes after.
        def = { ...event.payload.definition };
        break;
      case "run.started":
        started = true;
        break;
      case "session.created":
        // The session's opening fact: whose agent it hosts, and whether it leaves a trace (S2).
        session = { agentId: event.payload.agentId, incognito: event.payload.incognito };
        break;
      case "session.approval_mode_set":
        // The mode applies from the next decision on; open waits are never retro-approved (T3).
        approvalMode = event.payload.mode;
        break;
      case "message.received":
      case "human.responded":
      case "proposal.decided": {
        // An approval answer is consumed by the approval rules off `lastFact` (T3); only
        // inputs a later turn must see park here.
        const wait = event.type === "human.responded" ? waits.get(event.payload.waitId) : undefined;
        if (wait?.approval === undefined) {
          pendingInputs = [...pendingInputs, { type: event.type, payload: event.payload }];
        }
        if (event.type === "human.responded") waits.delete(event.payload.waitId);
        break;
      }
      case "delegation.result": {
        // A pending input for the parent's loop (section 5.1); the child's spend lands here and
        // the reservation its background ack held is released (section 7).
        pendingInputs = [...pendingInputs, { type: event.type, payload: event.payload }];
        costUsd += event.payload.costUsd;
        const index = delegations.findIndex((record) => record.childRunId === event.payload.childRunId);
        if (index !== -1) {
          reservedUsd -= delegations[index].reservedUsd;
          delegations = delegations.filter((_, at) => at !== index);
        }
        break;
      }
      case "llm.requested": {
        // A retry re-asks the call that just failed: same callNo, same turn, attempt kept
        // (section 5.1 rule 5). Anything else is a fresh call -- and call 1 starts a turn.
        const retry = prevFactType === "llm.failed";
        if (!retry) callAttempt = 0;
        if (event.payload.callNo === 1 && !retry) {
          turn += 1;
          calls = 0;
          turnCostUsd = 0; // the per-turn meter restarts with the turn (section 5.1 rule 1)
          turnDisposition = false; // a fresh turn owes its own disposition (S2)
          turnToolCalls = [];
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
        // The disposition's scan set: every call the completion carried, named (S2).
        for (const call of event.payload.toolCalls) {
          const record = (call ?? {}) as Record<string, unknown>;
          if (typeof record.name === "string") {
            turnToolCalls = [...turnToolCalls, { name: record.name, args: asRecord(record.args) ?? {} }];
          }
        }
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
      case "tool.call": {
        // Legacy rows may lack callId; the event id keys them so they stay visible.
        openToolCalls.set(event.payload.callId ?? event.id, event.payload);
        inTurn = true; // real work in flight: the turn's tool phase is open again (S2)
        if (event.payload.tool === "delegate") {
          // A delegation reserves its budget from this run (section 7); the ledger carries it until
          // the resolve, and lets cancellation reach the child (section 5.1 rule 1).
          const requested = (event.payload.args ?? {}) as Record<string, unknown>;
          const reserved = typeof requested.budgetUsd === "number" ? requested.budgetUsd : 0;
          reservedUsd += reserved;
          delegations = [
            ...delegations,
            { callId: event.payload.callId ?? event.id, childRunId: null, reservedUsd: reserved },
          ];
        }
        break;
      }
      case "tool.queued":
        // T16: the call waits for a workspace sandbox slot; the wait is a fact.
        if (!queuedCalls.includes(event.payload.callId)) {
          queuedCalls = [...queuedCalls, event.payload.callId];
        }
        break;
      case "tool.dequeued":
        // The slot granted: the call is in flight again, not waiting.
        queuedCalls = queuedCalls.filter((callId) => callId !== event.payload.callId);
        break;
      case "tool.completed":
      case "tool.interrupted": {
        openToolCalls.delete(event.payload.callId);
        queuedCalls = queuedCalls.filter((callId) => callId !== event.payload.callId);
        // A held approval resolves with its call's completion: the record and, when the
        // expiry swept it, the wait itself go with it (T3).
        for (const [waitId, approval] of Object.entries(approvals)) {
          if (approval.callId === event.payload.callId) {
            delete approvals[waitId];
            waits.delete(waitId);
          }
        }
        const index = delegations.findIndex((record) => record.callId === event.payload.callId);
        if (index !== -1) {
          const record = delegations[index];
          const result = asRecord((event.payload as { result?: unknown }).result);
          const named = typeof result?.runId === "string" ? result.runId : null;
          if (named === null) {
            // Await resolve, or a failed call: the reservation returns and the child's spend lands
            // (the await completion carries it as result.costUsd, section 5.2).
            reservedUsd -= record.reservedUsd;
            delegations = delegations.filter((_, at) => at !== index);
            const spent = result && typeof result.costUsd === "number" ? result.costUsd : null;
            if (spent !== null) costUsd += spent;
          } else {
            // The background ack: the child is running on, the reservation stays until its result.
            delegations[index] = { ...record, childRunId: named };
          }
        }
        break;
      }
      case "human.requested": {
        waits.set(event.payload.waitId, event.payload);
        if (event.payload.approval !== undefined) {
          approvals[event.payload.waitId] = event.payload.approval;
        }
        break;
      }
      case "run.cancel_requested":
        cancelRequested = true;
        break;
      case "disposition.recorded":
        // The disposition stands for the turn; the agent loop's last fact is untouched
        // (it still reads the completion / tool result), and the tool phase closes
        // unless later work re-opens it (S2).
        turnDisposition = true;
        inTurn = false;
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
    queuedCalls,
    waits,
    costUsd,
    turnCostUsd,
    reservedUsd,
    delegations,
    compactedUpTo,
    cancelRequested,
    lastFact,
    callAttempt,
    head,
    session,
    turnDisposition,
    turnToolCalls,
    approvalMode,
    approvals,
  };
}
