// Dana's session definition (ANY-56 S7): the DecideDef snapshot the session
// stream carries in `run.created`, plus the two fields the turn needs that the
// def channel carries as plain data — the system prompt (`system`) and the full
// tool declarations (`toolSchemas`). The runtime's `ll.call` reads both from the
// snapshot; decide's rules read the base fields. Everything here is pure: the
// same config always yields the same definition, so a re-stamp cannot fork a
// turn's shape.
//
// Incognito (PRODUCT §10.7): an incognito session gets no `recall` — not in the
// allowlist, not in the schemas — so no memory path exists for the turn to
// take, and the context assembly (see ./context) finds no recall tool and
// leaves the memory store alone.
import type { DecideDef } from "@fabric/core";
import { defaultThinking } from "../../llm";
import { buildSystemPrompt, fallbackDana, type RegistryBrief } from "../prompt";

/** One tool declaration as the model sees it: the runtime `ModelTool` shape. */
export type ToolSchema = {
  name: string;
  description?: string;
  parameters?: unknown;
};

/** The registry shape the static prompt is built with: Dana's fallback profile
 * has no stored workspace and no registry rows until the db-backed prompt
 * arrives with the server wiring (S9 takes the db path; the snapshot stays
 * stable until then). */
const EMPTY_REGISTRY: RegistryBrief = { agents: [], teams: [], personaPool: [] };

/** The per-turn rule the card adds on top of today's prompt: the disposition
 * names what was considered, before anything is said. The exact wording is
 * pinned by the test fixture (src/__tests__/session/fixture.ts). */
export const DISPOSITION_INSTRUCTION =
  "Before you answer, call record_disposition with considered (the dispositions you weighed) and a one-line reason; only then reply.";

/** The per-turn cost cap when neither the config nor the env names one. */
export const DEFAULT_TURN_COST_CAP_USD = 0.5;

/** MAX_STEPS, today's value: disposition → text is 2; 6 is headroom. */
export const MAX_STEPS = 6;

export type DanaSessionConfig = {
  /** Incognito sessions drop the recall tool entirely (PRODUCT §10.7). */
  incognito?: boolean;
  /** DANA_TURN_COST_CAP_USD; the card's default is 0.50. */
  turnCostCapUsd?: number | null;
  /** The model choice recorded on `llm.requested`; absent = the runtime default. */
  model?: string;
  /** The thinking level; today's defaultThinking("dana") is "off". */
  thinking?: string;
};

export type DanaSessionDef = Omit<DecideDef, "streamId"> & {
  /** The stream stamping injects at decide time; the snapshot itself is stream-less. */
  streamId?: string;
  /** The system prompt: today's prompt.ts verbatim plus the disposition rule. */
  system: string;
  /** Full declarations for every tool in `tools`, in the same order. */
  toolSchemas: ToolSchema[];
  /** The session's thinking level; `ll.call` forwards it to the model port. */
  thinking: string;
};

const DISPOSITION_TOOL: ToolSchema = {
  name: "record_disposition",
  description: "Record how this turn is routed. Call it first, every turn, before any text.",
  parameters: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["direct", "agent", "team", "propose", "clarify"],
        description: "How the turn is routed.",
      },
      target: { type: "string", description: "The agent or team id, when the kind names one." },
      reason: { type: "string", description: "One short sentence." },
      considered: { type: "array", items: { type: "string" }, description: "The dispositions you weighed." },
    },
    required: ["kind", "reason"],
  },
};

const ASK_USER_TOOL: ToolSchema = {
  name: "ask_user",
  description: "Ask the user exactly one question and end the turn; the answer arrives as the tool result.",
  parameters: {
    type: "object",
    properties: { prompt: { type: "string", description: "The question, in one sentence." } },
    required: ["prompt"],
  },
};

/** The recall declaration, shared with the ToolPort descriptor below. */
export const RECALL_TOOL: ToolSchema = {
  name: "recall",
  description: "Recall only the personal facts relevant to this turn, as key/value pairs.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "What to recall, in a few words." } },
    required: ["query"],
  },
};

/** Dana's session definition: the loop's knobs, the system prompt and the tool
 * schemas, stamped once at session create and never edited after. */
export function danaSessionDef(config: DanaSessionConfig = {}): DanaSessionDef {
  const incognito = config.incognito === true;

  // `record_disposition` and `ask_user` are session-virtual (S2): decide answers
  // them without a `tool.call`. `recall` is the one real tool, effect `read`.
  const tools = ["record_disposition", "ask_user"];
  const toolSchemas: ToolSchema[] = [DISPOSITION_TOOL, ASK_USER_TOOL];
  const toolEffects: Record<string, "read" | "idempotent" | "rerunnable" | "once"> = {};
  if (!incognito) {
    tools.push("recall");
    toolSchemas.push(RECALL_TOOL);
    toolEffects.recall = "read";
  }

  const def: DanaSessionDef = {
    tools,
    toolEffects: toolEffects as DecideDef["toolEffects"],
    maxSteps: MAX_STEPS,
    surfaces: ["app"],
    turnCostCapUsd: config.turnCostCapUsd === undefined ? DEFAULT_TURN_COST_CAP_USD : config.turnCostCapUsd,
    system: `${buildSystemPrompt(fallbackDana(), EMPTY_REGISTRY)}\n\n${DISPOSITION_INSTRUCTION}`,
    toolSchemas,
    thinking: config.thinking ?? defaultThinking("dana"),
  };
  if (typeof config.model === "string" && config.model !== "") def.model = config.model;
  return def;
}
