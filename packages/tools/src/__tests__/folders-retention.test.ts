// ANY-86 T10 — run-folder retention: sweepRuns removes runs/* whose newest
// entry is older than the cutoff, on a fake clock, and never touches agent or
// project folders. Case F7 from the card.
import { mkdir, mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { localFolders, RUN_FOLDER_RETENTION_MS, sweepRuns } from "../folders";

const DAY = 24 * 60 * 60 * 1000;

/** Backdate a folder and everything inside it, so age is visible to the sweep. */
async function age(dir: string, mtime: number): Promise<void> {
  const when = new Date(mtime);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) await age(abs, mtime);
    await utimes(abs, when, when);
  }
  await utimes(dir, when, when);
}

test("F7 sweepRuns on a fake clock removes the run last written 8 days ago, keeps the 6-day one, and never sweeps agents or projects", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "folders-f7-"));
  const folders = localFolders(root);
  const now = Date.now();

  const stale = await folders.path({ kind: "run", name: "stale-run" });
  await writeFile(path.join(stale, "out.txt"), "stale");
  const fresh = await folders.path({ kind: "run", name: "fresh-run" });
  await writeFile(path.join(fresh, "out.log"), "fresh");
  await mkdir(path.join(fresh, "empty-sub"));

  const agent = await folders.path({ kind: "agent", name: "elder" });
  await writeFile(path.join(agent, "note.txt"), "agent");
  const project = await folders.path({ kind: "project", name: "archive" });
  await writeFile(path.join(project, "note.txt"), "project");

  await age(stale, now - 8 * DAY);
  await age(fresh, now - 6 * DAY);
  // Agents and projects older still: the sweep must leave them alone.
  await age(agent, now - 30 * DAY);
  await age(project, now - 30 * DAY);

  const removed = await sweepRuns(folders, { olderThanMs: 7 * DAY, now });
  expect(removed).toEqual(["stale-run"]);

  expect(await folders.exists({ kind: "run", name: "stale-run" })).toBe(false);
  expect(await folders.exists({ kind: "run", name: "fresh-run" })).toBe(true);
  expect(await folders.exists({ kind: "agent", name: "elder" })).toBe(true);
  expect(await folders.exists({ kind: "project", name: "archive" })).toBe(true);
});

test("F7b the default retention is seven days, and a missing runs directory sweeps nothing", async () => {
  expect(RUN_FOLDER_RETENTION_MS).toBe(7 * DAY);

  const root = await mkdtemp(path.join(tmpdir(), "folders-f7b-"));
  const folders = localFolders(root);
  await expect(sweepRuns(folders, {})).resolves.toEqual([]);
});
