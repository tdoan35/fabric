// Run-folder retention (ANY-44 D2, T10): runs are scratch space — kept N days,
// then swept. Agents and projects persist; only runs/* are ever removed.
import { readdir, lstat, rm } from "node:fs/promises";
import path from "node:path";
import type { FolderStore } from "./folders";

/** How long a run folder is kept: seven days. */
export const RUN_FOLDER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** The most paths one scan may visit: a generous cap that keeps a symlinked
 * loop (or a hostile tree) from hanging the daily sweeper. */
export const SWEEP_MAX_ENTRIES = 10_000;

export interface SweepOptions {
  /** The cutoff age; defaults to RUN_FOLDER_RETENTION_MS. */
  olderThanMs?: number;
  /** Now, for tests; defaults to Date.now(). */
  now?: number;
}

/** The newest mtime anywhere under dir, parents before children, links never
 * followed and the walk bounded (SWEEP_MAX_ENTRIES visits): a directory
 * symlink — `loop -> .`, or one escaping the run tree — counts as a leaf and
 * is never descended into, so the sweep cannot hang or stat outside the tree.
 * Absent dirs come back as -1. */
async function newestMtime(
  dir: string,
  onVisit?: (abs: string) => void,
): Promise<number> {
  let newest = -1;
  let visited = 0;
  const stack: string[] = [dir];
  while (stack.length > 0 && visited < SWEEP_MAX_ENTRIES) {
    const current = stack.pop()!;
    const info = await lstat(current).catch(() => undefined);
    if (info === undefined) continue;
    visited++;
    onVisit?.(current);
    newest = Math.max(newest, info.mtimeMs);
    // Only real directories are walked; a symlink to one is a leaf, so the
    // scan stays inside the run tree even with `loop -> .` present.
    if (info.isDirectory()) {
      for (const child of await readdir(current).catch(() => [])) {
        stack.push(path.join(current, child));
      }
    }
  }
  return newest;
}

/** Removes every `runs/*` folder whose newest file is older than the cutoff,
 * and returns the names it removed. Agent and project folders are never touched.
 * The per-folder scan takes an optional visitor for tests (every path the
 * newest-mtime walk touches, in visit order). */
export async function sweepRuns(
  folders: FolderStore,
  opts: SweepOptions & { onVisit?: (abs: string) => void } = {},
): Promise<string[]> {
  const olderThanMs = opts.olderThanMs ?? RUN_FOLDER_RETENTION_MS;
  const now = opts.now ?? Date.now();
  const cutoff = now - olderThanMs;
  const runsDir = path.join(folders.root, "runs");

  const names = await readdir(runsDir).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [] as string[];
    throw error;
  });

  const removed: string[] = [];
  for (const name of names.sort()) {
    const newest = await newestMtime(path.join(runsDir, name), opts.onVisit);
    if (newest !== -1 && newest < cutoff) {
      await folders.remove({ kind: "run", name });
      removed.push(name);
    }
  }
  return removed;
}
