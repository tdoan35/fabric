// The splice seam (D5, RUN-2): a live step whose label AND stage match the recording's open step
// stays one continuous segment across the Fast-forward (packages/db/src/splice.ts), so the labels
// below are not cosmetic — they are read off the ngram-135m bundle:
//
//   pass 1   elliot "Plan" (Plan) · megan "Survey", jonah "Setup", sana "Prep checks" (Prepare)
//            elliot "Synthesize" · jonah "Implement" · sana "Validate" · carlos "Bounced" (bounce)
//   rework   elliot "Re-plan" (Plan) · jonah "Rework" (Implement, rework) · sana "Re-check" (Validate)
//            carlos "Accepted" (Review, work)
//
// Carlos's label depends on a verdict that is only known after his model call, so his step OPENS as
// "Review" and a request_changes verdict appends a zero-length "Bounced" bounce segment (the
// stepper's pass logic reads bounce segments). The demo's splice lands at ~45 s, while only the
// Plan/Prepare steps above are open, so the seam never depends on his label.
import type { StudioTeam } from "@fabric/contracts";

/** (stage label, agent id) → step label, first pass. Anything unknown falls back to the stage. */
const PASS_1: Record<string, Record<string, string>> = {
  Plan: { elliot: "Plan" },
  Prepare: { megan: "Survey", jonah: "Setup", sana: "Prep checks" },
  Synthesize: { elliot: "Synthesize" },
  Implement: { jonah: "Implement" },
  Validate: { sana: "Validate" },
};

/** The rework pass re-labels the stages it re-runs (the recording's Re-plan / Rework / Re-check). */
const REWORK: Record<string, Record<string, string>> = {
  Plan: { elliot: "Re-plan" },
  Implement: { jonah: "Rework" },
  Validate: { sana: "Re-check" },
};

export type Pass = 1 | 2;

export function stepLabel(stage: string, agentId: string, pass: Pass): string {
  const table = pass === 1 ? PASS_1 : REWORK;
  return table[stage]?.[agentId] ?? stage;
}

/** Which kind a step segment carries: rework passes mark the non-lead stages as "rework". */
export function stepKind(stage: string, pass: Pass, isReworkStage: boolean): "work" | "rework" {
  return pass === 2 && isReworkStage && stage !== "Plan" ? "rework" : "work";
}

// ---- pass planning: the data-driven shape of teams.workflow ----

export interface StagePlan {
  stage: StudioTeam["workflow"][number];
  /** Rework pass stages (Implement, Validate) run as kind "rework"; the lead's Re-plan stays work. */
  kind: "work" | "rework";
}

/**
 * The run's stage plan, data-driven from teams.workflow:
 * - `opening`: stage[0] runs ALONGSIDE stage[1] (D11 — at least 3 members working within 45 s);
 * - `mid`: the stages between Prepare and the gate, in order (Synthesize, Implement, Validate);
 * - `rework`: the lead re-plans (stage[0], "work"), then the non-lead mid stages re-run as
 *   "rework" — the recording's Re-plan → Rework → Re-check, skipping a second Synthesize.
 */
export function planPasses(workflow: StudioTeam["workflow"], leadAgentId: string): { opening: StudioTeam["workflow"]; mid: StudioTeam["workflow"]; rework: StagePlan[] } {
  const gateIdx = workflow.findIndex((s) => s.gate);
  const gate = gateIdx >= 0 ? gateIdx : workflow.length - 1;
  const mid = workflow.slice(2, gate);
  return {
    opening: workflow.slice(0, Math.min(2, gate)),
    mid,
    rework: [
      { stage: workflow[0], kind: "work" as const },
      ...mid.filter((s) => !s.agentIds.includes(leadAgentId)).map((stage) => ({ stage, kind: "rework" as const })),
    ],
  };
}

/**
 * A bounce when `used` reworks have already happened: rework if the budget still allows it,
 * otherwise the run blocks. Budget 2 → rework, rework, block; budget 1 → rework, block — so
 * "rework budget 1 plus two bounces → run.blocked" (the forced-exhaustion hook).
 */
export function bounceOutcome(used: number, budget: number): "rework" | "blocked" {
  return used >= budget ? "blocked" : "rework";
}
