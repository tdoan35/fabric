// The skills read tools (ANY-76 M2; LEARNING §3): `skills_list` and
// `skills_read` over M1's store, declared with T1's defineTool. Both act as
// scope.agentId only — the model can't name another agent, so another
// agent's skill is an unknown skill. A load is a tool call, so every use is
// in the log. Nothing here is wired into sessions yet (ANY-66 batch 2).
import path from "node:path";
import { defineTool, type ToolDef } from "@fabric/tools";
import { z } from "zod";
import type { SkillsStore } from "./store";

/** The largest file `skills_read` returns as text. */
export const MAX_SKILL_READ_BYTES = 100 * 1024;

/** The normalised in-folder path, or undefined when it is absolute or escapes the folder. */
function folderPath(raw: string): string | undefined {
  if (raw === "" || path.posix.isAbsolute(raw)) return undefined;
  const normalised = path.posix.normalize(raw);
  if (normalised === "." || normalised === ".." || normalised.startsWith("../")) return undefined;
  return normalised;
}

export function skillTools(skills: SkillsStore): ToolDef[] {
  const skillsList = defineTool({
    name: "skills_list",
    description:
      "List your skills by name and description. Pass `query` to keep only skills whose name or description contains it (case-insensitive).",
    parameters: z.object({ query: z.string().optional() }),
    effect: "read",
    gate: "none",
    kind: "read",
    step: 0,
    async execute({ query }, { scope }) {
      const needle = query?.toLowerCase();
      const all = await skills.list(scope.agentId);
      return {
        skills: all
          .filter(
            (skill) =>
              needle === undefined ||
              skill.name.toLowerCase().includes(needle) ||
              skill.description.toLowerCase().includes(needle)
          )
          .map(({ name, description }) => ({ name, description })),
      };
    },
  });

  const skillsRead = defineTool({
    name: "skills_read",
    description:
      "Load one of your skills by name: its instructions and the list of its files. Pass `path` to read one of those files as text instead.",
    parameters: z.object({ name: z.string().min(1), path: z.string().optional() }),
    effect: "read",
    gate: "none",
    kind: "read",
    step: 0,
    async execute({ name, path: rawPath }, { scope }) {
      const skill = await skills.read(scope.agentId, name);
      if (skill === undefined) throw new Error(`unknown skill: ${name}`);
      if (rawPath === undefined) {
        return { name, version: skill.version, body: skill.body, files: skill.files };
      }

      const rel = folderPath(rawPath);
      if (rel === undefined) throw new Error(`invalid path: ${rawPath}`);
      const bytes = await skills.readFile(scope.agentId, name, rel, { version: skill.version });
      if (bytes === undefined) throw new Error(`unknown file: ${rawPath}`);
      if (bytes.byteLength > MAX_SKILL_READ_BYTES) throw new Error(`file too large: ${rawPath}`);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error(`binary file: ${rawPath}`);
      }
      return { name, version: skill.version, path: rel, text };
    },
  });

  return [skillsList, skillsRead];
}
