// Run-folder retention (ANY-44 D2, T10): runs are scratch space — kept N days,
// then swept. Agents and projects persist; only runs/* are ever removed.
import { readdir, stat, rm } from "node:fs/promises";
import path from "node:path";
import type { FolderStore } from "./folders";

/** How long a run folder is kept: seven days. */
export const RUN_FOLDER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface SweepOptions {
  /** The cutoff age; defaults to RUN_FOLDER_RETENTION_MS. */
  olderThanMs?: number;
  /** Now, for tests; defaults to Date.now(). */
  now?: number;
}

/** The newest mtime anywhere under dir (the dir itself included); absent dirs come back as -1. */
async function newestMtime(dir: string): Promise<number> {
  let newest = -1;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const info = await stat(current).catch(() => undefined);
    if (info === undefined) continue;
    newest = Math.max(newest, info.mtimeMs);
    if (info.isDirectory()) {
      for (const child of await readdir(current)) stack.push(path.join(current, child));
    }
  }
  return newest;
}

/** Removes every `runs/*` folder whose newest file is older than the cutoff,
 * and returns the names it removed. Agent and project folders are never touched. */
export async function sweepRuns(folders: FolderStore, opts: SweepOptions = {}): Promise<string[]> {
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
    const newest = await newestMtime(path.join(runsDir, name));
    if (newest !== -1 && newest < cutoff) {
      await folders.remove({ kind: "run", name });
      removed.push(name);
    }
  }
  return removed;
}
