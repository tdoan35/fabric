// The local-disk FolderStore (ANY-44 D1): everything lives as plain files under
// one root — the app's data directory (FABRIC_WORK ?? ".data/work" at T19).
// pack/unpack go through the tar streams, and validation happens on the whole
// archive before the first byte is written, so a refusal anywhere is
// all-or-nothing; `replace` swaps through a sibling temp dir and a rename.
import { link, mkdir, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import type { Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { Pack, Parser, type ReadEntry } from "tar";
import { assertFolderRef, type FolderRef, type FolderStore } from "./folders";

const KIND_DIRS = { agent: "agents", project: "projects", run: "runs" } as const;

interface StagedEntry {
  path: string;
  type: string;
  mode?: number;
  linkpath?: string;
  data: Buffer;
}

/** Refused for good: the message says which entry and why. */
function refuse(entry: string, why: string): never {
  throw new Error(`folders: entry ${JSON.stringify(entry)} refused: ${why}`);
}

function localRel(entryPath: string): string[] {
  const raw = String(entryPath).replace(/\/+$/, "");
  if (raw === "") return [];
  if (raw.startsWith("/")) refuse(raw, "absolute paths must be relative to the folder");
  const segments = raw.split("/");
    const cleaned = segments.filter((s) => s !== ".");
  if (cleaned.length === 0) refuse(raw, "empty path");
  if (cleaned.some((s) => s === "..")) {
    throw new Error(`folders: entry ${JSON.stringify(entryPath)} refused: paths must match ^[a-z] relative, no ..`);
  }
  if (cleaned.some((s) => s.includes("\\") || s === "")) {
    throw new Error(`folders: entry ${JSON.stringify(entryPath)} refused: malformed path segment`);
  }
  return cleaned;
}

function inside(dir: string, candidate: string): boolean {
  const rel = path.relative(dir, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Reads the whole archive into memory: refusals are decided before anything
 * is written, and pack/unpack move folder-sized data by design. */
function readArchive(source: Readable): Promise<StagedEntry[]> {
  return new Promise((resolve, reject) => {
    const parser = new Parser();
    const entries: StagedEntry[] = [];
    let failed = false;
    const fail = (error: unknown): void => {
      if (failed) return;
      failed = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    parser.on("entry", (entry: ReadEntry) => {
      if ((entry as unknown as { meta?: boolean }).meta) {
        entry.resume();
        return;
      }
      const chunks: Buffer[] = [];
      entry.on("data", (chunk: Buffer) => chunks.push(chunk));
      entry.on("end", () => {
        entries.push({
          path: String(entry.path ?? ""),
          type: entry.type,
          mode: typeof entry.mode === "number" ? entry.mode : undefined,
          linkpath: typeof entry.linkpath === "string" ? entry.linkpath : undefined,
          data: Buffer.concat(chunks),
        });
      });
      entry.on("error", fail);
    });
    parser.on("error", fail);
    parser.on("end", () => {
      if (!failed) resolve(entries);
    });

    source.on("data", (chunk: unknown) => {
      if (!failed) parser.write(chunk as Buffer);
    });
    source.on("end", () => {
      if (!failed) parser.end();
    });
    source.on("error", fail);
  });
}

/** Turns staged entries into plans: paths are validated against `validateRoot`
 * (refusals throw here, before anything is written) and stored as segments so
 * the write root — the folder, or its staging sibling — is chosen at write time. */
interface Plan {
  segments: string[];
  type: string;
  mode?: number;
  linkpath?: string;
  data: Buffer;
}

function planEntries(staged: StagedEntry[], validateRoot: string): Plan[] {
  return staged.map((entry) => {
    const segments = localRel(entry.path);
    const type = entry.type;
    if (type === "SymbolicLink" || type === "Link") {
      const linkpath = entry.linkpath;
      if (linkpath === undefined || linkpath === "") {
        refuse(entry.path, `${type.toLowerCase()} without a target`);
      }
      if (!inside(validateRoot, path.resolve(validateRoot, linkpath))) {
        throw new Error(
          `folders: entry ${JSON.stringify(entry.path)} refused: link target ${JSON.stringify(
            linkpath
          )} is outside the folder`
        );
      }
    } else if (type !== "File" && type !== "Directory") {
      // Unknown types are carried as files; the bytes are the payload.
      return { segments, type: "File", mode: entry.mode, data: entry.data };
    }
    return { segments, type, mode: entry.mode, linkpath: entry.linkpath, data: entry.data };
  });
}

async function writePlans(plans: Plan[], writeRoot: string): Promise<void> {
  for (const plan of plans) {
    const abs = path.join(writeRoot, ...plan.segments);
    if (plan.segments.length === 0 || plan.type === "Directory") {
      await mkdir(abs, { recursive: true });
      continue;
    }
    await mkdir(path.dirname(abs), { recursive: true });
    if (plan.type === "SymbolicLink" || plan.type === "Link") {
      await rm(abs, { recursive: true, force: true });
      if (plan.type === "SymbolicLink") {
        await symlink(plan.linkpath!, abs);
      } else {
        await link(path.resolve(writeRoot, plan.linkpath!), abs);
      }
      continue;
    }
    await writeFile(abs, plan.data, { mode: plan.mode ?? 0o644 });
  }
}

/** Recursively lists every path under dir, parents before children, relative;
 * an absent dir is an empty list. */
async function listTree(dir: string, rel = "", out: string[] = []): Promise<string[]> {
  const entries = await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
    out.push(child);
    if (entry.isDirectory()) await listTree(dir, child, out);
  }
  return out;
}

/** The local-disk backend: plain directories under one root. */
export function localFolders(
  root: string,
  /** Rename seam for tests: swaps a replace in place. */
  renameFn: (from: string, to: string) => Promise<void> = rename,
): FolderStore {
  const base = path.resolve(root);
  const dirFor = (ref: FolderRef): string => path.join(base, KIND_DIRS[ref.kind], ref.name);

  return {
    root: base,

    async path(ref) {
      assertFolderRef(ref);
      const dir = dirFor(ref);
      await mkdir(dir, { recursive: true });
      return dir;
    },

    async exists(ref) {
      assertFolderRef(ref);
      try {
        await stat(dirFor(ref));
        return true;
      } catch {
        return false;
      }
    },

    async remove(ref) {
      assertFolderRef(ref);
      await rm(dirFor(ref), { recursive: true, force: true });
    },

    pack(ref) {
      assertFolderRef(ref);
      const dir = dirFor(ref);
      // noDirRecurse: every path is added explicitly, parents first, so the
      // archive carries exactly the tree on disk — including empty dirs.
      const packer = new Pack({ cwd: dir, gzip: true, noDirRecurse: true });
      void (async () => {
        const entries = await listTree(dir);
        entries.sort((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : 1));
        for (const entry of entries) packer.add(entry);
        packer.end();
      })().catch((error: unknown) => packer.destroy?.(error));
      return packer as unknown as Readable;
    },

    async unpack(ref, source, opts) {
      assertFolderRef(ref);
      const dir = dirFor(ref);
      const plans = planEntries(await readArchive(source), dir);
      if (opts?.replace === true) {
        // The staging dir exists even for an empty archive (no plans would
        // create it), so `replace` legitimately empties the folder.
        const staging = `${dir}.unpack-${randomBytes(4).toString("hex")}`;
        const old = `${dir}.old-${randomBytes(4).toString("hex")}`;
        let oldMoved = false;
        let done = false;
        try {
          await mkdir(staging, { recursive: true });
          await writePlans(plans, staging);
          // A destination that does not exist yet is simply created; a
          // failed move of a real one is fatal, leaving it in place.
          try {
            await renameFn(dir, old);
            oldMoved = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
          }
          await renameFn(staging, dir);
          done = true;
        } finally {
          if (!done) {
            // Failure: put the old contents back. The rollback rename only
            // succeeds into an absent `dir`; if something else now holds the
            // name, the backup is the only copy and must stay.
            let restored = !oldMoved;
            if (oldMoved) {
              try {
                await renameFn(old, dir);
                restored = true;
              } catch {
                restored = false;
              }
            }
            // Staging never holds original data either way.
            await rm(staging, { recursive: true, force: true }).catch(() => undefined);
            if (restored) {
              await rm(old, { recursive: true, force: true }).catch(() => undefined);
            } else {
              throw new Error(
                `folders: replace of ${ref.kind}/${ref.name} failed and its original contents were not restored; ` +
                  `they are kept at ${JSON.stringify(old)}`
              );
            }
          }
        }
        if (done && oldMoved) await rm(old, { recursive: true, force: true }).catch(() => undefined);
      } else {
        await writePlans(plans, dir);
      }
    },

    async size(ref) {
      assertFolderRef(ref);
      const dir = dirFor(ref);
      let total = 0;
      for (const rel of await listTree(dir)) {
        const info = await stat(path.join(dir, rel)).catch(() => undefined);
        if (info?.isFile()) total += info.size;
        else if (info?.isSymbolicLink()) total += info.size;
      }
      return total;
    },
  };
}
