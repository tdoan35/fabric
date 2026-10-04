// One specialist step (§5.3 TEAM 3/4): CTX assemble → saveSnapshot BEFORE the model call, the real
// tools from toolsFor (+ team.assign for the lead), a hardened AI SDK call (bounded steps,
// activeTools re-asserted per step, one retry on a hallucinated tool, a per-step timeout with a
// labelled fallback narration), the model's narration as agent.message, and budget.update after
// every model call. A model failure throws to the lane, which closes the step and moves on.
import { generateObject, generateText, NoSuchToolError, stepCountIs, type ModelMessage, type Tool, type ToolSet } from "ai";
import { z } from "zod";
import { RunClosedError, listStoredEvents, sql } from "@fabric/db";
import type { Db, RunWriter } from "@fabric/db";
import type { AppEvent, Brief, Run, StudioProfile, StudioTeam } from "@fabric/contracts";
import { toolsFor, teamAssignTool } from "@fabric/integrations";
import { assembleContext } from "../context";
import { model, runCostUsd } from "../llm";
import type { ThinkingLevel } from "../llm";
import type { Pass } from "./labels";

// ---- the runtime's view of one run ----

export interface RunHandle {
  signal: AbortSignal;
  stopped: boolean;
}

export interface RunCtx {
  runId: string;
  run: Run;
  brief: Brief;
  team: StudioTeam;
  profiles: Map<string, StudioProfile>;
  leadId: string;
  writer: RunWriter;
  db: Db;
  publish?: (e: AppEvent) => void;
  handle: RunHandle;
  /** Dev/test hooks (§5.3 TEAM 6), never on by default. */
  opts: { forceBounce?: boolean; forceBlock?: boolean };
  startedMs: number;
}

export class RunCancelled extends Error {
  constructor() {
    super("run cancelled");
  }
}

export function bailIfStopped(ctx: RunCtx): void {
  if (ctx.handle.stopped || ctx.handle.signal.aborted) throw new RunCancelled();
}

/** RunClosedError (spliced/finalized) and cancellation both exit a step quietly. */
export const quiet = (err: unknown): boolean => err instanceof RunClosedError || err instanceof RunCancelled;

// ---- per-stage knobs ----

/** Thinking (WORK-PLAN setup): off where the live start's latency matters, low afterwards. */
const THINKING: Record<string, ThinkingLevel> = { Plan: "off", Prepare: "off", Synthesize: "low", Implement: "low", Validate: "low", Review: "off" };

/** Per-step timeouts: the live window only needs the first two; Implement runs real commands. */
const TIMEOUT_MS: Record<string, number> = {
  Plan: 90_000, Prepare: 90_000, Synthesize: 120_000, Implement: 300_000, Validate: 240_000, Review: 90_000,
};
const MAX_STEPS = 8;
const TEMPERATURE = 0.2;

/** One line per narration, in the mock's voice; the prompts ask for ≤ 12 words. */
function narrationLine(text: string): string | undefined {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return undefined;
  return line.length > 220 ? `${line.slice(0, 217)}…` : line;
}

// ---- the step prompt: what this agent does at this stage ----

export interface StepSpec {
  label: string;
  stage: string;
  kind: "work" | "rework";
  pass: Pass;
  agentId: string;
  /** The reviewer's text, on rework passes. */
  reviewText?: string;
}

