// The team workflow runtime (§5.3 TEAM 1/2/5; S3's fallback: plain async orchestration — no Mastra).
//
// A data-driven run over teams.workflow: stage[0] (Plan) runs ALONGSIDE stage[1] (Prepare) so at
// least 3 members are working within the first 45 s (D11), then the stages up to the gate run in
// order, each stage's members in parallel. The gate (Review) is the reviewer's structured verdict:
// accept → writer.end("accepted") and the server's finalizeRun takes over; request_changes →
// rework.requested → Re-plan → Rework → Re-check → Review again, up to reworkBudget times, then
// run.blocked and writer.end("blocked").
//
// startTeamRun(runId) resolves once the run is UNDERWAY — its opening steps have started — and the
// workflow continues in the background, so Dana's handoff turn doesn't wait for the run. cancelRun
// (splice, D5) aborts in-flight model calls and stops scheduling; an in-flight sprite.exec finishes
// server-side and its events are dropped by the closed-run guard.
import { generateObject } from "ai";
import { z } from "zod";
import type { AppEvent, StudioTeam } from "@fabric/contracts";
import { getRunRow, listStoredEvents, readRegistry, rowToRun, type Db, type RunWriter } from "@fabric/db";
import { toolsFor } from "@fabric/integrations";
import {
  emitBudget, quiet, raceBail, runStep, snapshotBeforeCall,
} from "./steps";
import { model } from "../llm";
import { bounceOutcome, planPasses, stepLabel } from "./labels";
import type { Pass } from "./labels";
import type { RunCtx, StepSpec } from "./steps";


export interface TeamRunOptions {
  /** Dev hook (never on by default): the reviewer requests changes on the first review only. */
  forceBounce?: boolean;
  /** Dev hook: every review requests changes — with reworkBudget 1 that forces run.blocked. */
  forceBlock?: boolean;
}

export interface TeamRuntimeDeps {
  writer: RunWriter;
  db: Db;
  /** AppEvents for the invalidation stream (run.changed after a block; finalize covers the rest). */
  publish?: (e: AppEvent) => void;
}

export interface TeamRuntime {
  /** Runs the loop's team workflow in the background; returns once it has started. */
  startTeamRun(runId: string, opts?: TeamRunOptions): Promise<void>;
  /** Used by splice (D5): aborts in-flight model calls and stops scheduling. */
  cancelRun(runId: string): Promise<void>;
}

type Stage = StudioTeam["workflow"][number];

interface Entry {
  handle: RunHandle;
  done: Promise<void>;
}

