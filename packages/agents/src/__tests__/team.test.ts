// TEAM's pure parts (§5.3 TEAM): the splice-seam label table read off the ngram-135m bundle, the
// data-driven pass planning over teams.workflow, the rework-budget rule, and the step prompts.
import { describe, expect, it } from "vitest";
import { studioTeams } from "@fabric/fixtures/teams";
import { bounceOutcome, planPasses, stepKind, stepLabel } from "../team/labels";
import { stepPrompt } from "../team/steps";
import type { RunCtx } from "../team/steps";
import { profileById } from "@fabric/fixtures/studio";
import type { Run } from "@fabric/contracts";

const research = studioTeams.find((t) => t.id === "research")!;

/** The recording's (agent, label, stage, kind) table — the splice seam this must equal. */
const RECORDING: [string, string, string, string][] = [
  ["elliot", "Plan", "Plan", "work"],
  ["megan", "Survey", "Prepare", "work"],
  ["jonah", "Setup", "Prepare", "work"],
  ["sana", "Prep checks", "Prepare", "work"],
  ["elliot", "Synthesize", "Synthesize", "work"],
  ["jonah", "Implement", "Implement", "work"],
  ["sana", "Validate", "Validate", "work"],
  ["elliot", "Re-plan", "Plan", "work"],
  ["jonah", "Rework", "Implement", "rework"],
  ["sana", "Re-check", "Validate", "work"],
];

describe("step labels (the splice seam, D5)", () => {
  it("matches the ngram-135m bundle per agent and stage, both passes", () => {
    for (const [agentId, label, stage] of RECORDING) {
      const pass = label === "Re-plan" || label === "Rework" || label === "Re-check" ? 2 : 1;
      expect(stepLabel(stage, agentId, pass as 1 | 2), `${agentId} ${stage} pass ${pass}`).toBe(label);
    }
  });

  it("falls back to the stage label for teams the table doesn't know", () => {
    expect(stepLabel("Ship", "diego", 1)).toBe("Ship");
  });

  it("marks the rework pass's non-lead stages as kind rework", () => {
    expect(stepKind("Implement", 2, true)).toBe("rework");
    expect(stepKind("Plan", 2, true)).toBe("work"); // the lead's Re-plan
    expect(stepKind("Validate", 1, true)).toBe("work");
  });
});

describe("planPasses (data-driven over teams.workflow)", () => {
  it("splits the Research Team's workflow into opening, mid and rework", () => {
    const { opening, mid, rework } = planPasses(research.workflow, "elliot");
    expect(opening.map((s) => s.label)).toEqual(["Plan", "Prepare"]); // D11: Plan alongside Prepare
    expect(mid.map((s) => s.label)).toEqual(["Synthesize", "Implement", "Validate"]);
    expect(rework.map((p) => [p.stage.label, p.kind])).toEqual([
      ["Plan", "work"], // Re-plan
      ["Implement", "rework"], // Rework
      ["Validate", "rework"], // Re-check — kind per segment; the label table keeps "Re-check"
    ]);
  });

  it("keeps at least three members working in the opening stages", () => {
    const { opening } = planPasses(research.workflow, "elliot");
    const members = new Set(opening.flatMap((s) => s.agentIds));
    expect(members.size).toBeGreaterThanOrEqual(3); // PRD §10.3
  });

  it("treats the last stage as the gate when none is flagged", () => {
    const { mid } = planPasses(research.workflow.map((s) => ({ ...s, gate: false })), "elliot");
    expect(mid.map((s) => s.label)).toEqual(["Synthesize", "Implement", "Validate"]); // Review stays the gate
  });
});

describe("bounceOutcome (the rework bound)", () => {
  it("reworks up to reworkBudget times, then blocks", () => {
    expect([0, 1, 2].map((used) => bounceOutcome(used, 2))).toEqual(["rework", "rework", "blocked"]);
    expect([0, 1].map((used) => bounceOutcome(used, 1))).toEqual(["rework", "blocked"]); // the forced-exhaustion shape
    expect(bounceOutcome(0, 0)).toBe("blocked");
  });
});

describe("stepPrompt", () => {
  const run = {
    brief: { objective: "Does an n-gram table help a 135M model?", criteria: ["c1"], constraints: [], preferences: [], stayed: [], tokens: 10 },
  } as unknown as Run;
  const ctx = {
    runId: "run-x-1", run, brief: run.brief, team: research,
    profiles: new Map([["elliot", profileById("elliot")]]),
    leadId: "elliot", handle: { signal: new AbortController().signal, stopped: false }, opts: {},
    startedMs: Date.now(),
  } as unknown as RunCtx;

  it("grounds every prompt in the objective and asks for one short narration line", () => {
    const prompt = stepPrompt(ctx, { label: "Survey", stage: "Prepare", kind: "work", pass: 1, agentId: "megan" });
    expect(prompt).toContain("Does an n-gram table help a 135M model?");
    expect(prompt).toContain("exa_search");
    expect(prompt).toMatch(/at most 12 words/);
  });

  it("carries the reviewer's text on rework passes", () => {
    const prompt = stepPrompt(ctx, { label: "Rework", stage: "Implement", kind: "rework", pass: 2, agentId: "jonah", reviewText: "the split overlaps" });
    expect(prompt).toContain("rework pass");
    expect(prompt).toContain("the split overlaps");
  });
});