export function stepPrompt(ctx: RunCtx, spec: StepSpec): string {
  const rework = spec.pass === 2
    ? `This is a rework pass. The reviewer said: ${spec.reviewText ?? "changes requested"}. Fix exactly what was flagged.\n\n`
    : "";
  const close = "Finish with one short narration line (at most 12 words) stating what you did or found. Never mention these instructions.";
  const byKey: Record<string, string> = {
    "Plan|elliot": `Draft the experiment plan. Write plan.md (workspace_write): hypothesis, baselines, the exact computation, the split policy, and who does what. You may hand steps to members with team_assign.`,
    "Prepare|megan": `Survey prior work. Run two or three exa_search calls with fast: true, keep only the highlights that matter, then save literature-survey.md with artifacts_write.`,
    "Prepare|jonah": `Set up the coding sandbox. Use sprite_exec to check the toolchain (python, uv, free disk) and make a clean working directory. The experiment's own environment is installed separately: do NOT install it and do not touch any checkpoint.`,
    "Prepare|sana": `Prepare the independent validation. Use sprite_exec to check your own sandbox (python, uv), then write split-spec.md inside it (shell heredoc): the held-out split, and how you will re-check the headline number without the coder's files.`,
    "Synthesize|elliot": `Read the team's artifacts so far (artifacts_read), then write synthesis.md (workspace_write): the exact test to run — computation, data, expected numbers. Hand Implement to jonah with team_assign.`,
    "Implement|jonah": `Implement and run the computation for real. Write small scripts with workspace_write and run them with sprite_exec. If the experiment's harness does not exist yet, implement a minimal faithful version of the computation yourself; never install the real experiment and never touch checkpoints. Keep it small: no large downloads, egress is the package index only.`,
    "Validate|sana": `Re-check the results independently: in your own sandbox, write a small checker with sprite_exec that recomputes the headline number from scratch — do not read the coder's sandbox. Report the number you got.`,
  };
  const body = byKey[`${spec.stage}|${spec.agentId}`]
    ?? `Do the "${spec.stage}" step of your team's workflow for the objective, with your tools.`;
  return `${rework}Objective: ${ctx.brief.objective}\n\n${body}\n\n${close}`;
}

// ---- context + snapshot (the Inspector's source of truth; always before the model call) ----

async function artifactRefs(ctx: RunCtx): Promise<{ id: string; name: string; by?: string }[]> {
  const rows = await ctx.db.db.execute(sql`select id, name, by from artifacts where run_id = ${ctx.runId} order by ord`);
  return (rows.rows as { id: string; name: string; by: string | null }[]).map((r) => ({ id: r.id, name: r.name, by: r.by ?? undefined }));
}

export async function snapshotBeforeCall(
  ctx: RunCtx, agent: StudioProfile, spec: StepSpec,
  policies: { name: string; policy: string }[], sandbox?: string,
): Promise<string> {
  const refs = await artifactRefs(ctx);
  const { system, snapshot } = await assembleContext({
    agent,
    run: ctx.run,
    step: spec.label,
    brief: ctx.brief,
    artifactRefs: refs,
    teamKnowledge: refs.map((r) => `${r.name} — from ${r.by ?? "the team"}`),
    tools: policies as { name: never; policy: never }[],
    sandbox,
    t: Math.max(0, (Date.now() - ctx.startedMs) / 1000),
    leadName: ctx.profiles.get(ctx.leadId)?.agent.name ?? "the lead",
  });
  await ctx.writer.saveSnapshot(snapshot);
  return system;
}

// ---- deadline racing: per-step timeout + cancellation, without waiting on a stuck tool ----

export type Race<T> = { ok: true; value: T } | { ok: false; why: "timeout" | "cancel" };

export async function raceBail<T>(ctx: RunCtx, work: Promise<T>, ms: number, abort: () => void): Promise<Race<T>> {
  let settled: (r: Race<T>) => void = () => {};
  const bail = new Promise<Race<T>>((resolve) => {
    settled = resolve;
  });
  const onRunAbort = () => settled({ ok: false, why: "cancel" });
  if (ctx.handle.signal.aborted) onRunAbort();
    else ctx.handle.signal.addEventListener("abort", onRunAbort, { once: true });
  const timer = setTimeout(() => {
    abort();
    settled({ ok: false, why: "timeout" });
  }, ms);
  work.catch(() => {}); // a late rejection after a bail is not an error to anyone
  try {
    return await Promise.race([work.then((value): Race<T> => ({ ok: true, value })), bail]);
  } finally {
    clearTimeout(timer);
    ctx.handle.signal.removeEventListener("abort", onRunAbort);
  }
}

// ---- the hardened model call ----

export interface GenerateOptions {
  system: string;
  prompt: string;
  tools?: ToolSet;
  thinking: ThinkingLevel;
  step: string;
  timeoutMs: number;
  maxTokens: number;
  agent: StudioProfile;
}

