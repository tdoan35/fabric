// S14 (ANY-64) removed scripted Dana: the scripted turn machinery (fixtureTurn, the demo cards,
// the canned lines) is gone with the one-response chat path. This file keeps exactly one export —
// the deterministic brief — because session/bridges.ts (outside this card's file scope, unchanged)
// imports it as the compileBrief fallback, so a handoff itself never fails (ARCH §11). It is built
// from the request text and the team's own cards, never from canned transcript content (PRODUCT §2.6).
import { STAYED } from "@fabric/fixtures/run";
import type { Brief } from "@fabric/contracts";
import { countTokens, preferenceItems, renderBrief } from "../context";
import type { BriefInput } from "../context";

/** The deterministic brief: same shape as compileBrief's output, no model call. */
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
