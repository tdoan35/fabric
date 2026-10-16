// The browser-profile store (ANY-90 T12): one encrypted Chromium profile per
// user over the package-owned `browser_profiles` table, a one-job lease per
// profile, and load/save that stream through a sandbox's archive seam. The
// blob lives under the folder store's root at `profiles/<user>.v<version>.enc`
// — a gzip tar run through the card's own AES-256-GCM helper (./crypto).
// Plaintext never touches disk there: save pipes the sandbox tar through the
// exclusions, gzip and cipher straight into the file; load reverses the pipe
// into `sandbox.putArchive`. A save writes `v<version+1>` first and bumps the
// row second, so a crash mid-save leaves the last good profile standing and
// the next successful save sweeps the orphan.
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { createGunzip } from "node:zlib";
import { Header, Pack, Parser, ReadEntry, type ReadEntry as TarEntry } from "tar";
import type { RuntimeStore, RuntimeTx } from "@fabric/runtime";
import type { FolderStore } from "../folders";
import type { Sandbox } from "../sandbox";
import { decryptProfileStream, encryptProfileStream, profileAad } from "./crypto";

/** The compressed-size ceiling for a saved profile; a larger archive is
 * refused with its size and nothing is written. */
export const PROFILE_MAX_BYTES = 512 * 1024 * 1024;

/** One job at a time: the default lease length. */
const DEFAULT_TTL_MS = 30 * 60 * 1000;

/** Whole-directory exclusions, by path segment: the dir itself and anything
 * under it. `Service Worker` keeps everything but its CacheStorage. */
const EXCLUDED_DIR_SEGMENTS = ["Cache", "Code Cache", "GPUCache", "Crashpad"];
const EXCLUDED_LAST_SEGMENT = ["LOCK", "SingletonLock", "SingletonSocket", "SingletonCookie"];

export interface BrowserProfileLease {
  user: string;
  holder: string;
  expiresAt: Date;
}

export interface BrowserProfiles {
  /** The lease for one job on this profile. A live lease held by someone
   * else fails with `profile in use by <holder>`; an expired lease is taken
   * over; the same holder checking out again just refreshes the expiry. */
  checkout(
    user: string,
    options?: { holder: string; ttlMs?: number }
  ): Promise<{ lease: BrowserProfileLease; version: number }>;

  /** Extends the lease from now; a stale or expired lease is refused. */
  renew(lease: BrowserProfileLease, options?: { ttlMs?: number }): Promise<BrowserProfileLease>;

  /** Gives the profile back; a foreign lease is refused. */
  release(lease: BrowserProfileLease): Promise<void>;

  /** Decrypts the profile into `dir` via `sandbox.putArchive`. No profile
   * yet means an empty dir. A stale or foreign lease is refused. */
  loadInto(lease: BrowserProfileLease, sandbox: Sandbox, dir: string): Promise<void>;

  /** Reads `dir` via `sandbox.getArchive`, drops the exclusions, encrypts
   * and writes `v<version+1>`, then bumps the row in one transaction and
   * deletes the superseded blobs. Over PROFILE_MAX_BYTES: refused, with the
   * size, and nothing written. A stale or foreign lease is refused. */
  saveFrom(lease: BrowserProfileLease, sandbox: Sandbox, dir: string): Promise<void>;

  /** The sign-out-everywhere seam: the row and every blob file, gone. */
  remove(user: string): Promise<void>;
}

export interface BrowserProfilesOptions {
  store: RuntimeStore;
  workspaceId: string;
  /** Only `root` is used: blobs live under `<root>/profiles/`. */
  folders: Pick<FolderStore, "root">;
  masterKey: Uint8Array;
  /** Injectable clock for lease expiry (tests). */
  rig?: never;
  now?: () => Date;
  /** Override of PROFILE_MAX_BYTES (tests). */
  maxBytes?: number;
}

type Tx = RuntimeTx;

interface ProfileRow {
  version: number;
  size: number;
  lease_holder: string | null;
  lease_expires_at: string | Date | null;
}

/** The store's own schema, idempotent; safe to call on every boot. */
export async function ensureBrowserProfilesSchema(store: RuntimeStore): Promise<void> {
  await store.transaction((tx) =>
    tx.query(`create table if not exists browser_profiles (
      workspace_id text not null,
      user_id text not null,
      version integer not null,
      size integer not null,
      updated_at timestamptz not null,
      lease_holder text,
      lease_expires_at timestamptz,
      primary key (workspace_id, user_id)
    )`)
  );
}

function leaseError(user: string, holder: string | null, why: string): Error {
  const held = holder === null ? "" : ` held by ${JSON.stringify(holder)}`;
  return new Error(
    `browser profile: the ${JSON.stringify(user)} lease${held} is ${why}`
  );
}

/** User ids name files; keep them to safe characters. */
function assertUser(user: string): void {
  if (typeof user !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(user)) {
    throw new Error(`browser profile: invalid user ${JSON.stringify(String(user))}`);
  }
}

