// ANY-86 T10 — run-folder retention: sweepRuns removes runs/* whose newest
// entry is older than the cutoff, on a fake clock, and never touches agent or
// project folders. Cases F7, F22 and F23 from the cards.
import { lutimes, mkdir, mkdtemp, readdir, readFile, symlink, utimes, writeFile } from "node:fs/promises";
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

test("F22 a run folder with a loop symlink (dot -> .) sweeps without hanging, bounded, and never stats outside the run", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "folders-f22-"));
  const folders = localFolders(root);
  const now = Date.now();

  // The external tree: a directory whose entries are all newer than the run
  // that links to it, so following the link would keep a stale run alive.
  const outside = await mkdtemp(path.join(tmpdir(), "folders-f22-outside-"));
  await writeFile(path.join(outside, "external.txt"), "external");

  // loop -> . : the pre-F22 scan recursed through it without bound.
  const looped = await folders.path({ kind: "run", name: "looped" });
  await writeFile(path.join(looped, "out.txt"), "looped");
  await symlink(".", path.join(looped, "loop"));
  await age(looped, now - 8 * DAY);
  // `utimes` follows links, so backdate the link entry itself with lutimes.
  await lutimes(path.join(looped, "loop"), new Date(now - 8 * DAY), new Date(now - 8 * DAY));

  // outside -> external dir: stale itself, but the target is fresh. The sweep
  // may not stat the target or it would keep the run.
  const linked = await folders.path({ kind: "run", name: "linked" });
  await writeFile(path.join(linked, "out.txt"), "linked");
  await symlink(outside, path.join(linked, "outside"));
  await age(linked, now - 8 * DAY);
  await lutimes(path.join(linked, "outside"), new Date(now - 8 * DAY), new Date(now - 8 * DAY));

  // The only stat the sweep performs is `lstat` on paths it targets. Record
  // them all: an escaping scan would target paths under `outside`.
  const stats: string[] = [];
  const removed = await Promise.race([
    sweepRuns(folders, { olderThanMs: 7 * DAY, now, onLstat: (abs) => stats.push(abs) }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("F22: sweep hung")), 5000)),
  ]);

  // Both stale runs go: the loop did not expand forever, the external tree
  // was not consulted (its fresh file did not rescue `linked`).
  expect(removed).toEqual(["linked", "looped"]);
  expect(await folders.exists({ kind: "run", name: "looped" })).toBe(false);
  expect(await folders.exists({ kind: "run", name: "linked" })).toBe(false);

  // Nothing outside runs/linked or runs/looped was ever stat-ed: in
  // particular no path resolves into the external tree or the runs root.
  for (const statPath of stats) {
    const insideTree =
      statPath === looped ||
      statPath.startsWith(looped + path.sep) ||
      statPath === linked ||
      statPath.startsWith(linked + path.sep);
    expect(insideTree, `stat outside the run tree: ${statPath}`).toBe(true);
    expect(statPath.startsWith(outside), `stat of the external target: ${statPath}`).toBe(false);
  }
  // The walk is bounded (a loop is a leaf, not an expansion).
  expect(stats.length).toBeLessThan(100);
});

test("F22b the entry cap is exercised, and a run whose scan it truncates is kept even when a fresh file sits beyond it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "folders-f22b-"));
  const folders = localFolders(root);
  const now = Date.now();

  const capped = await folders.path({ kind: "run", name: "capped" });
  // More entries than SWEEP_MAX_ENTRIES (kept local: the constant is not part
  // of the folders barrel). Names sort so the fresh file is visited last.
  const count = 10_040;
  for (let i = 0; i < count; i++) {
    await writeFile(path.join(capped, `entry-${String(i).padStart(5, "0")}.txt`), "x");
  }
  // Backdate everything, then leave one file fresh. The LIFO walk visits the
  // directory first, then each entry pushed in readdir order (a single
  // directory level pops it in reverse, so "entry-00000" is visited last):
  // with the cap at 10,000 that fresh file is never visited.
  await age(capped, now - 8 * DAY);
  await utimes(path.join(capped, "entry-00000.txt"), new Date(now), new Date(now));

  const stats: string[] = [];
  const removed = await sweepRuns(folders, { olderThanMs: 7 * DAY, now, onLstat: (abs) => stats.push(abs) });

  // The cap stopped the scan: exactly the cap's worth of entries were visited.
  expect(stats.length).toBe(10_000);
  expect(stats.includes(path.join(capped, "entry-00000.txt"))).toBe(false);
  // An incomplete scan cannot vouch for the run: it is kept.
  expect(removed).toEqual([]);
  expect(await folders.exists({ kind: "run", name: "capped" })).toBe(true);
  // The fresh file is still there: the originals were not deleted.
  expect(await readFile(path.join(capped, "entry-00000.txt"), "utf8")).toBe("x");
  expect(await readFile(path.join(capped, "entry-00001.txt"), "utf8")).toBe("x");
});

test("F23 an expired normal run folder is still swept exactly as today", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "folders-f23-"));
  const folders = localFolders(root);
  const now = Date.now();

  const doomed = await folders.path({ kind: "run", name: "doomed" });
  await mkdir(path.join(doomed, "nested"), { recursive: true });
  await writeFile(path.join(doomed, "nested", "deep.txt"), "deep");
  await age(doomed, now - 8 * DAY);

  const keeper = await folders.path({ kind: "run", name: "keeper" });
  await writeFile(path.join(keeper, "out.txt"), "keeper");
  await age(keeper, now - 6 * DAY);

  const removed = await sweepRuns(folders, { olderThanMs: 7 * DAY, now });
  expect(removed).toEqual(["doomed"]);
  expect(await folders.exists({ kind: "run", name: "doomed" })).toBe(false);
  expect(await folders.exists({ kind: "run", name: "keeper" })).toBe(true);
  // The newest-wins rule across nesting still holds: the deep file decides.
  expect((await readdir(path.join(root, "runs"))).sort()).toEqual(["keeper"]);
});
