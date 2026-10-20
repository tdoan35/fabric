// ANY-86 T10 — run-folder retention: sweepRuns removes runs/* whose newest
// entry is older than the cutoff, on a fake clock, and never touches agent or
// project folders. Cases F7, F22–F25 from the cards.
import type { Stats } from "node:fs";
import * as fsp from "node:fs/promises";
import { chmod, lutimes, mkdir, mkdtemp, readdir, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { localFolders, RUN_FOLDER_RETENTION_MS, sweepRuns } from "../folders";
// scanMtime is imported dynamically inside F24a so this file also loads
// against pre-fix sources (where ../folders/retention exports no scanMtime):
// every case in it can then be checked red, case by case, on the exact
// implementation it predates.

// F24b's injection seam and F22's recording seam: retention talks to the
// platform `readdir`/`stat`/`lstat` from `node:fs/promises` — which the
// module mock intercepts at every source version, unlike the head-only
// `onLstat` visitor. While `injectReadFailure` is set, that one readdir
// rejects (F24b's EIO); while `observed.armed`, every stat/lstat/readdir
// lands its resolved first argument in `observed.paths` (F22's escape
// probe). Everything delegates untouched.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fsp>();
  const record = (arg0: unknown): void => {
    if (observed.armed) observed.paths.push(path.resolve(String(arg0)));
  };
  const platformReaddir = Object.assign(
    (...args: Parameters<typeof actual.readdir>): ReturnType<typeof actual.readdir> => {
      record(args[0]);
      return injectReadFailure && path.resolve(String(args[0])) === path.resolve(String(injectReadFailure.path))
        ? Promise.reject(injectReadFailure)
        : actual.readdir(...args);
    },
    { withFileTypes: (actual.readdir as unknown as { withFileTypes: unknown }).withFileTypes },
  );
  return {
    ...actual,
    readdir: platformReaddir,
    stat: (arg0: string): Promise<Stats> => {
      record(arg0);
      return actual.stat(arg0);
    },
    lstat: (arg0: string): Promise<Stats> => {
      record(arg0);
      return actual.lstat(arg0);
    },
  };
});

/** When set, the platform `readdir` fails with this error — F24b's EIO. */
let injectReadFailure: NodeJS.ErrnoException | undefined;
/** While armed, every platform stat/lstat/readdir lands here — F22's probe. */
const observed = { armed: false, paths: [] as string[] };
afterEach(() => {
  injectReadFailure = undefined;
  observed.armed = false;
  observed.paths = [];
});

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
  // them all: an escaping scan would target paths under `outside`. The head
  // `onLstat` visitor is inert against pre-fix sources, so the module mock's
  // recorder is armed for the sweep too — it sees the platform stat/readdir
  // calls at every source version.
  const stats: string[] = [];
  let removed: string[];
  try {
    observed.armed = true;
    removed = await Promise.race([
      sweepRuns(folders, { olderThanMs: 7 * DAY, now, onLstat: (abs) => stats.push(abs) }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("F22: sweep hung")), 5000)),
    ]);
  } finally {
    observed.armed = false;
  }

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

  // Containment over everything the sweep made the platform fs touch: the
  // runs root (its one listing) and the two run trees, nothing else. A
  // pre-F22 scan readdirs/stats through `outside` — the kernel resolves the
  // link, so the walk consults the external tree and its fresh file rescues
  // `linked`; the recorded offender names the escape.
  const runsRoot = path.join(folders.root, "runs");
  for (const observedPath of observed.paths) {
    const insideRuns =
      observedPath === runsRoot ||
      observedPath === looped ||
      observedPath.startsWith(looped + path.sep) ||
      observedPath === linked ||
      observedPath.startsWith(linked + path.sep);
    expect(insideRuns, `F22: fs call escaped the run trees: ${observedPath}`).toBe(true);
  }
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

test("F24a scanMtime never reads a failed directory enumeration as an empty listing: the scan is incomplete", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "folders-f24a-"));
  const { scanMtime } = await import("../folders/retention");
  const dir = path.join(root, "run");
  await mkdir(dir);
  await writeFile(path.join(dir, "stale.txt"), "stale");
  const now = Date.now();
  await utimes(dir, new Date(now - 8 * DAY), new Date(now - 8 * DAY));

  // The run root was already read (as the sweep's runs listing would); the
  // enumeration of the run's own entries fails.
  const { newest, complete } = await scanMtime(dir, undefined, async () => {
    throw Object.assign(new Error("F24a: injected EIO"), { code: "EIO", syscall: "readdir", path: dir });
  });

  // The stale root's own mtime was seen, but the children it could not list
  // might hold a fresh file: an incomplete scan may never vouch for the age.
  expect(newest).toBeLessThan(now - 7 * DAY);
  expect(complete).toBe(false);
});

