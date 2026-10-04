export type AgentStatus = "existing" | "new";

export type Disposition =
  | "handle_directly"
  | "delegate_agent"
  | "delegate_team"
  | "propose_team"
  | "propose_specialist"
  | "clarify";

export interface RosterEntry {
  agentId: string;
  name: string;
  status: AgentStatus;
}

export interface TeamProposal {
  kind: "team";
  name: string;
  purpose: string;
  roster: RosterEntry[];
}

export interface SpecialistProposal {
  kind: "specialist";
  name: string;
  purpose: string;
  rows: { label: string; value: string; why: string }[];
}

export type Proposal = TeamProposal | SpecialistProposal;
export type ProposalDecision = "approved" | "declined" | "discuss";

export interface HandoffPayload {
  runId: string;
  teamName: string;
  summary: string;
  members: { name: string; state: string }[];
}

// ---- Work: projects hold tasks; a task's runs are its loops ----

/**
 * One goal, owned by one team, inside one project: a card on the Work board.
 * Each run of it is a loop (UI word). A re-run after a stop is a new loop on the same task;
 * the reviewer's bounces stay inside one loop (its rework budget).
 */
export interface Task {
  id: string;
  projectId: string;
  teamId: string;
  title: string;
  /** Loop ids, oldest first. Empty while the task is only proposed. */
  runIds: string[];
  /** Set while Dana's proposal waits for your yes (the Weave item that decides it). */
  proposal?: { itemId: string; at: string; note: string; purpose: string };
  /** Nothing behind it can play yet (no recording): always labelled. */
  preview?: boolean;
}

/** What crossed the delegation boundary into a loop, and what stayed with Dana (CONCEPT §6). */
export interface Brief {
  tokens: number;
  objective: string;
  constraints: string[];
  /** Completion criteria. Dana starts from the team's and narrows them to the task. */
  criteria: string[];
  /** Picked per loop from each specialist's USER.md. */
  preferences: string[];
  stayed: string[];
}

// ---- Run events (append-only; the only thing the loop view reads) ----
export type RunEventType =
  | "run.started"
  | "step.started"
  | "step.finished"
  | "agent.message"
  | "tool.call"
  | "tool.result"
  | "tool.denied"
  | "context.snapshot"
  | "handoff"
  | "review.verdict"
  | "rework.requested"
  | "criterion.checked"
  | "budget.update"
  | "artifact.created"
  | "run.blocked"
  | "run.stopped"
  | "run.finished";

export interface RunEvent {
  runId: string;
  seq: number;
  /** seconds from run start (recorded timeline) */
  t: number;
  type: RunEventType;
  actorAgentId?: string;
  payload: Record<string, unknown>;
}

/**
 * work = doing a step · rework = redoing it after a bounce · bounce = the reviewer sent it back ·
 * wait = waiting on you · blocked = waiting on a teammate's step
 */
export type SegmentKind = "work" | "rework" | "bounce" | "wait" | "blocked";
export interface RunSegment {
  agentId: string;
  label: string;
  /** The team workflow step this belongs to. */
  stage: string;
  start: number;
  end: number;
  kind: SegmentKind;
}

/** running · blocked (stopped on a budget; needs you) · accepted · stopped (by you) */
export type RunStatus = "running" | "blocked" | "accepted" | "stopped";

/** One loop of a task. Times are seconds from `startedAt`. */
export interface Run {
  id: string;
  taskId: string;
  teamId: string;
  /** Loop number within the task, from 1. */
  n: number;
  objective: string;
  status: RunStatus;
  startedAt: string;
  /** A real run recorded earlier and played back. Always badged. */
  recorded: boolean;
  /** Finished loops: total length. Running loops: where "now" is. */
  durationS: number;
  /** Running loops only: expected length. */
  etaS?: number;
  /** Spend so far (at the end, or at "now"). */
  costUsd: number;
  budget: { costUsd: number; timeS: number };
  reworkBudget: number;
  /** Dana's own base context, for comparison with each specialist's. */
  assistantTokens: number;
  brief: Brief;
  segments: RunSegment[];
  /** How a finished loop ended, in a sentence. */
  outcome?: string;
  reportId?: string;
}

export interface ContextSection {
  label: string;
  source: string;
  tokens: number;
}
export type ToolPolicy = "allowed" | "approval" | "blocked";
export interface ContextSnapshot {
  id: string;
  runId: string;
  agentId: string;
  step: string;
  assembledAtS: number;
  sections: ContextSection[];
  totalTokens: number;
  tools: { name: string; policy: ToolPolicy }[];
  lastDenied?: string;
  notLoaded: string;
  note: string;
}

export interface Report {
  id: string;
  runId: string;
  title: string;
  intro: string;
  summary: string;
  results: { config: string; ppl: number; delta: string; valid: boolean }[];
  caveats: string[];
  provenance: { label: string; value: string }[];
  /** Persona ids. */
  madeBy: string[];
  artifacts: { name: string; from: string }[];
  emailed: boolean;
}
