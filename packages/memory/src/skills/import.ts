// Importing skill folders (ANY-75 M1; v1 skills come in by import, Ty
// 2026-10-13): a folder with its own SKILL.md, or every immediate subfolder
// of a root that has one — e.g. ~/.claude/skills or a Hermes skills
// directory. One bad folder never stops the others.
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { readSkillFolder, SKILL_MD } from "./format";
import type { SkillsStore } from "./store";

/** One result per folder; `message` is set exactly when the folder errored. */
export type SkillImportResult =
  | {
      folder: string;
      status: "created" | "patched" | "unchanged";
      skillId: string;
      version: number;
      message?: never;
    }
  | { folder: string; status: "error"; message: string; skillId?: never; version?: never };

const STATUS = { create: "created", patch: "patched", unchanged: "unchanged" } as const;

async function isDirectory(target: string): Promise<boolean> {
  return (await stat(target).catch(() => undefined))?.isDirectory() ?? false;
}

async function isFile(target: string): Promise<boolean> {
  return (await stat(target).catch(() => undefined))?.isFile() ?? false;
}

/** The skill folders under `dir`, sorted by name. Top-level symlinks are followed. */
async function skillFolders(dir: string): Promise<string[]> {
  if (await isFile(path.join(dir, SKILL_MD))) return [dir];
  const names = (await readdir(dir)).filter((name) => !name.startsWith(".")).sort();
  const folders: string[] = [];
  for (const name of names) {
    const candidate = path.join(dir, name);
    if ((await isDirectory(candidate)) && (await isFile(path.join(candidate, SKILL_MD)))) {
      folders.push(candidate);
    }
  }
  return folders;
}

/** Imports the skill folders under `dir` for one agent, with `source: "user"`. */
export async function importSkills(
  skills: SkillsStore,
  dir: string,
  { agentId }: { agentId: string }
): Promise<SkillImportResult[]> {
  const results: SkillImportResult[] = [];
  for (const folderPath of await skillFolders(path.resolve(dir))) {
    const folder = path.basename(folderPath);
    try {
      const parsed = await readSkillFolder(folderPath);
      const written = await skills.write(agentId, parsed, { origin: `import:${folder}`, source: "user" });
      results.push({ folder, status: STATUS[written.op], skillId: written.skillId, version: written.version });
    } catch (error) {
      results.push({ folder, status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