test("F24b a stale run whose platform readdir fails with EIO is retained: the sweep never treats the failure as empty", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "folders-f24b-"));
  const folders = localFolders(root);
  const now = Date.now();

  // Stale by mtime, but holding a fresh file: read as an empty listing, the
  // scan would look complete and the run would be deleted with its contents.
  const keep = await folders.path({ kind: "run", name: "keep" });
  await writeFile(path.join(keep, "fresh.txt"), "fresh");
  await fsp.utimes(path.join(keep, "fresh.txt"), new Date(now), new Date(now));
  await utimes(keep, new Date(now - 8 * DAY), new Date(now - 8 * DAY));

  // Fail only the enumeration of the run's own directory, exactly as the
  // reviewer injected it: the runs listing still succeeds, so the sweep
  // reaches the run and must not read its failed readdir as empty.
  const injected = Object.assign(new Error("F24b: injected EIO"), {
    code: "EIO",
    syscall: "readdir",
    path: keep,
  });
  injectReadFailure = injected;
  let removed: string[] = [];
  let thrown: unknown;
  try {
    removed = await sweepRuns(folders, { olderThanMs: 7 * DAY, now });
  } catch (error) {
    thrown = error;
  }

  // Either remedy is acceptable: the run is kept, or the error propagates.
  expect(removed).toEqual([]);
  expect(await folders.exists({ kind: "run", name: "keep" })).toBe(true);
  expect(await readFile(path.join(keep, "fresh.txt"), "utf8")).toBe("fresh");
  if (thrown !== undefined) expect((thrown as NodeJS.ErrnoException).code).toBe("EIO");
});

test("F24c a stale run whose directory read fails with a real EACCES is retained, and permissions are restored afterwards", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "folders-f24c-"));
  const folders = localFolders(root);
  const now = Date.now();

  // Stale by every mtime the sweep can see, but `sub` holds a fresh file the
  // failed enumeration would hide.
  const keep = await folders.path({ kind: "run", name: "locked" });
  const sub = path.join(keep, "sub");
  await mkdir(sub);
  await writeFile(path.join(keep, "stale.txt"), "stale");
  await writeFile(path.join(sub, "fresh.txt"), "fresh");
  await age(keep, now - 8 * DAY);
  await fsp.utimes(path.join(sub, "fresh.txt"), new Date(now), new Date(now));

  // Make `sub` unreadable for the sweep: a real EACCES, the reviewer's second
  // probe. The permissions come back after the failed read — the sweep's next
  // act on this run is its `remove`, so the restore rides there, and the
  // deletion an empty-listing read produces actually lands.
  await chmod(sub, 0o300);
  let unreadable = false;
  try {
    await readdir(sub);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM") throw error;
    unreadable = true;
  }

  const realRemove = folders.remove.bind(folders);
  folders.remove = async (ref) => {
    await chmod(sub, 0o700);
    return realRemove(ref);
  };

  let removed: string[] = [];
  let thrown: unknown;
  try {
    removed = await sweepRuns(folders, { olderThanMs: 7 * DAY, now });
  } catch (error) {
    thrown = error;
  } finally {
    // The restore rides `remove` too; if the bug deleted the run anyway, the
    // directory is gone and there is nothing to restore.
    await chmod(sub, 0o700).catch(() => {});
  }
  if (!unreadable) return;

  // The failed enumeration did not look like an empty listing: kept.
  expect(removed).toEqual([]);
  expect(await folders.exists({ kind: "run", name: "locked" })).toBe(true);
  expect(await readFile(path.join(sub, "fresh.txt"), "utf8")).toBe("fresh");
  if (thrown !== undefined) {
    expect(["EACCES", "EPERM"]).toContain((thrown as NodeJS.ErrnoException).code);
  }
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

test("F25 a failed-rollback backup (`<run>.old-<rand>`) is skipped, preserved, and never aborts the sweep of later expired runs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "folders-f25-"));
  const folders = localFolders(root);
  const now = Date.now();
  const runsDir = path.join(root, "runs");

  // What a failed replace leaves beside its folder (local.ts): the rollback
  // backup `<name>.old-<rand>` — the only copy of the contents once the
  // restore rename cannot land — and a `<name>.unpack-<rand>` staging
  // sibling if the process died mid-swap. Aged past the cutoff.
  const backup = path.join(runsDir, "stuck.old-9af3c1d2");
  await mkdir(backup, { recursive: true });
  await writeFile(path.join(backup, "old.txt"), "old");
  const staging = path.join(runsDir, "stuck.unpack-1b2c3d4e");
  await mkdir(staging, { recursive: true });
  await writeFile(path.join(staging, "new.txt"), "new");
  await age(backup, now - 8 * DAY);
  await age(staging, now - 8 * DAY);

  // Expired runs sorting both before and after the artifacts: a sweep that
  // trips over the dotted name never reaches the later one.
  const early = await folders.path({ kind: "run", name: "alpha" });
  await writeFile(path.join(early, "out.txt"), "early");
  const later = await folders.path({ kind: "run", name: "z-later" });
  await writeFile(path.join(later, "out.txt"), "later");
  await age(early, now - 8 * DAY);
  await age(later, now - 8 * DAY);

  let thrown: unknown;
  const removed = await sweepRuns(folders, { olderThanMs: 7 * DAY, now }).catch((error: unknown) => {
    thrown = error;
    return [] as string[];
  });

  // Pre-fix the sweep handed the dotted name to folders.remove, died on its
  // FolderNameError, and stranded every expired run after it.
  expect(thrown).toBeUndefined();
  expect(removed).toEqual(["alpha", "z-later"]);
  expect(await folders.exists({ kind: "run", name: "alpha" })).toBe(false);
  expect(await folders.exists({ kind: "run", name: "z-later" })).toBe(false);

  // The recovery data itself is untouched: skipped, never swept.
  expect(await readFile(path.join(backup, "old.txt"), "utf8")).toBe("old");
  expect(await readFile(path.join(staging, "new.txt"), "utf8")).toBe("new");
  expect((await readdir(runsDir)).sort()).toEqual(["stuck.old-9af3c1d2", "stuck.unpack-1b2c3d4e"]);
});