/** The abortable control block behind cancelRun. */
interface RunHandle {
  signal: AbortSignal;
  stopped: boolean;
  abort: () => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createTeamRuntime(deps: TeamRuntimeDeps): TeamRuntime {
  const runs = new Map<string, Entry>();
  return {
    async startTeamRun(runId: string, opts: TeamRunOptions = {}) {
      if (runs.has(runId)) return; // already underway in this process
      const controller = new AbortController();
      const handle: RunHandle = { signal: controller.signal, stopped: false, abort: () => controller.abort() };
      let settleUnderway: (err?: unknown) => void = () => {};
      const underway = new Promise<void>((resolve, reject) => {
        settleUnderway = (err) => (err instanceof Error ? reject(err) : resolve());
      });
      const entry: Entry = { handle, done: Promise.resolve() };
      runs.set(runId, entry);
      entry.done = executeWorkflow(deps, runId, opts, handle, settleUnderway)
        .catch((err: unknown) => {
          // Lane failures are already contained in runStep; anything this far is a setup bug. The
          // run stays running on disk, so splice/finalize can still close it.
          if (!quiet(err)) console.error(`[team] run ${runId} failed:`, err);
        })
        .finally(() => {
          if (runs.get(runId) === entry) runs.delete(runId);
        });
      await underway;
    },

    async cancelRun(runId: string) {
      const entry = runs.get(runId);
      if (!entry) return; // not running in this process
      entry.handle.stopped = true;
      entry.handle.abort();
      // Give the lanes a moment to unwind; an in-flight sprite.exec may outlive this (TOOLS).
      await Promise.race([entry.done, sleep(3_000)]);
    },
  };
}

// ---- the workflow ----

async function executeWorkflow(
  deps: TeamRuntimeDeps, runId: string, opts: TeamRunOptions, handle: RunHandle,
  underway: (err?: unknown) => void,
): Promise<void> {
  const { db, writer } = deps;
  const row = await getRunRow(db, runId);
  if (!row) throw new Error(`team: run ${runId} not found`);
  if (row.status !== "running" || row.spliced_from_run_id || row.finalized_at) {
    console.log(`[team] run ${runId} is ${row.status}; nothing to start`);
    return;
  }
  const registry = await readRegistry(db);
  const team = [...registry.teams, ...registry.communityTeams].find((t) => t.id === row.team_id);
  if (!team) throw new Error(`team: no team ${row.team_id} for run ${runId}`);
  const profiles = new Map([...registry.agents, ...registry.communityAgents].map((p) => [p.agent.id, p]));
  const leadId = team.members.find((m) => m.lead)?.agentId ?? team.members[0]?.agentId;
  if (!leadId) throw new Error(`team ${team.id} has no members`);

  const run = rowToRun(row, [], Date.now());
  const ctx: RunCtx = {
    runId, run, brief: run.brief, team, profiles, leadId,
    writer, db, publish: deps.publish,
    handle, opts, startedMs: new Date(row.started_at).getTime(),
  };
  const { opening, mid, rework } = planPasses(team.workflow, leadId);
  const openingLabels = new Set(opening.map((s) => s.label));
  const gateIdx = team.workflow.findIndex((s) => s.gate);
  const gate = team.workflow[gateIdx >= 0 ? gateIdx : team.workflow.length - 1];

  const specFor = (stage: Stage, agentId: string, pass: Pass, reviewText?: string): StepSpec => ({
    label: stepLabel(stage.label, agentId, pass),
    stage: stage.label,
    kind: pass === 2 && stage.label !== team.workflow[0].label ? "rework" : "work",
    pass, agentId, reviewText,
  });

  // D11 + the seam: the opening steps start within the first ~6 s, before any model output, with
  // the recording's labels (Plan · Survey · Setup · Prep checks) so the splice keeps one segment.
  await Promise.all(opening.flatMap((st) => st.agentIds.map((agentId) =>
    writer.emit(runId, "step.started", agentId, {
      label: stepLabel(st.label, agentId, 1), stage: st.label, kind: "work",
    }))));
  underway();

  const stageLane = (stage: Stage, agentId: string, pass: Pass, reviewText?: string) =>
    runStep(ctx, specFor(stage, agentId, pass, reviewText), pass === 1 && openingLabels.has(stage.label));
  const runStage = async (stage: Stage, pass: Pass, reviewText?: string) => {
    await Promise.all(stage.agentIds.map((agentId) => stageLane(stage, agentId, pass, reviewText)));
  };

  // Plan alongside Prepare (D11), then the middle stages in order.
  await Promise.all(opening.flatMap((st) => st.agentIds.map((agentId) => stageLane(st, agentId, 1))));
  for (const st of mid) {
    if (ctx.handle.stopped) return;
    await runStage(st, 1);
  }

  // The gate: review → accept | bounded rework (§5.3 TEAM 2).
  let used = 0;
  let reviewCount = 0;
  for (;;) {
    if (ctx.handle.stopped) return;
    reviewCount++;
    const verdict = await reviewStep(ctx, gate, reviewCount);
    if (!verdict) {
      await blocked(ctx, "the review step could not produce a verdict (model or timeout failure)");
      return;
    }
    if (verdict.verdict === "accept") {
      // → onEnd → finalizeRun. A finalize failure is the server's to report, not the workflow's:
      // the run is already accepted on disk, so it must not read as a workflow crash.
      try {
        await writer.end(runId, "accepted", verdict.text);
      } catch (err) {
        if (!quiet(err)) console.error(`[team] run ${runId} accepted, but finalize failed:`, err);
      }
      return;
    }
    if (bounceOutcome(used, run.reworkBudget) === "blocked") {
      await blocked(ctx, `rework budget exhausted (${run.reworkBudget}): the review still requests changes — ${verdict.text}`);
      return;
    }
    used++;
    for (const plan of rework) {
      if (ctx.handle.stopped) return;
      await runStage(plan.stage, 2, verdict.text); // Re-plan → Rework → Re-check
    }
  }
}

async function blocked(ctx: RunCtx, reason: string): Promise<void> {
  await ctx.writer.emit(ctx.runId, "run.blocked", undefined, { reason });
  await ctx.writer.end(ctx.runId, "blocked", reason); // finalize claims finality; no report
  ctx.publish?.({ type: "run.changed", runId: ctx.runId });
}

// ---- the review gate ----

const verdictSchema = z.object({
  verdict: z.enum(["accept", "request_changes"]),
  text: z.string().min(10).describe("One or two sentences: what the evidence shows and what you decided"),
  checks: z.array(z.object({
    index: z.number().int(),
    pass: z.boolean(),
    note: z.string().min(3),
  })).optional().describe("The criteria you verified yourself, by index"),
});

export interface Verdict {
  verdict: "accept" | "request_changes";
  text: string;
}

/**
 * The reviewer's step: a structured-output call (thinking off), so the verdict is parseable. The
 * step opens as "Review" (its recording label depends on a verdict not yet known); on
 * request_changes the engine then appends the recording's zero-length "Bounced" bounce segment —
 * the stepper's pass logic reads bounce segments. Returns undefined when no verdict was produced.
 */
async function reviewStep(ctx: RunCtx, gate: Stage, reviewCount: number): Promise<Verdict | undefined> {
  const reviewerId = gate.agentIds[0];
  const agent = ctx.profiles.get(reviewerId);
  if (!agent) throw new Error(`no profile for reviewer ${reviewerId}`);
  const writer = ctx.writer;
  const spec: StepSpec = { label: "Review", stage: gate.label, kind: "work", pass: 1, agentId: reviewerId };
  await writer.emit(ctx.runId, "step.started", reviewerId, { label: spec.label, stage: spec.stage, kind: spec.kind });
  let bounce = false;
  try {
    const set = toolsFor(agent, { runId: ctx.runId, step: "Review", writer, db: ctx.db });
    const system = await snapshotBeforeCall(ctx, agent, spec, set.policies, set.sandbox);
    const events = await listStoredEvents(ctx.db, ctx.runId);
    const evidence = [
      ...events.filter((e) => e.type === "agent.message").map((e) => `${e.actorAgentId}: ${String(e.payload.text)}`),
      ...events.filter((e) => e.type === "tool.result").slice(-16).map((e) => `${e.actorAgentId}: ${String(e.payload.line)}`),
      ...events.filter((e) => e.type === "artifact.created").map((e) => `artifact ${String(e.payload.name)} by ${e.actorAgentId}`),
    ].join("\n") || "(nothing yet)";
    const abort = new AbortController();
    const call = generateObject({
      model: model(agent.agent.model, { thinking: "off", meter: { runId: ctx.runId, agentId: reviewerId, step: "Review" } }),
      schema: verdictSchema,
      system: `${system}\n\nYou are the review gate. Judge the EVIDENCE, not the effort: "accept" only if the criteria you could verify hold; otherwise "request_changes" with exactly what must change.`,
      prompt: [
        `Objective: ${ctx.brief.objective}`,
        `Completion criteria (by index):\n${ctx.brief.criteria.map((c, i) => `${i}. ${c}`).join("\n") || "(none)"}`,
        `The run's evidence so far:\n${evidence}`,
        reviewCount > 1 ? `This is review ${reviewCount}, after ${reviewCount - 1} rework pass(es).` : "",
        "Your verdict, your reasoning, and the criteria you verified yourself.",
      ].filter(Boolean).join("\n\n"),
      temperature: 0.2,
      // Room for Claude's per-criterion notes (Neon lane); a capped object fails the schema.
      maxOutputTokens: 2000,
      abortSignal: abort.signal,
    });
    const raced = await raceBail(ctx, call, 90_000, () => abort.abort());
    if (!raced.ok) {
      if (raced.why === "cancel") return undefined;
      await writer.emit(ctx.runId, "agent.message", reviewerId, {
        text: "Review: no verdict within 90s — blocking honestly rather than guessing",
      });
      return undefined;
    }
    let { verdict, text } = raced.value.object;
    try {
      // Dev hooks (§5.3 TEAM 6), never on by default. forceBounce pins the whole shape —
      // bounce once, then accept — because the reviewer can also bounce NATURALLY (seen live:
      // it caught a real inconsistency in the toy run), and the check needs determinism.
      if (ctx.opts.forceBlock && verdict === "accept") {
        verdict = "request_changes";
        text = `[dev hook: forceBlock turned an accept into a bounce] ${text}`;
      } else if (ctx.opts.forceBounce) {
        if (reviewCount === 1 && verdict === "accept") {
          verdict = "request_changes";
          text = `[dev hook: forceBounce turned an accept into a bounce] ${text}`;
        } else if (reviewCount > 1) {
          verdict = "accept";
          text = `[dev hook: forceBounce accepts after the one bounce] ${text}`;
        }
      }
      await writer.emit(ctx.runId, "review.verdict", reviewerId, { verdict, text });
      for (const c of raced.value.object.checks ?? []) {
        if (c.index >= 0 && c.index < ctx.brief.criteria.length) {
          await writer.emit(ctx.runId, "criterion.checked", reviewerId, { index: c.index, pass: c.pass, note: c.note });
        }
      }
      await emitBudget(ctx);
    } catch (err) {
      if (!quiet(err)) throw err;
      return undefined;
    }
    bounce = verdict === "request_changes";
    return { verdict, text };
  } catch (err) {
    if (quiet(err)) return undefined;
    console.error(`[team] review failed on run ${ctx.runId}:`, err instanceof Error ? err.message : err);
    try {
      await writer.emit(ctx.runId, "agent.message", reviewerId, {
        text: "Review: the verdict call failed — blocking honestly rather than guessing",
      });
    } catch {
      /* closed run */
    }
    return undefined;
  } finally {
    try {
      await writer.emit(ctx.runId, "step.finished", reviewerId, { label: "Review", stage: gate.label, kind: "work" });
      if (bounce) {
        // The recording's Bounced step: the bounce segment the stepper's rework pass reads.
        await writer.emit(ctx.runId, "step.started", reviewerId, { label: "Bounced", stage: gate.label, kind: "bounce" });
        const used = (await countRework(ctx)) + 1; // this bounce included, like the recording's {used: 1}
        await writer.emit(ctx.runId, "rework.requested", reviewerId, { to: ctx.leadId, used, budget: ctx.run.reworkBudget });
        await emitBudget(ctx, { used, budget: ctx.run.reworkBudget });
        await writer.emit(ctx.runId, "handoff", reviewerId, { to: ctx.leadId });
        await writer.emit(ctx.runId, "step.finished", reviewerId, { label: "Bounced", stage: gate.label, kind: "bounce" });
      }
    } catch (err) {
      if (!quiet(err)) throw err;
    }
  }
}

/** rework.requested events so far — the honest counter behind the bounce's budget.update. */
async function countRework(ctx: RunCtx): Promise<number> {
  const events = await listStoredEvents(ctx.db, ctx.runId);
  return events.filter((e) => e.type === "rework.requested").length;
}
