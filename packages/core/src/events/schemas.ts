// Payload schemas, one per RUNTIME §3 event type, and the fact/telemetry class table.
//
// Existing types keep their names and payloads so the web's read model keeps working (§3
// intro): on those types, the fields recorded logs predate are `optional`. New types carry
// what the runtime needs to resume, and every object is strict — an event that carries more
// than its schema says is a bug, not extra data (content stays out of the log, LEARNING §10.4).
import { z } from "zod";

/** What the fold reads (`fact`) vs what only the UI reads (`telemetry`) — RUNTIME §2. */
export type EventClass = "fact" | "telemetry";

/** Where a message can arrive from and be delivered to (RUNTIME §3). */
const surface = z.enum(["app", "channel"]);

/** The effect class every tool declares (RUNTIME §6); retried `tool.exec` branches on it. */
const effect = z.enum(["read", "idempotent", "rerunnable", "once"]);

/** Team workflow segment kinds (unchanged from `@fabric/contracts`). */
const stepKind = z.enum(["work", "rework", "bounce", "wait", "blocked"]);

const stepOutcome = z.enum(["done", "timed_out", "failed", "cancelled"]);

export const EVENT_PAYLOAD_SCHEMAS = {
  // -- facts ----------------------------------------------------------------

  /** API / `delegate` / schedule fire. The definition snapshot freezes the run's shape. */
  "run.created": z.strictObject({
    definition: z.record(z.string(), z.unknown()),
    engineVersion: z.string(),
    brief: z.string(),
    grants: z.unknown(),
    budgets: z.record(z.string(), z.unknown()),
    /** Present for delegated runs; null when the API or a schedule created the run. */
    parent: z
      .strictObject({ runId: z.string().optional(), sessionId: z.string().optional(), callId: z.string() })
      .nullable(),
  }),
  "run.started": z.strictObject({ objective: z.string() }),
  "message.received": z.strictObject({
    text: z.string(),
    attachments: z.array(z.unknown()),
    surface,
    sender: z.string(),
    platformMessageId: z.string(),
  }),
  "disposition.recorded": z.strictObject({
    kind: z.enum(["direct", "agent", "team", "propose", "clarify"]),
    /** The routed-to agent/team/clarifier; null for a direct answer. */
    target: z.string().nullable(),
    reason: z.string(),
  }),
  "step.started": z.strictObject({
    label: z.string(),
    stage: z.string(),
    kind: stepKind,
    stepKey: z.string().optional(),
    pass: z.union([z.literal(1), z.literal(2)]).optional(),
    childRunId: z.string().optional(),
  }),
  "llm.requested": z.strictObject({
    turn: z.number().int(),
    callNo: z.number().int(),
    model: z.string(),
    params: z.record(z.string(), z.unknown()),
    /** The context snapshot row written before the call; null when the call runs bare. */
    snapshotId: z.string().nullable(),
  }),
  "llm.completed": z.strictObject({
    turn: z.number().int(),
    callNo: z.number().int(),
    text: z.string(),
    toolCalls: z.array(z.record(z.string(), z.unknown())),
    usage: z.strictObject({ inputTokens: z.number().int(), outputTokens: z.number().int(), costUsd: z.number() }),
    finishReason: z.string(),
    model: z.string(),
  }),
  "llm.failed": z.strictObject({
    turn: z.number().int(),
    callNo: z.number().int(),
    error: z.string(),
    retryable: z.boolean(),
  }),
  "context.compacted": z.strictObject({ upToSeq: z.number().int(), summary: z.string() }),
  "tool.call": z.strictObject({
    tool: z.string(),
    summary: z.string(),
    callId: z.string().optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    /** Declared before `tool.exec` runs, so a crash leaves the attempt on the log (§6). */
    effect: effect.optional(),
  }),
  "tool.completed": z.strictObject({
    callId: z.string(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    resultRef: z.string().optional(),
    error: z.string().optional(),
  }),
  "tool.interrupted": z.strictObject({ callId: z.string(), effect, note: z.string() }),
  "tool.denied": z.strictObject({
    tool: z.string(),
    target: z.string(),
    reason: z.string(),
    callId: z.string().optional(),
  }),
  "delegation.result": z.strictObject({
    childRunId: z.string(),
    outcome: z.string(),
    summary: z.string(),
    output: z.unknown().optional(),
    artifacts: z.array(z.unknown()).optional(),
    costUsd: z.number(),
  }),
  "step.finished": z.strictObject({
    label: z.string(),
    stage: z.string(),
    kind: stepKind,
    stepKey: z.string().optional(),
    outcome: stepOutcome.optional(),
  }),
  "review.verdict": z.strictObject({ verdict: z.enum(["accept", "request_changes"]), text: z.string() }),
  /** `index` is into `run.brief.criteria`. */
  "criterion.checked": z.strictObject({ index: z.number().int(), pass: z.boolean(), note: z.string() }),
  "rework.requested": z.strictObject({ to: z.string(), used: z.number().int(), budget: z.number().int() }),
  "human.requested": z.strictObject({
    waitId: z.string(),
    kind: z.enum(["confirm", "approve", "answer"]),
    gated: z.boolean(),
    prompt: z.string(),
    /** Epoch ms; null when the wait has no deadline. */
    deadline: z.number().nullable(),
  }),
  "human.responded": z.strictObject({ waitId: z.string(), decision: z.string(), by: z.string(), surface }),
  /** The text lives outside the log, referenced, so it can be erased (LEARNING §10.4). */
  "memory.written": z.strictObject({
    scope: z.string(),
    itemId: z.string(),
    op: z.enum(["add", "update", "forget"]),
    contentRef: z.string(),
  }),
  "skill.written": z.strictObject({
    skillId: z.string(),
    version: z.number().int(),
    op: z.enum(["create", "patch"]),
    contentRef: z.string(),
    scope: z.string(),
    origin: z.string(),
    source: z.string(),
  }),
  "skill.used": z.strictObject({
    skillId: z.string(),
    version: z.number().int(),
    stream: z.string(),
    outcome: z.string(),
    revises: z.string().optional(),
  }),
  "skill.state_changed": z.strictObject({
    skillId: z.string(),
    from: z.string(),
    to: z.string(),
    reason: z.string(),
    strength: z.number(),
  }),
  "learning.completed": z.strictObject({
    sourceStream: z.string(),
    upToSeq: z.number().int(),
    written: z.number().int(),
    skipped: z.number().int(),
    costUsd: z.number(),
  }),
  "content.erased": z.strictObject({ contentRef: z.string(), reason: z.string(), by: z.string() }),
  "feedback.given": z.strictObject({
    targetEventId: z.string(),
    kind: z.enum(["up", "down", "edit"]),
    diffRef: z.string().optional(),
  }),
  "proposal.created": z.strictObject({ kind: z.string(), definition: z.unknown().optional() }),
  "proposal.decided": z.strictObject({ kind: z.string(), decision: z.string(), by: z.string() }),
  "run.cancel_requested": z.strictObject({ by: z.string() }),
  "run.blocked": z.strictObject({ reason: z.string(), itemId: z.string().optional() }),
  "run.stopped": z.strictObject({ by: z.string(), text: z.string() }),
  "run.finished": z.strictObject({
    reportId: z.string().optional(),
    result: z.unknown().optional(),
    costUsd: z.number().optional(),
  }),
  "artifact.created": z.strictObject({ name: z.string(), artifactId: z.string().optional() }),

  // -- telemetry (the fold skips these) --------------------------------------

  "context.snapshot": z.strictObject({ snapshotId: z.string() }),
  "tool.result": z.strictObject({ line: z.string(), kind: z.literal("term") }),
  "agent.message": z.strictObject({ text: z.string() }),
  "run.progress": z.strictObject({ text: z.string(), milestone: z.string() }),
  "budget.update": z.strictObject({
    reworkUsed: z.number().int().optional(),
    reworkBudget: z.number().int().optional(),
    costUsd: z.number().optional(),
  }),
  "message.delivered": z.strictObject({ eventId: z.string(), target: z.string(), platformMessageId: z.string().nullable() }),
  handoff: z.strictObject({ to: z.string(), step: z.string().optional() }),
} as const;

export type EventType = keyof typeof EVENT_PAYLOAD_SCHEMAS;

/** The §3 class of every event type, next to the schemas so the two cannot drift. */
export const EVENT_CLASSES: Record<EventType, EventClass> = {
  "run.created": "fact",
  "run.started": "fact",
  "message.received": "fact",
  "disposition.recorded": "fact",
  "step.started": "fact",
  "llm.requested": "fact",
  "llm.completed": "fact",
  "llm.failed": "fact",
  "context.compacted": "fact",
  "tool.call": "fact",
  "tool.completed": "fact",
  "tool.interrupted": "fact",
  "tool.denied": "fact",
  "delegation.result": "fact",
  "step.finished": "fact",
  "review.verdict": "fact",
  "criterion.checked": "fact",
  "rework.requested": "fact",
  "human.requested": "fact",
  "human.responded": "fact",
  "memory.written": "fact",
  "skill.written": "fact",
  "skill.used": "fact",
  "skill.state_changed": "fact",
  "learning.completed": "fact",
  "content.erased": "fact",
  "feedback.given": "fact",
  "proposal.created": "fact",
  "proposal.decided": "fact",
  "run.cancel_requested": "fact",
  "run.blocked": "fact",
  "run.stopped": "fact",
  "run.finished": "fact",
  "artifact.created": "fact",
  "context.snapshot": "telemetry",
  "tool.result": "telemetry",
  "agent.message": "telemetry",
  "run.progress": "telemetry",
  "budget.update": "telemetry",
  "message.delivered": "telemetry",
  handoff: "telemetry",
};

/** True when the fold reads this event type; unknown types are not facts. */
export function isFact(type: string): boolean {
  return EVENT_CLASSES[type as EventType] === "fact";
}

/** The declared class of a known type; undefined for unknown types. */
export function eventClass(type: string): EventClass | undefined {
  return EVENT_CLASSES[type as EventType];
}