/** Files dropped on save, by normalized relative path. */
function excluded(rel: string): boolean {
  const segments = rel.split("/");
  for (const dir of EXCLUDED_DIR_SEGMENTS) {
    if (segments.includes(dir)) return true;
  }
  if (rel === "Service Worker/CacheStorage" || rel.startsWith("Service Worker/CacheStorage/")) {
    return true;
  }
  return EXCLUDED_LAST_SEGMENT.includes(segments[segments.length - 1]);
}

export function browserProfiles(options: BrowserProfilesOptions): BrowserProfiles {
  const { store, workspaceId } = options;
  const masterKey = options.masterKey;
  const now = options.now ?? ((): Date => new Date());
  const maxBytes = options.maxBytes ?? PROFILE_MAX_BYTES;
  const profilesDir = path.join(options.folders.root, "profiles");

  const encPath = (user: string, version: number): string =>
    path.join(profilesDir, `${user}.v${version}.enc`);

  const readRow = async (tx: Tx, user: string): Promise<ProfileRow | undefined> => {
    const rows = await tx.query(
      `select version, size, lease_holder, lease_expires_at from browser_profiles
       where workspace_id = $1 and user_id = $2`,
      [workspaceId, user]
    );
    return (rows[0] as unknown as ProfileRow | undefined) ?? undefined;
  };

  const requireLiveLease = async (lease: BrowserProfileLease): Promise<ProfileRow> => {
    if (lease === null || typeof lease !== "object" || typeof lease.user !== "string") {
      throw new Error("browser profile: not a lease");
    }
    assertUser(lease.user);
    const row = await store.transaction((tx) => readRow(tx, lease.user));
    if (!row || row.lease_holder === null || row.lease_holder !== lease.holder) {
      throw leaseError(lease.user, row?.lease_holder ?? null, "stale or foreign");
    }
    const expires = new Date(row.lease_expires_at ?? 0);
    if (!(expires.getTime() > now().getTime())) {
      throw leaseError(lease.user, lease.holder, "expired");
    }
    return row;
  };

  /** A valid empty archive: the two all-zero footer blocks. */
  const emptyTar = (): Readable => Readable.from([Buffer.alloc(1024)]);

  /** saveFrom's write side: sandbox tar in, exclusions dropped, the rest
   * gzipped, encrypted and streamed into `target`. Resolves with the bytes
   * written; over the size ceiling it fails and the caller cleans up. */
  const writeEncrypted = (
    source: Readable,
    target: string,
    lease: BrowserProfileLease,
    version: number
  ): Promise<number> =>
    new Promise<number>((resolve, reject) => {
      const pack = new Pack({ gzip: true });
      const plain = encryptProfileStream(
        masterKey,
        profileAad(workspaceId, lease.user, version),
        pack as unknown as AsyncIterable<Buffer>
      );
      const out = createWriteStream(target);

      let total = 0;
      let failed = false;
      const fail = (error: unknown): void => {
        if (failed) return;
        failed = true;
        plain.destroy();
        out.destroy();
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      const counter = new Transform({
        transform(chunk: Buffer, _enc, done) {
          total += chunk.byteLength;
          if (total > maxBytes) {
            done(
              new Error(
                `browser profile archive of ${total} bytes exceeds the ${maxBytes} byte limit (PROFILE_MAX_BYTES)`
              )
            );
            return;
          }
          done(null, chunk);
        }
      });

      let pending = 0;
      let ended = false;
      const maybeEnd = (): void => {
        if (ended && pending === 0) pack.end();
      };

      const parser = new Parser();
      parser.on("error", fail);
      source.on("error", fail);
      parser.on("entry", (entry: TarEntry) => {
        const rel = String(entry.path ?? "")
          .replace(/^\.\//, "")
          .replace(/\/+$/, "");
        if (rel === "" || excluded(rel)) {
          entry.resume();
          return;
        }
        pending += 1;
        const chunks: Buffer[] = [];
        entry.on("data", (chunk: Buffer) => chunks.push(chunk));
        entry.on("end", () => {
          const data = Buffer.concat(chunks);
          const isDir = entry.type === "Directory";
          const header = new Header({
            path: rel,
            type: isDir ? "Directory" : "File",
            mode: 0o644,
            size: isDir ? 0 : data.byteLength,
            mtime: new Date(),
          });
          const outEntry = new ReadEntry(header);
          pack.write(outEntry);
          outEntry.end(isDir ? Buffer.alloc(0) : data);
          pending -= 1;
          maybeEnd();
        });
        entry.on("error", fail);
      });
      source.pipe(parser);
      source.on("end", () => {
        ended = true;
        maybeEnd();
      });

      plain.on("error", fail);
      counter.on("error", fail);
      plain.pipe(counter).pipe(out);
      out.on("finish", () => resolve(total));
      out.on("error", fail);
    });

  const api: BrowserProfiles = {
    async checkout(user, opts) {
      assertUser(user);
      const holder = opts?.holder;
      if (typeof holder !== "string" || holder === "") {
        throw new Error("browser profile: checkout requires a holder");
      }
      const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
      return store.transaction(async (tx) => {
        const row = await readRow(tx, user);
        const at = now();
        const expires = new Date(at.getTime() + ttlMs);
        const live =
          row !== undefined &&
          row.lease_holder !== null &&
          new Date(row.lease_expires_at ?? 0).getTime() > at.getTime();
        if (live && row.lease_holder !== holder) {
          throw new Error(`profile in use by ${row.lease_holder}`);
        }
        if (row !== undefined) {
          await tx.query(
            `update browser_profiles set lease_holder = $3, lease_expires_at = $4, updated_at = $5
             where workspace_id = $1 and user_id = $2`,
            [workspaceId, user, holder, expires, at]
          );
          return { lease: { user, holder, expiresAt: expires }, version: row.version };
        }
        await tx.query(
          `insert into browser_profiles
             (workspace_id, user_id, version, size, updated_at, lease_holder, lease_expires_at)
           values ($1, $2, 0, 0, $3, $4, $5)`,
          [workspaceId, user, at, holder, expires]
        );
        return { lease: { user, holder, expiresAt: expires }, version: 0 };
      });
    },

    async renew(lease, opts = {}) {
      const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
      assertUser(lease.user);
      const expires = new Date(now().getTime() + ttlMs);
      const rows = await store.transaction((tx) =>
        tx.query(
          `update browser_profiles set lease_expires_at = $5
           where workspace_id = $1 and user_id = $2 and lease_holder = $3 and lease_expires_at > $4
           returning lease_expires_at`,
          [workspaceId, lease.user, lease.holder, now(), expires]
        )
      );
      if (rows.length === 0) throw leaseError(lease.user, lease.holder, "stale or expired");
      return {
        user: lease.user,
        holder: lease.holder,
        expiresAt: new Date(rows[0].lease_expires_at as string),
      };
    },

    async release(lease) {
      assertUser(lease.user);
      const rows = await store.transaction((tx) =>
        tx.query(
          `update browser_profiles set lease_holder = null, lease_expires_at = null
           where workspace_id = $1 and user_id = $2 and lease_holder = $3
           returning user_id`,
          [workspaceId, lease.user, lease.holder]
        )
      );
      if (rows.length === 0) throw leaseError(lease.user, lease.holder, "stale or foreign");
    },

    async loadInto(lease, sandbox, dir) {
      const row = await requireLiveLease(lease);
      if (row.version <= 0) {
        await sandbox.putArchive(dir, emptyTar());
        return;
      }
      const source = createReadStream(encPath(lease.user, row.version));
      const plain = decryptProfileStream(
        masterKey,
        profileAad(workspaceId, lease.user, row.version),
        source
      );
      const tar = plain.pipe(createGunzip());
      const forward = (error: Error): void => {
        tar.destroy(error);
      };
      source.on("error", forward);
      plain.on("error", forward);
      await sandbox.putArchive(dir, tar);
    },

    async saveFrom(lease, sandbox, dir) {
      const row = await requireLiveLease(lease);
      const version = row.version + 1;
      await mkdir(profilesDir, { recursive: true });
      const target = encPath(lease.user, version);
      let size: number;
      try {
        size = await writeEncrypted(sandbox.getArchive(dir), target, lease, version);
      } catch (error) {
        await rm(target, { force: true });
        throw error;
      }

      // The commit. A failure past this write is the crash window: the row
      // stays on the old version and the written file waits as an orphan.
      const at = now();
      const bumped = await store.transaction(async (tx) => {
        const rows = await tx.query(
          `update browser_profiles set version = $5, size = $6, updated_at = $7
           where workspace_id = $1 and user_id = $2 and lease_holder = $3 and lease_expires_at > $4
           returning version`,
          [workspaceId, lease.user, lease.holder, at, version, size, at]
        );
        if (rows.length === 0) throw leaseError(lease.user, lease.holder, "stale or expired");
        return rows[0];
      });
      void bumped;

      // Commit landed: the new blob is truth, every other blob of this user
      // (the previous version, and any orphan a crashed save left) goes.
      const keep = path.basename(target);
      const entries = await readdir(profilesDir).catch((): string[] => []);
      for (const name of entries) {
        if (name.startsWith(`${lease.user}.`) && name.endsWith(".enc") && name !== keep) {
          await rm(path.join(profilesDir, name), { force: true });
        }
      }
    },

    async remove(user) {
      assertUser(user);
      await store.transaction((tx) =>
        tx.query(`delete from browser_profiles where workspace_id = $1 and user_id = $2`, [
          workspaceId,
          user,
        ])
      );
      const entries = await readdir(profilesDir).catch((): string[] => []);
      for (const name of entries) {
        if (name.startsWith(`${user}.`)) {
          await rm(path.join(profilesDir, name), { force: true });
        }
      }
    },
  };
  return api;
}
