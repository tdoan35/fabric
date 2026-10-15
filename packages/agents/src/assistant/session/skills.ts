// The skills stamp (ANY-83 M3; LEARNING §3): the pure seam between M1's
// store and the session definition. `withSkillsIndex` appends the rendered
// skills index to the definition's system prompt — once, at create, like the
// rest of the definition, so the prompt stays byte-stable for the provider's
// cache; a skill imported later surfaces through `skills_list`/`skills_read`
// and in the index of new sessions. `SKILL_TOOL_DEFAULTS` is the toolset's
// defaults hook: the two read tools are every agent's own procedures — Dana
// included — so they are `allowed` unless a registry row says otherwise, and
// incognito keeps them (skills are not memory about the user; nothing here
// writes).
import type { SkillIndex } from "@fabric/memory/skills";
import type { ToolAccessLevel } from "./toolset";

/** The toolset defaults (D5): both skills tools allowed for every agent; a
 * row naming either tool overrides its default, so `blocked` removes it. */
export const SKILL_TOOL_DEFAULTS: Readonly<Record<"skills_list" | "skills_read", ToolAccessLevel>> = Object.freeze({
  skills_list: "allowed",
  skills_read: "allowed",
});

/**
 * Stamp the rendered skills index onto the definition: an empty index leaves
 * the definition untouched, otherwise `system` gains `\n\n` plus the index
 * text. A definition without a system prompt (the S5 placeholder) stays
 * untouched too — there is nothing to append to. Pure: the same definition
 * and index always yield the same stamped definition.
 */
export function withSkillsIndex<D extends { system?: string }>(def: D, index: SkillIndex): D {
  if (index.text === "") return def;
  if (typeof def.system !== "string") return def;
  return { ...def, system: `${def.system}\n\n${index.text}` };
}
