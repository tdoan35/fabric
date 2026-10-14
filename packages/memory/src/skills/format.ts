// The Agent Skills folder format (agentskills.io; LEARNING §5.1): SKILL.md at
// the folder root with YAML frontmatter, then markdown; any other files by
// relative POSIX path. Dotfiles and dot-directories are skipped, symlinks are
// rejected, and a folder is capped at 200 files and 5 MB. Every rejection is a
// SkillFormatError naming its rule and the path it applies to.
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export const SKILL_MD = "SKILL.md";
export const MAX_SKILL_FILES = 200;
export const MAX_SKILL_BYTES = 5 * 1024 * 1024;
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_COMPATIBILITY_LENGTH = 500;

export type SkillFormatRule =
  | "skill-md-required"
  | "frontmatter-required"
  | "name-required"
  | "name-length"
  | "name-pattern"
  | "name-matches-folder"
  | "description-required"
  | "description-length"
  | "compatibility-length"
  | "metadata-string-map"
  | "no-symlinks"
  | "regular-files-only"
  | "path-relative"
  | "max-files"
  | "max-bytes";

export class SkillFormatError extends Error {
  constructor(
    readonly rule: SkillFormatRule,
    /** `<folder>/<relative path>`, or the folder name for folder-wide rules. */
    readonly path: string,
    detail: string
  ) {
    super(`${path}: ${rule}: ${detail}`);
    this.name = "SkillFormatError";
  }
}

/** A parsed skill folder. `files` holds every file, SKILL.md included, sorted by path. */
export interface SkillFolder {
  name: string;
  description: string;
  /** The whole frontmatter, unknown keys included. */
  frontmatter: Record<string, unknown>;
  /** The markdown after the frontmatter. */
  body: string;
  files: ReadonlyMap<string, Uint8Array>;
}

const isDotPath = (rel: string): boolean => rel.split("/").some((segment) => segment.startsWith("."));

/**
 * Splits SKILL.md into its frontmatter source and body. The file must open
 * with a `---` line and close the block with another; blank lines right after
 * the closing line are not part of the body.
 */
export function splitFrontmatter(text: string): { yaml: string; body: string } | undefined {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") return undefined;
  const close = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (close === -1) return undefined;
  let start = close + 1;
  while (start < lines.length - 1 && lines[start].trim() === "") start += 1;
  return { yaml: lines.slice(1, close).join("\n"), body: lines.slice(start).join("\n") };
}

