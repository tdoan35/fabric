// The deterministic brief: the same shape as compileBrief's output, no model call. The handoff
// falls back to it when the brief compiler fails (ARCH §11), so a handoff itself never fails.
// Never contains transcript text (PRODUCT §2.6).
import type { Brief } from "@fabric/contracts";
import { STAYED } from "@fabric/fixtures/run";
import { countTokens, preferenceItems, renderBrief } from "../context";
import type { BriefInput } from "../context";

/**
 * The deterministic brief for fixture-mode handoffs: same shape as compileBrief's output, no model
 * call, so scripted Dana works with the lane down. Never contains transcript text (PRODUCT §2.6).
 */
export function fixtureBrief(input: BriefInput): Brief {
  const demo = /n-gram|engram/i.test(input.request);
  const brief: Brief = {
    objective: demo
      ? "Evaluate the impact of a disk-resident n-gram lookup table on held-out perplexity for a 135M open model."
      : `Run this end to end and report whether it holds: ${input.request.replace(/\s+/g, " ").trim().slice(0, 160)}`,
    constraints: demo
      ? ["Cached corpus only; no new downloads", "The n-gram table stays on disk, never loaded into RAM"]
      : ["Stay within the team's rework budget"],
    criteria: input.team.criteria,
    preferences: [...new Set(input.specialists.flatMap(preferenceItems))],
    stayed: [...STAYED],
    tokens: 0,
  };
  brief.tokens = countTokens(renderBrief(brief)).tokens;
  return brief;
}
