// S14 (ANY-64) removed scripted Dana: the scripted turn machinery (fixtureTurn, the demo cards,
// the canned lines) is gone with the one-response chat path. This file keeps exactly one export —
// the deterministic brief — because session/bridges.ts (outside this card's file scope, unchanged)
// imports it as the compileBrief fallback, so a handoff itself never fails (ARCH §11). It is built
// from the request text and the team's own cards, never from canned transcript content (PRODUCT §2.6).
import { STAYED } from "@fabric/fixtures/run";
import type { Brief } from "@fabric/contracts";
import { countTokens, preferenceItems, renderBrief } from "../context";
import type { BriefInput } from "../context";

// Clause-level cues that mark a request sentence as a limit on the work rather than its goal.
const CONSTRAINT_CUE = /\b(?:only|never|no|not|don't|do not|without|must|stay|stays|keep|keeps|within|avoid|at most|no more than)\b/i;

/** The deterministic brief: same shape as compileBrief's output, no model call. The objective and
 * the constraints both come from the request's own clauses, so whatever was asked is what is briefed. */
export function fixtureBrief(input: BriefInput): Brief {
  const text = input.request.replace(/\s+/g, " ").trim();
  const clauses = text.split(/(?<=[.!?;])\s+|\s*\n\s*/).map((c) => c.replace(/[.!?;]+$/, "").trim()).filter(Boolean);
  const limits = clauses.filter((c) => CONSTRAINT_CUE.test(c));
  const goal = clauses.filter((c) => !CONSTRAINT_CUE.test(c)).join(". ") || text;
  const brief: Brief = {
    objective: `Run this end to end and report whether it holds: ${goal.slice(0, 160)}`,
    constraints: limits.length ? limits.map((c) => c.slice(0, 160)) : ["Stay within the team's rework budget"],
    criteria: input.team.criteria,
    preferences: [...new Set(input.specialists.flatMap(preferenceItems))],
    stayed: [...STAYED],
    tokens: 0,
  };
  brief.tokens = countTokens(renderBrief(brief)).tokens;
  return brief;
}
