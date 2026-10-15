// The FolderStore port (ANY-44 D1/D2, T10): work passes between agents by
// reference, through named folders under one root — agents/<id>, projects/<name>
// and runs/<id> — with grants narrowing access (see ./grants) and retention
// sweeping runs (see ./retention). The local-disk backend is ./local; an
// object-store backend arrives with ANY-46 behind this same port.
import { Readable } from "node:stream";

/** Which area of the root a reference names. */
export type FolderKind = "agent" | "project" | "run";

/** A folder reference: the kind plus its name. Agent ids use the registry's slug rule. */
export interface FolderRef {
  kind: FolderKind;
  name: string;
}

/** Folder and agent names: lowercase, start with a letter, then letters/digits/hyphens, 1–40 chars. */
export const FOLDER_NAME_PATTERN = "^[a-z][a-z0-9-]{0,39}$";

const KINDS: readonly FolderKind[] = ["agent", "project", "run"];

/** Thrown for a name (or kind) that breaks the rule; the message names the rule. */
export class FolderNameError extends Error {
  constructor(kind: string, name: string) {
    super(`invalid ${kind} name ${JSON.stringify(name)}: must match ${FOLDER_NAME_PATTERN}`);
    this.name = "FolderNameError";
  }
}

/** Checks one name against the rule; throws FolderNameError otherwise. */
export function assertFolderName(kind: FolderKind, name: string): void {
  if (typeof name !== "string" || !new RegExp(FOLDER_NAME_PATTERN).test(name)) {
    throw new FolderNameError(kind, String(name));
  }
}

/** Checks a whole reference; throws FolderNameError on a bad kind or name. */
export function assertFolderRef(ref: FolderRef): void {
  if (ref === null || typeof ref !== "object" || !KINDS.includes(ref.kind)) {
    throw new Error(`invalid folder reference: expected kind agent|project|run, got ${String(ref)}`);
  }
  assertFolderName(ref.kind, ref.name);
}

/** A folder area under the root, however it is stored. Paths are created on
 * first use; pack/unpack move whole trees by value; nothing here interprets
 * the contents. */
export interface FolderStore {
  /** The root every reference resolves under (absolute for the local backend). */
  readonly root: string;

  /** The folder's location, created on first use. */
  path(ref: FolderRef): Promise<string>;

  /** Whether the folder exists. */
  exists(ref: FolderRef): Promise<boolean>;

  /** Removes the folder and everything in it. Missing folders stay missing. */
  remove(ref: FolderRef): Promise<void>;

  /** A gzip tar of the folder's contents, relative paths only. */
  pack(ref: FolderRef): Readable;

  /** unpack: the whole folder, entries refused and all-or-nothing.
   * Entries that are absolute, contain `..`, or are links pointing outside
   * the folder are refused before anything is written. With `replace`, the
   * archive becomes the whole folder via a sibling temp dir and a rename —
   * files the archive lacks are removed; a failure anywhere leaves the old
   * contents intact. */
  unpack(ref: FolderRef, pack: Readable, opts?: { replace?: boolean }): Promise<void>;

  /** The folder's size in bytes, files only, nested included; an absent or empty folder is 0. */
  size(ref: FolderRef): Promise<number>;
}
