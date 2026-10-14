// The skills index (ANY-76 M2; LEARNING §3): the text context assembly puts
// in an agent's base context. Lines are `- <name> — <description>`, cut to
// 100 characters, in name order — there is no strength until ANY-47, and a
// stable order keeps the provider's prompt cache warm. Each role caps the
// index by count and by estimated tokens, whichever is hit first.
import type { SkillSummary } from "./store";

export type SkillIndexRole = "dana" | "lead" | "specialist";

export interface SkillIndex {
  text: string;
  /** The names that made it into the index, in order. */
  included: string[];
  /** How many skills the caps left out. */
  omitted: number;
}

/** LEARNING §3's per-role caps. */
export const SKILL_INDEX_CAPS: Record<SkillIndexRole, { skills: number; tokens: number }> = {
  dana: { skills: 15, tokens: 450 },
  lead: { skills: 25, tokens: 750 },
  specialist: { skills: 35, tokens: 1000 },
};

/** The fixed instructions above the lines; the wording is pinned by a test fixture. */
export const SKILL_INDEX_HEADER = [
  "## Skills",
  "Load a skill with skills_read when it matches the task. Don't load skills speculatively; when unsure, call skills_list.",
].join("\n");

const MAX_LINE_CHARS = 100;

/** Tokens over the skill lines, estimated as ceil(chars / 3) (Ty, 2026-10-14). */
const estimateTokens = (chars: number): number => Math.ceil(chars / 3);

/** `- <name> — <description>`, cut to 100 characters (code points) with a trailing `…`. */
function indexLine({ name, description }: SkillSummary): string {
  const chars = [...`- ${name} — ${description.replace(/\s+/g, " ").trim()}`];
  return chars.length <= MAX_LINE_CHARS ? chars.join("") : `${chars.slice(0, MAX_LINE_CHARS - 1).join("")}…`;
}

export function renderSkillIndex(skills: readonly SkillSummary[], { role }: { role: SkillIndexRole }): SkillIndex {
  if (skills.length === 0) return { text: "", included: [], omitted: 0 };
  const cap = SKILL_INDEX_CAPS[role];
  const sorted = [...skills].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const lines: string[] = [];
  const included: string[] = [];
  let chars = 0;
  for (const skill of sorted) {
    if (lines.length === cap.skills) break;
    const line = indexLine(skill);
    // Lines are joined by newlines; count them with the line they precede.
    const next = chars + (lines.length === 0 ? 0 : 1) + [...line].length;
    if (estimateTokens(next) > cap.tokens) break;
    lines.push(line);
    included.push(skill.name);
    chars = next;
  }

  const omitted = sorted.length - included.length;
  const tail = omitted > 0 ? [`+${omitted} more: call skills_list`] : [];
  return { text: [SKILL_INDEX_HEADER, ...lines, ...tail].join("\n"), included, omitted };
}
