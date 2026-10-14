// ANY-75 M1 — importing skill folders: importSkills over a root of folders or
// a single folder (one bad folder never stops the others), and the
// `skills:import` script on a PGlite data dir.
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { openStore } from "@fabric/runtime";
import { describeDrivers } from "@fabric/runtime/testing";
import { ensureSkillsSchema, importSkills, skillsStore } from "../skills";

const FIXTURES = fileURLToPath(new URL("./fixtures/skills", import.meta.url));
const PACKAGE_DIR = fileURLToPath(new URL("../..", import.meta.url));
const WORKSPACE = "ws-import";
const run = promisify(execFile);

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** The fixture root plus `broken/` (SKILL.md without frontmatter), a folder
 * without SKILL.md and a loose file — the last two are not skill folders. */
async function mixedRoot(): Promise<string> {
  const root = await tempDir("memory-import-");
  await cp(FIXTURES, root, { recursive: true });
  await mkdir(path.join(root, "broken"));
  await writeFile(path.join(root, "broken", "SKILL.md"), "# No frontmatter here\n");
  await mkdir(path.join(root, "notes"));
  await writeFile(path.join(root, "notes", "README.md"), "# not a skill\n");
  await writeFile(path.join(root, "README.md"), "# skills root\n");
  return root;
}

describeDrivers("skills import (ANY-75 M1)", (h) => {
  test("K12 a root with two valid folders and one invalid imports two and reports one error", async () => {
    const store = await h.openStore();
    await ensureSkillsSchema(store);
    const skills = skillsStore(store, WORKSPACE);

    const results = await importSkills(skills, await mixedRoot(), { agentId: "dana" });
    expect(results).toHaveLength(3);
    expect(results.map((r) => [r.folder, r.status])).toEqual([
      ["broken", "error"],
      ["pdf-report", "created"],
      ["release-notes", "created"],
    ]);
    expect(results[0].message).toMatch(/frontmatter/);
    expect((await skills.list("dana")).map((s) => s.name)).toEqual(["pdf-report", "release-notes"]);

    const events = await store.readStream("agent:dana", { workspaceId: WORKSPACE });
    expect(events.map((e) => (e.payload as { origin: string; source: string }).origin)).toEqual([
      "import:pdf-report",
      "import:release-notes",
    ]);
    for (const event of events) expect(event.payload).toMatchObject({ source: "user" });

    const again = await importSkills(skills, await mixedRoot(), { agentId: "dana" });
    expect(again.map((r) => r.status)).toEqual(["error", "unchanged", "unchanged"]);
  });

  test("K12 a folder with its own SKILL.md imports just that folder", async () => {
    const store = await h.openStore();
    await ensureSkillsSchema(store);
    const skills = skillsStore(store, WORKSPACE);

    const results = await importSkills(skills, path.join(FIXTURES, "pdf-report"), { agentId: "dana" });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ folder: "pdf-report", status: "created", version: 1 });
    expect((await skills.list("dana")).map((s) => s.name)).toEqual(["pdf-report"]);
  });
});

/** `npm run skills:import` with RUNTIME_DATABASE_URL cleared, so `--pglite` decides. */
async function importScript(
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.RUNTIME_DATABASE_URL;
  try {
    const { stdout, stderr } = await run(
      "npm",
      ["run", "--silent", "skills:import", "--", ...args],
      { cwd: PACKAGE_DIR, env }
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    if (typeof failed.code !== "number") throw error;
    return { code: failed.code, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

const linesOf = (stdout: string): string[] => stdout.split("\n").filter((line) => line.trim() !== "");

describe("skills:import script (ANY-75 M1)", () => {
  test("K13 imports the fixtures root, then reports every folder unchanged on a second run", { timeout: 120_000 }, async () => {
    const pglite = await tempDir("memory-script-pglite-");

    const first = await importScript(["--pglite", pglite, "--agent", "dana", FIXTURES]);
    expect(first.stderr).toBe("");
    expect(first.code).toBe(0);
    expect(linesOf(first.stdout)).toEqual([
      expect.stringMatching(/^created pdf-report\b/),
      expect.stringMatching(/^created release-notes\b/),
      "imported: created=2 patched=0 unchanged=0 errors=0",
    ]);

    const second = await importScript(["--pglite", pglite, "--agent", "dana", FIXTURES]);
    expect(second.code).toBe(0);
    expect(linesOf(second.stdout)).toEqual([
      expect.stringMatching(/^unchanged pdf-report\b/),
      expect.stringMatching(/^unchanged release-notes\b/),
      "imported: created=0 patched=0 unchanged=2 errors=0",
    ]);
  });

  test("K13 an invalid folder exits 1, and the valid folders are still imported", { timeout: 120_000 }, async () => {
    const pglite = await tempDir("memory-script-pglite-");

    const result = await importScript(["--pglite", pglite, "--agent", "dana", await mixedRoot()]);
    expect(result.code).toBe(1);
    expect(linesOf(result.stdout)).toEqual([
      expect.stringMatching(/^error broken\b.*frontmatter/),
      expect.stringMatching(/^created pdf-report\b/),
      expect.stringMatching(/^created release-notes\b/),
      "imported: created=2 patched=0 unchanged=0 errors=1",
    ]);

    // The default workspace is `local`; the rows are really there.
    const store = await openStore({ driver: "pglite", dataDir: pglite });
    try {
      await ensureSkillsSchema(store);
      const names = (await skillsStore(store, "local").list("dana")).map((s) => s.name);
      expect(names).toEqual(["pdf-report", "release-notes"]);
    } finally {
      await store.close();
    }
  });

  test("K13 without RUNTIME_DATABASE_URL or --pglite the script refuses, saying to stop the server", { timeout: 60_000 }, async () => {
    const result = await importScript(["--agent", "dana", FIXTURES]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--pglite");
    expect(result.stderr).toContain("RUNTIME_DATABASE_URL");
    expect(result.stderr).toMatch(/stop the server/i);
  });
});
