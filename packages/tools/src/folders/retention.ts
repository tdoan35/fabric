// Run-folder retention (ANY-44 D2, T10): runs are scratch space — kept N days,
// then swept. Agents and projects persist; only runs/* are ever removed.
import { readdir, lstat, rm } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import type { FolderStore } from "./folders";

/** How long a run folder is kept: seven days. */
export const RUN_FOLDER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** The most paths one scan may visit: a generous cap that keeps a symlinked
 * loop (or a hostile tree) from hanging the daily sweeper. */
export const SWEEP_MAX_ENTRIES = 10_000;

/** What a failed replace leaves beside the folder it was swapping (local.ts):
 * the rollback backup `<name>.old-<rand>` — the only copy of the contents
 * once the restore rename cannot land — and the staging dir
 * `<name>.unpack-<rand>` when the process died mid-swap. The sweep skips
 * both: they are recovery data, not run folders, and their dotted names are
 * not passable to `remove` (the FolderNameError would abort the sweep and
 * strand every later expired run). */
const REPLACE_ARTIFACT = /^[a-z][a-z0-9-]{0,39}\.(?:old|unpack)-[0-9a-f]+$/;

/** What one scan learned: the newest mtime seen, and whether it saw enough.
 * `complete` is false when the entry cap stopped the walk with paths still
 * unvisited, or when an enumeration or an entry's `lstat` failed — an
 * incomplete scan cannot vouch for the run's age, so the run is kept. */
export interface MtimeScan {
  newest: number;
  complete: boolean;
}

export interface SweepOptions {
  /** The cutoff age; defaults to RUN_FOLDER_RETENTION_MS. */
  olderThanMs?: number;
  /** Now, for tests; defaults to Date.now(). */
  now?: number;
}

/** One bounded walk of dir: parents before children, links never followed
 * (`lstat` only), a directory symlink — `loop -> .`, or one escaping the run
 * tree — treated as a leaf and never descended into, so the sweep cannot hang
 * or stat outside the tree. Every `lstat` attempt, failed or not, counts
 * against SWEEP_MAX_ENTRIES. Returns -1 for an absent dir. A failed directory
 * enumeration or a failed `lstat` stops the walk and marks it incomplete: the
 * entries it could not see may hold the run's newest file, so the run must be
 * kept. */
export async function scanMtime(
  dir: string,
  onLstat?: (abs: string) => void,
  listDir: (dir: string) => Promise<string[]> = readdir,
): Promise<MtimeScan> {
  let newest = -1;
  let visited = 0;
  let complete = true;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited >= SWEEP_MAX_ENTRIES) {
      complete = false;
      break;
    }
    // Every attempt counts against the cap, a failed one included.
    visited++;
    onLstat?.(current);
    let info: Stats;
    try {
      info = await lstat(current);
    } catch (error) {
      // An absent run dir is reported as such (newest -1); any other failed
      // lstat leaves an entry of unknown age, so the scan cannot vouch.
      if (current === dir && (error as NodeJS.ErrnoException)?.code === "ENOENT") break;
      complete = false;
      break;
    }
    newest = Math.max(newest, info.mtimeMs);
    // Only real directories are walked; a symlink to one is a leaf, so the
    // scan stays inside the run tree even with `loop -> .` present.
    if (info.isDirectory()) {
      let children: string[] | undefined;
      try {
        children = await listDir(current);
      } catch {
        // Never read a failed enumeration as "empty": keep this run.
        complete = false;
        break;
      }
      for (const child of children) stack.push(path.join(current, child));
    }
  }
  if (stack.length > 0) complete = false;
  return { newest, complete };
}

/** Removes every `runs/*` folder whose newest file is older than the cutoff,
 * and returns the names it removed. Agent and project folders are never
 * touched. A run is kept whenever the scan could not establish the age of
 * every entry (the cap truncated the walk, or an enumeration or an lstat
 * failed), so a fresh file the scan could not see never loses its folder.
 * A failed replace's backup/staging siblings (`.old-…`, `.unpack-…`) are
 * skipped and preserved: recovery data, never swept.
 * The per-folder scan takes an optional visitor for tests: every path the
 * walk is about to `lstat` (the only stat the sweep ever performs). */
export async function sweepRuns(
  folders: FolderStore,
  opts: SweepOptions & { onLstat?: (abs: string) => void } = {},
): Promise<string[]> {
  const olderThanMs = opts.olderThanMs ?? RUN_FOLDER_RETENTION_MS;
  const now = opts.now ?? Date.now();
  const cutoff = now - olderThanMs;
  const runsDir = path.join(folders.root, "runs");

  const names = await readdir(runsDir).catch((error: unknown) => {
    // An absent runs area has nothing to sweep; any other failure is a real
    // enumeration error and propagates (never an empty listing).
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [] as string[];
    throw error;
  });

  const removed: string[] = [];
  for (const name of names.sort()) {
    if (REPLACE_ARTIFACT.test(name)) continue; // recovery data: never scanned, never swept
    const { newest, complete } = await scanMtime(path.join(runsDir, name), opts.onLstat);
    if (complete && newest !== -1 && newest < cutoff) {
      await folders.remove({ kind: "run", name });
      removed.push(name);
    }
  }
  return removed;
}