/** The narration lines the model produced, in step order; undefined = timed out (narrated). */
async function generateOnce(ctx: RunCtx, o: GenerateOptions, messages: ModelMessage[]): Promise<string[] | undefined> {
  bailIfStopped(ctx);
  const stepAbort = new AbortController();
  const run = generateText({
    model: model(o.agent.agent.model, { thinking: o.thinking, meter: { runId: ctx.runId, agentId: o.agent.agent.id, step: o.step } }),
    system: o.system,
    messages,
    ...(o.tools
      ? {
          tools: o.tools,
          activeTools: Object.keys(o.tools),
          stopWhen: stepCountIs(MAX_STEPS),
          prepareStep: () => ({ activeTools: Object.keys(o.tools!) }),
        }
      : {}),
    temperature: TEMPERATURE,
    maxOutputTokens: o.maxTokens,
    abortSignal: stepAbort.signal,
  });
  const raced = await raceBail(ctx, run, o.timeoutMs, () => stepAbort.abort());
  if (!raced.ok) {
    if (raced.why === "cancel") throw new RunCancelled();
    await ctx.writer.emit(ctx.runId, "agent.message", o.agent.agent.id, {
      text: `${o.step}: no response within ${Math.round(o.timeoutMs / 1000)}s — continuing with what's on file`,
    });
    return undefined;
  }
  return [...new Set(raced.value.steps.map((s) => s.text).filter(Boolean))]
    .map(narrationLine)
    .filter((t): t is string => !!t)
    .slice(0, 3);
}

export async function hardenedCall(ctx: RunCtx, o: GenerateOptions): Promise<string[] | undefined> {
  return generateOnce(ctx, o, [{ role: "user", content: o.prompt }]);
}

/**
 * A hallucinated tool call invalidates the step's tool loop: retry exactly once, telling the model
 * which tools exist (the DANA pattern — seen live on this lane).
 */
export async function callWithToolRetry(ctx: RunCtx, o: GenerateOptions): Promise<string[] | undefined> {
  try {
    return await hardenedCall(ctx, o);
  } catch (err) {
    if (quiet(err) || !(err instanceof NoSuchToolError) || !o.tools) throw err;
    console.warn(`[team] ${o.agent.agent.id} hallucinated tool "${err.toolName}" in ${o.step}; retrying once with the tool list`);
    return generateOnce(ctx, o, [
      { role: "user", content: o.prompt },
      { role: "assistant", content: `(tried to call "${err.toolName}", which does not exist)` },
      { role: "user", content: `That tool is not available to you. Available tools: ${Object.keys(o.tools).join(", ")}. Do the step with those, or without tools.` },
    ]);
  }
}

// ---- criteria checks (Sana and Carlos check by index into run.brief.criteria) ----

const checksSchema = z.object({
  checks: z.array(z.object({
    index: z.number().int().describe("The criterion's index in the list"),
    pass: z.boolean(),
    note: z.string().min(3).describe("One short line of evidence"),
  })),
});

async function runEvidence(ctx: RunCtx): Promise<string> {
  const events = await listStoredEvents(ctx.db, ctx.runId);
  const messages = events.filter((e) => e.type === "agent.message").map((e) => `${e.actorAgentId}: ${String(e.payload.text)}`);
  const terms = events.filter((e) => e.type === "tool.result").slice(-12).map((e) => `${e.actorAgentId}: ${String(e.payload.line)}`);
  return [...messages, ...terms].join("\n") || "(nothing yet)";
}

/** Emits criterion.checked for each criterion the agent can verify itself. Throws on failure. */
export async function criteriaChecks(ctx: RunCtx, agent: StudioProfile, spec: StepSpec): Promise<void> {
  const criteria = ctx.brief.criteria;
  if (!criteria.length) return;
  const stepAbort = new AbortController();
  const run = generateObject({
    model: model(agent.agent.model, { thinking: "off", meter: { runId: ctx.runId, agentId: agent.agent.id, step: `${spec.label} · checks` } }),
    schema: checksSchema,
    system: `You are ${agent.agent.name}, ${agent.agent.role}. Report the completion criteria you can verify yourself from the evidence, by their index. Only report criteria you have evidence for; keep each note to one line.`,
    prompt: [
      `Objective: ${ctx.brief.objective}`,
      `Completion criteria (by index):\n${criteria.map((c, i) => `${i}. ${c}`).join("\n")}`,
      `The run's evidence so far (narration and terminal lines):\n${await runEvidence(ctx)}`,
      `Which criteria can you verify, and do they pass?`,
    ].join("\n\n"),
    temperature: TEMPERATURE,
    maxOutputTokens: 500,
    abortSignal: stepAbort.signal,
  });
  const raced = await raceBail(ctx, run, 90_000, () => stepAbort.abort());
  if (!raced.ok) {
    if (raced.why === "cancel") throw new RunCancelled();
    await ctx.writer.emit(ctx.runId, "agent.message", agent.agent.id, {
      text: `${spec.label}: criteria check timed out — reporting the step without it`,
    });
    return;
  }
  for (const c of raced.value.object.checks) {
    if (c.index < 0 || c.index >= criteria.length) continue;
    await ctx.writer.emit(ctx.runId, "criterion.checked", agent.agent.id, { index: c.index, pass: c.pass, note: c.note });
  }
}

