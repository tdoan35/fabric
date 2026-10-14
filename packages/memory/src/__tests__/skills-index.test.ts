// ANY-76 M2 — the skills index text context assembly will include (LEARNING
// §3): a fixed header (worded in fixtures/skill-index-header.txt, so a change
// shows in the diff), `- <name> — <description>` lines cut to 100 characters
// in name order, per-role caps on count and estimated tokens (ceil(chars/3)
// over the skill lines; Ty, 2026-10-14), and a `+<n> more` tail.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { renderSkillIndex, type SkillSummary } from "../skills";

const HEADER_LINES = readFileSync(new URL("./fixtures/skill-index-header.txt", import.meta.url), "utf8")
  .trimEnd()
  .split("\n");

const summary = (name: string, description: string): SkillSummary => ({
  skillId: `id-${name}`,
  name,
  description,
  version: 1,
  updatedAt: "2026-10-14T00:00:00.000Z",
});

/** The text split into header, skill lines and the optional `+n more` tail. */
function parts(text: string): { header: string[]; lines: string[]; more: string | undefined } {
  const all = text.split("\n");
  const header = all.slice(0, HEADER_LINES.length);
  const rest = all.slice(HEADER_LINES.length);
  const more = rest.length > 0 && rest[rest.length - 1].startsWith("+") ? rest.pop() : undefined;
  return { header, lines: rest, more };
}

const estimate = (lines: readonly string[]): number => Math.ceil(lines.join("\n").length / 3);
const pad = (n: number): string => String(n).padStart(2, "0");

describe("skills index (ANY-76 M2)", () => {
  test("L7 three skills render the fixture header and three lines in name order", () => {
    const index = renderSkillIndex(
      [
        summary("release-notes", "Draft release notes from merged PRs."),
        summary("lit-review", "Survey the literature on a question."),
        summary("pdf-report", "Build a one-page PDF report."),
      ],
      { role: "dana" }
    );

    const { header, lines, more } = parts(index.text);
    expect(header).toEqual(HEADER_LINES);
    expect(lines).toEqual([
      "- lit-review — Survey the literature on a question.",
      "- pdf-report — Build a one-page PDF report.",
      "- release-notes — Draft release notes from merged PRs.",
    ]);
    expect(more).toBeUndefined();
    expect(index.included).toEqual(["lit-review", "pdf-report", "release-notes"]);
    expect(index.omitted).toBe(0);
    expect(index.text).not.toContain("more: call skills_list");
  });

  test("L8 a 120-character description gives a line of exactly 100 characters ending in …", () => {
    const description = "abcdefghij".repeat(12);
    expect(description).toHaveLength(120);
    const { lines } = parts(renderSkillIndex([summary("long-one", description)], { role: "dana" }).text);

    expect(lines).toHaveLength(1);
    expect([...lines[0]]).toHaveLength(100);
    expect(lines[0].endsWith("…")).toBe(true);
    expect(lines[0].startsWith("- long-one — abcdefghij")).toBe(true);

    // A line of exactly 100 characters is not cut.
    const exact = "x".repeat(100 - "- exact — ".length);
    const uncut = parts(renderSkillIndex([summary("exact", exact)], { role: "dana" }).text).lines[0];
    expect(uncut).toBe(`- exact — ${exact}`);
    expect(uncut).toHaveLength(100);
  });

  test("L9 20 short skills for dana → 15 lines plus +5 more", () => {
    const many = Array.from({ length: 20 }, (_, i) => summary(`skill-${pad(i + 1)}`, "Short."));
    const index = renderSkillIndex(many.reverse(), { role: "dana" });

    const { lines, more } = parts(index.text);
    expect(lines).toHaveLength(15);
    expect(lines[0]).toBe("- skill-01 — Short.");
    expect(lines[14]).toBe("- skill-15 — Short.");
    expect(more).toBe("+5 more: call skills_list");
    expect(index.included).toHaveLength(15);
    expect(index.omitted).toBe(5);
  });

  test("L9 15 long skills for dana → fewer than 15 lines, within 450 tokens, the rest omitted", () => {
    const long = Array.from({ length: 15 }, (_, i) => summary(`skill-${pad(i + 1)}`, "y".repeat(120)));
    const index = renderSkillIndex(long, { role: "dana" });

    const { lines, more } = parts(index.text);
    expect(lines.length).toBeLessThan(15);
    expect(lines.length).toBeGreaterThan(0);
    expect(estimate(lines)).toBeLessThanOrEqual(450);
    // The cap is tight: one more line would have crossed it.
    expect(estimate([...lines, lines[0]])).toBeGreaterThan(450);
    expect(index.included).toHaveLength(lines.length);
    expect(index.omitted).toBe(15 - lines.length);
    expect(more).toBe(`+${15 - lines.length} more: call skills_list`);
  });

  test("L9 lead and specialist caps: 25 and 35 skills, 750 and 1,000 tokens", () => {
    const short = Array.from({ length: 40 }, (_, i) => summary(`skill-${pad(i + 1)}`, "Short."));
    expect(renderSkillIndex(short, { role: "lead" }).included).toHaveLength(25);
    expect(renderSkillIndex(short, { role: "specialist" }).included).toHaveLength(35);

    const long = Array.from({ length: 40 }, (_, i) => summary(`skill-${pad(i + 1)}`, "z".repeat(120)));
    for (const [role, cap] of [
      ["lead", 750],
      ["specialist", 1000],
    ] as const) {
      const { lines } = parts(renderSkillIndex(long, { role }).text);
      expect(estimate(lines)).toBeLessThanOrEqual(cap);
      expect(estimate([...lines, lines[0]])).toBeGreaterThan(cap);
    }
  });

  test("L10 no skills → empty text, no header", () => {
    expect(renderSkillIndex([], { role: "dana" })).toEqual({ text: "", included: [], omitted: 0 });
    expect(renderSkillIndex([], { role: "specialist" }).text).toBe("");
  });
});