function isStringMap(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

function parseFrontmatter(skillMd: Uint8Array, folderName: string) {
  const where = `${folderName}/${SKILL_MD}`;
  const split = splitFrontmatter(new TextDecoder().decode(skillMd));
  if (split === undefined) {
    throw new SkillFormatError(
      "frontmatter-required",
      where,
      "SKILL.md must start with YAML frontmatter between --- lines"
    );
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(split.yaml);
  } catch (error) {
    throw new SkillFormatError(
      "frontmatter-required",
      where,
      `the frontmatter is not valid YAML (${error instanceof Error ? error.message : String(error)})`
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SkillFormatError("frontmatter-required", where, "the frontmatter must be a YAML mapping");
  }
  const frontmatter = parsed as Record<string, unknown>;

  const { name, description, compatibility, metadata } = frontmatter;
  if (typeof name !== "string") {
    throw new SkillFormatError("name-required", where, "name is required and must be a string");
  }
  if (name.length < 1 || name.length > MAX_NAME_LENGTH) {
    throw new SkillFormatError(
      "name-length",
      where,
      `name must be 1–${MAX_NAME_LENGTH} characters, got ${name.length}`
    );
  }
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new SkillFormatError(
      "name-pattern",
      where,
      `name ${JSON.stringify(name)} must be lowercase letters, digits and single hyphens, not at either end`
    );
  }
  if (name !== folderName) {
    throw new SkillFormatError(
      "name-matches-folder",
      where,
      `name ${JSON.stringify(name)} must equal the folder name ${JSON.stringify(folderName)}`
    );
  }
  if (typeof description !== "string") {
    throw new SkillFormatError("description-required", where, "description is required and must be a string");
  }
  if (description.length < 1 || description.length > MAX_DESCRIPTION_LENGTH) {
    throw new SkillFormatError(
      "description-length",
      where,
      `description must be 1–${MAX_DESCRIPTION_LENGTH} characters, got ${description.length}`
    );
  }
  if (compatibility !== undefined && String(compatibility).length > MAX_COMPATIBILITY_LENGTH) {
    throw new SkillFormatError(
      "compatibility-length",
      where,
      `compatibility must be at most ${MAX_COMPATIBILITY_LENGTH} characters`
    );
  }
  if (metadata !== undefined && !isStringMap(metadata)) {
    throw new SkillFormatError("metadata-string-map", where, "metadata must map strings to strings");
  }
  return { name, description, frontmatter, body: split.body };
}

function checkLimits(count: number, bytes: number, folderName: string): void {
  if (count > MAX_SKILL_FILES) {
    throw new SkillFormatError(
      "max-files",
      folderName,
      `a skill folder holds at most ${MAX_SKILL_FILES} files`
    );
  }
  if (bytes > MAX_SKILL_BYTES) {
    throw new SkillFormatError(
      "max-bytes",
      folderName,
      `a skill folder holds at most ${MAX_SKILL_BYTES} bytes in total`
    );
  }
}

function checkRelativePath(rel: string, folderName: string): void {
  const segments = rel.split("/");
  if (rel.includes("\\") || segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new SkillFormatError(
      "path-relative",
      `${folderName}/${rel}`,
      "file paths must be relative POSIX paths inside the folder"
    );
  }
}

/**
 * Parses a skill folder from its files, keyed by relative POSIX path. Dot
 * paths are dropped, the limits are checked, then SKILL.md is parsed.
 */
export function parseSkillFolder(
  files: ReadonlyMap<string, Uint8Array>,
  folderName: string
): SkillFolder {
  const kept = new Map<string, Uint8Array>();
  let bytes = 0;
  for (const rel of [...files.keys()].sort()) {
    if (isDotPath(rel)) continue;
    checkRelativePath(rel, folderName);
    const content = files.get(rel) as Uint8Array;
    kept.set(rel, content);
    bytes += content.byteLength;
  }
  checkLimits(kept.size, bytes, folderName);

  const skillMd = kept.get(SKILL_MD);
  if (skillMd === undefined) {
    throw new SkillFormatError(
      "skill-md-required",
      `${folderName}/${SKILL_MD}`,
      "a skill folder needs SKILL.md at its root"
    );
  }
  return { ...parseFrontmatter(skillMd, folderName), files: kept };
}

/**
 * Reads a skill folder from disk and parses it. The folder's own path may be
 * a symlink; anything inside it may not. The walk stops as soon as a limit is
 * crossed, so an oversized folder is never read in full.
 */
export async function readSkillFolder(dir: string): Promise<SkillFolder> {
  const folderName = path.basename(path.resolve(dir));
  const files = new Map<string, Uint8Array>();
  let bytes = 0;

  async function walk(rel: string): Promise<void> {
    const entries = await readdir(path.join(dir, rel), { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      const where = `${folderName}/${childRel}`;
      if (entry.isSymbolicLink()) {
        throw new SkillFormatError("no-symlinks", where, "symlinks are not allowed in a skill folder");
      }
      if (entry.isDirectory()) {
        await walk(childRel);
        continue;
      }
      if (!entry.isFile()) {
        throw new SkillFormatError("regular-files-only", where, "only regular files are allowed");
      }
      const { size } = await lstat(path.join(dir, childRel));
      bytes += size;
      checkLimits(files.size + 1, bytes, folderName);
      files.set(childRel, new Uint8Array(await readFile(path.join(dir, childRel))));
    }
  }

  await walk("");
  return parseSkillFolder(files, folderName);
}