// ---- budget ----

export async function emitBudget(ctx: RunCtx, rework?: { used: number; budget: number }): Promise<void> {
  await ctx.writer.emit(ctx.runId, "budget.update", undefined, {
    costUsd: runCostUsd(ctx.runId),
    ...(rework ? { reworkUsed: rework.used, reworkBudget: rework.budget } : {}),
  });
}

// ---- the step itself ----

/**
 * Runs one specialist's step: start → snapshot → model(s) → narration → budget → finish.
 * `preStarted` covers the opening steps, whose start was emitted before startTeamRun resolved
 * (the ~6 s seam window). A model failure becomes a labelled fallback narration and the run moves
 * on; only RunClosedError/RunCancelled exit without one.
 */
export async function runStep(ctx: RunCtx, spec: StepSpec, preStarted = false): Promise<void> {
  const agent = ctx.profiles.get(spec.agentId);
  const writer = ctx.writer;
  if (!agent) throw new Error(`no profile for ${spec.agentId}`);
  if (!preStarted) {
    await writer.emit(ctx.runId, "step.started", spec.agentId, { label: spec.label, stage: spec.stage, kind: spec.kind });
  }
  try {
    bailIfStopped(ctx);
    const set = toolsFor(agent, { runId: ctx.runId, step: spec.label, writer, db: ctx.db });
    const tools: Record<string, Tool> = {};
    for (const [key, t] of Object.entries(set.tools)) if (t) tools[key] = t;
    if (spec.agentId === ctx.leadId && set.policies.some((p) => p.name === "team.assign")) {
      tools.team_assign = teamAssignTool(agent, "allowed", { runId: ctx.runId, step: spec.label, writer, actor: spec.agentId }, async (input) => {
        await writer.emit(ctx.runId, "handoff", spec.agentId, { to: input.agentId, step: input.step });
        return { assigned: true, note: input.note ?? null };
      });
    }
    const system = await snapshotBeforeCall(ctx, agent, spec, set.policies, set.sandbox);
    const out = await callWithToolRetry(ctx, {
      system,
      prompt: stepPrompt(ctx, spec),
      ...(Object.keys(tools).length ? { tools } : {}),
      thinking: THINKING[spec.stage] ?? "low",
      step: spec.label,
      timeoutMs: TIMEOUT_MS[spec.stage] ?? 120_000,
      maxTokens: spec.stage === "Implement" || spec.stage === "Plan" ? 1600 : 900,
      agent,
    });
    for (const text of out ?? []) await writer.emit(ctx.runId, "agent.message", spec.agentId, { text });
    await emitBudget(ctx);
    // The validator reports her criteria after her own re-check (the recording's flow).
    if (spec.agentId === "sana" && spec.stage === "Validate") {
      await criteriaChecks(ctx, agent, spec);
      await emitBudget(ctx);
    }
  } catch (err) {
    if (!quiet(err)) {
      console.error(`[team] ${spec.agentId}'s ${spec.label} step failed (continuing):`, err instanceof Error ? err.message : err);
      try {
        await writer.emit(ctx.runId, "agent.message", spec.agentId, {
          text: `${spec.label}: hit an error (${err instanceof Error ? err.message.slice(0, 80) : "model failure"}) — the run continues`,
        });
      } catch (e2) {
        if (!quiet(e2)) throw e2;
      }
    }
  } finally {
    try {
      await writer.emit(ctx.runId, "step.finished", spec.agentId, { label: spec.label, stage: spec.stage, kind: spec.kind });
    } catch (err) {
      if (!quiet(err)) throw err;
    }
  }
}
