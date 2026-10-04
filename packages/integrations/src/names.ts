// Provider tool names can't contain dots (Anthropic/OpenAI require ^[a-zA-Z0-9_-]+$), so the
// AI SDK tool-set keys are sprite_exec, exa_search, … — mapped back to the canonical ToolName
// (contracts) for policies and run events. TEAM passes `tools` straight to generateText/streamText
// and uses this mapping for everything else (§5.3 TOOLS 1).
import { TOOL_NAMES, isToolName } from "@fabric/contracts";
import type { ToolName } from "@fabric/contracts";

/** sprite.exec → sprite_exec */
export const TOOL_KEYS = Object.fromEntries(TOOL_NAMES.map((n) => [n, n.replace(".", "_")])) as Record<ToolName, string>;

/** sprite_exec → sprite.exec; undefined when the key isn't one of ours. */
export const TOOL_NAMES_BY_KEY: Record<string, ToolName> = Object.fromEntries(
  TOOL_NAMES.map((n) => [n.replace(".", "_"), n]),
);

export const toolKeyOf = (name: ToolName): string => TOOL_KEYS[name];

export const toolNameOf = (key: string): ToolName | undefined =>
  isToolName(TOOL_NAMES_BY_KEY[key] ?? "") ? (TOOL_NAMES_BY_KEY[key] as ToolName) : undefined;
