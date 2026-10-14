// The specialist session definition (ANY-59 S9): the same shape as Dana's
// (./definition) built from the agent's registry record — the row the registry
// route serves — instead of Dana's fallback. A direct chat with a specialist is
// a session whose every turn records `direct · user-chosen` (PRODUCT §4): the
// def names the agent (`userChosenAgent`) and core's S2 fallback disposition
// turns that into the record; the model is never offered `record_disposition`
// (the disposition is the user's choice, not the model's) and a call anyway is
// denied by the allowlist (`dispositionVirtual: false`).
//
// Tools: `ask_user` only — the specialists' own tools arrive with ANY-44. The
// per-turn knobs match S7 (MAX_STEPS, the cost cap). Incognito (PRODUCT §10.7)
// is accepted for parity with the dana path; a specialist carries no memory
// tools today, so both variants drop nothing — the model port's context wrapper
// skips the memory read for either (no `recall` in the tool list).
//
// Pure, like every definition: the same record and config always yield the same
// definition, so a re-stamp cannot fork a turn's shape.
import type { DecideDef } from "@fabric/core";
import { defaultThinking } from "../../llm";
import { ASK_USER_TOOL, DEFAULT_TURN_COST_CAP_USD, MAX_STEPS, type ToolSchema } from "./definition";

/** The agent record the definition is built from: the fields the registry's
 * agent row carries that a session turn needs. `instructions` is the prompt —
 * the workspace files' bodies; without it the profile fields stand in. */
export type SpecialistAgent = {
  /** Persona slug: the one agent id space (NAME-1). */
  id: string;
  name: string;
  role?: string;
  /** The agent's instructions, verbatim — the prompt when present. */
  instructions?: string;
  /** Profile fallbacks when no instructions exist. */
  personality?: string;
  summary?: string;
  /** The display model recorded on `llm.requested`; absent = the runtime default. */
  model?: string;
};

export type SpecialistSessionConfig = {
  /** Incognito sessions; no memory path exists to drop yet (see above). */
  incognito?: boolean;
  /** The per-turn cost cap; the card's default is the S7 constant. */
  turnCostCapUsd?: number | null;
  /** The thinking level; the default is the agent's (`defaultThinking`). */
  thinking?: string;
};

export type SpecialistSessionDef = Omit<DecideDef, "streamId"> & {
  /** The stream stamping injects at decide time; the snapshot itself is stream-less. */
  streamId?: string;
  /** The system prompt: the agent's instructions, or its profile. */
  system: string;
  /** Full declarations for every tool in `tools`, in the same order. */
  toolSchemas: ToolSchema[];
  /** The session's thinking level; `ll.call` forwards it to the model port. */
  thinking: string;
};

/** The profile fallback prompt: who the agent is, in the registry's own words. */
const profilePrompt = (agent: SpecialistAgent): string => {
  const role = typeof agent.role === "string" && agent.role !== "" ? `, ${agent.role}` : "";
  const personality = typeof agent.personality === "string" ? agent.personality.trim() : "";
  const summary = typeof agent.summary === "string" ? agent.summary.trim() : "";
  const lines = [`You are ${agent.name}${role}.`];
  if (summary !== "") lines.push("", summary);
  if (personality !== "") lines.push("", personality);
  return lines.join("\n");
};

/** The specialist's session definition: the loop's knobs, the system prompt and
 * the tool schemas, stamped once at session create and never edited after. */
export function specialistSessionDef(agent: SpecialistAgent, config: SpecialistSessionConfig = {}): SpecialistSessionDef {
  const instructions = typeof agent.instructions === "string" ? agent.instructions.trim() : "";

  const def: SpecialistSessionDef = {
    tools: ["ask_user"],
    maxSteps: MAX_STEPS,
    surfaces: ["app"],
    turnCostCapUsd: config.turnCostCapUsd === undefined ? DEFAULT_TURN_COST_CAP_USD : config.turnCostCapUsd,
    // PRODUCT §4: the fallback disposition names the user's pick, every turn.
    userChosenAgent: agent.id,
    // The disposition is the user's, not the model's: record_disposition is not
    // offered, and a call anyway takes the deny path (core S2's virtual rule off).
    dispositionVirtual: false,
    system: instructions !== "" ? instructions : profilePrompt(agent),
    toolSchemas: [{ ...ASK_USER_TOOL }],
    thinking: config.thinking ?? defaultThinking(agent.id),
  };
  if (typeof agent.model === "string" && agent.model !== "") def.model = agent.model;
  return def;
}
