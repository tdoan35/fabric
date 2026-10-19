// ANY-123 — the one-job lease's two races: a checkout that reads a free row and
// then updates it unconditionally (two Postgres transactions both win), and a
// save that writes a predictable `v<version+1>.enc` before its holder-rechecked
// commit (a slow expired writer clobbers its successor). Cases L10–L13, on both
// store drivers. The L10 race is made deterministic through a driver wrapper
// that holds each transaction open between its last read and its write, which
// is the READ COMMITTED interleaving Postgres allows and PGlite's serialized
// connection hides. L12/L13 hook the sandbox archive stream so the lease expires
// mid-write, and assert on the bytes on disk.
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { Header, Pack, Parser, ReadEntry, type ReadEntry as TarEntry } from "tar";

import { expect, test } from "vitest";
import type { RuntimeStore, RuntimeTx } from "@fabric/runtime";
import { describeDrivers } from "@fabric/runtime/testing";
import { localFolders } from "../folders";
import { browserProfiles, ensureBrowserProfilesSchema } from "../browser-profiles";
import { decryptProfileStream, profileAad } from "../browser-profiles/crypto";

function tempRoot(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

/** A directory tree as `relative path -> contents`, files only. */
async function tree(dir: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(path.join(dir, rel), { withFileTypes: true });
    for (const item of entries) {
      const child = rel === "" ? item.name : `${rel}/${item.name}`;
      if (item.isDirectory()) {
        await walk(child);
      } else {
        files.set(child, await readFile(path.join(dir, child)));
      }
    }
  };
  await walk("");
  return files;
}

/** A small Chromium-shaped profile dir holding a single marker file. */
async function profileDir(marker: string): Promise<string> {
  const dir = await tempRoot("bprofile-l-src-");
  await mkdir(path.join(dir, "Default"), { recursive: true });
  await writeFile(path.join(dir, "Local State"), JSON.stringify({ marker }));
  await writeFile(path.join(dir, "Cookies"), Buffer.from(marker, "utf8"));
  return dir;
}

/** A sandbox whose archive methods read and write real dirs through plain tar. */
class FakeSandbox {
  readonly id = "fake-sandbox";

  constructor(readonly root: string) {}

  async exec(): Promise<{ exitCode: number | null; timedOut: boolean; tail: string[] }> {
    return { exitCode: 0, timedOut: false, tail: [] };
  }

  async putArchive(dir: string, archive: Readable): Promise<void> {
    const dest = path.resolve(this.root, dir);
    await mkdir(dest, { recursive: true });
    const staged: { rel: string; type: string; data: Buffer }[] = [];
    await new Promise<void>((resolve, reject) => {
      const parser = new Parser();
      const fail = (error: unknown): void =>
        reject(error instanceof Error ? error : new Error(String(error)));
      archive.on("error", fail);
      parser.on("error", fail);
      parser.on("entry", (entry: TarEntry) => {
        const rel = String(entry.path ?? "")
          .replace(/^\.\//, "")
          .replace(/\/+$/, "");
        if (rel === "") {
          entry.resume();
          return;
        }
        if (entry.type === "Directory") {
          staged.push({ rel, type: "dir", data: Buffer.alloc(0) });
          entry.resume();
          return;
        }
        const chunks: Buffer[] = [];
        entry.on("data", (chunk: Buffer) => chunks.push(chunk));
        entry.on("end", () => staged.push({ rel, type: "file", data: Buffer.concat(chunks) }));
        entry.on("error", fail);
      });
      parser.on("finish", () => resolve());
      archive.pipe(parser);
    });
    for (const item of staged) {
      const target = path.join(dest, ...item.rel.split("/"));
      if (item.type === "dir") {
        await mkdir(target, { recursive: true });
      } else {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, item.data);
      }
    }
  }

  getArchive(dir: string): Readable {
    const source = path.resolve(this.root, dir);
    const pack = new Pack();
    const out = new PassThrough();
    pack.pipe(out);
    void (async () => {
      const walk = async (rel: string): Promise<void> => {
        const items = await readdir(path.join(source, rel), { withFileTypes: true });
        for (const item of items) {
          const child = rel === "" ? item.name : `${rel}/${item.name}`;
          if (item.isDirectory()) {
            await walk(child);
          } else if (item.isFile()) {
            const data = await readFile(path.join(source, child));
            const entry = new ReadEntry(
              new Header({
                path: child,
                type: "File",
                mode: 0o644,
                size: data.byteLength,
                mtime: new Date(),
              })
            );
            pack.write(entry);
            entry.end(data);
          }
        }
      };
      await walk("");
      pack.end();
    })();
    return out;
  }
}

/** The decrypted archive of `<root>/profiles/<user>.v<version>.enc` as a
 * `relative path -> contents` map; a wrong version, key or AAD throws. */
async function readBlob(
  root: string,
  workspaceId: string,
  masterKey: Buffer,
  user: string,
  version: number
): Promise<Map<string, Buffer>> {
  const names = await blobNames(root, user);
  const own = names.find((name) => name.startsWith(`${user}.v${version}.`));
  if (own === undefined) throw new Error(`no blob for ${user} v${version}`);
  const raw = await readFile(path.join(root, "profiles", own));
  const plain = decryptProfileStream(
    masterKey,
    profileAad(workspaceId, user, version),
    Readable.from([raw])
  );
  const gunzip = plain.pipe(createGunzip());
  const files = new Map<string, Buffer>();
  await new Promise<void>((resolve, reject) => {
    const parser = new Parser();
    const fail = (error: unknown): void =>
      reject(error instanceof Error ? error : new Error(String(error)));
    gunzip.on("error", fail);
    parser.on("error", fail);
    parser.on("entry", (entry: TarEntry) => {
      const rel = String(entry.path ?? "")
        .replace(/^\.\//, "")
        .replace(/\/+$/, "");
      if (rel === "" || entry.type === "Directory") {
        entry.resume();
        return;
      }
      const chunks: Buffer[] = [];
      entry.on("data", (chunk: Buffer) => chunks.push(chunk));
      entry.on("end", () => files.set(rel, Buffer.concat(chunks)));
      entry.on("error", fail);
    });
    parser.on("finish", () => resolve());
    gunzip.pipe(parser);
  });
  return files;
}

/** Every blob file of `user` under `<root>/profiles`, sorted. */
async function blobNames(root: string, user: string): Promise<string[]> {
  const entries = await readdir(path.join(root, "profiles")).catch((): string[] => []);
  return entries.filter((name) => name.startsWith(`${user}.`) && name.endsWith(".enc")).sort();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A store with Postgres's READ COMMITTED rule over `browser_profiles`, on
 * in-memory rows: a statement reads the row as committed, and an update
 * re-checks its `where` against the row at that moment (Postgres's
 * EvalPlanQual), so a checkout whose read saw a free row refuses when its
 * write lands second. That is the interleaving PGlite's single serialized
 * connection hides. Reads wait until both racers have read the free row; each
 * transaction stages writes that land in the order they were issued, not when
 * the transaction ends.
 */
function racingStore(): RuntimeStore & {
  seed(row: Record<string, unknown>): void;
} {
  type Row = {
    version: number;
    size: number;
    updated_at: Date | null;
    lease_holder: string | null;
    lease_expires_at: Date | null;
  };
  const table = new Map<string, Row>();
  const key = (workspaceId: unknown, userId: unknown): string =>
    `${String(workspaceId)}/${String(userId)}`;

  let open: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let racers = 0;
  let parked = 0;

  const execute = (text: string, params: readonly unknown[]): Array<Record<string, unknown>> => {
    const k = key(params[0], params[1]);
    if (text.startsWith("select")) {
      const row = table.get(k);
      return row === undefined ? [] : [{ ...row }];
    }
    if (text.startsWith("insert")) {
      if (table.has(k)) {
        const error = new Error(
          `duplicate key value violates unique constraint "browser_profiles_pkey"`
        );
        (error as Error & { code: string }).code = "23505";
        throw error;
      }
      table.set(k, {
        version: Number(params[2] ?? 0),
        size: Number(params[3] ?? 0),
        updated_at: new Date(String(params[4])),
        lease_holder: String(params[5]),
        lease_expires_at: new Date(String(params[6])),
      });
      return [];
    }
    const current = table.get(k);
    if (current === undefined) return [];
    if (text.includes("set lease_holder")) {
      const holder = String(params[2]);
      const expires = new Date(String(params[3]));
      const at = new Date(String(params[4]));
      const free =
        current.lease_holder === null ||
        current.lease_holder === holder ||
        current.lease_expires_at === null ||
        current.lease_expires_at.getTime() <= at.getTime();
      if (!free) return [];
      table.set(k, { ...current, lease_holder: holder, lease_expires_at: expires, updated_at: at });
      return [{ ...table.get(k)! }];
    }
    if (text.includes("set version")) {
      if (current.lease_holder !== String(params[2])) return [];
      const expires = current.lease_expires_at;
      if (expires === null || expires.getTime() <= new Date(String(params[3])).getTime()) return [];
      table.set(k, {
        ...current,
        version: Number(params[4]),
        size: Number(params[5]),
        updated_at: new Date(String(params[6])),
      });
      return [{ ...table.get(k)! }];
    }
    if (text.includes("set lease_holder = null")) {
      if (current.lease_holder !== String(params[2])) return [];
      table.set(k, { ...current, lease_holder: null, lease_expires_at: null });
      return [{ user_id: String(params[1]) }];
    }
    if (text.includes("set lease_expires_at")) {
      if (current.lease_holder !== String(params[2])) return [];
      const expires = current.lease_expires_at;
      const at = new Date(String(params[3]));
      if (expires === null || !(expires.getTime() > at.getTime())) return [];
      const extended = new Date(String(params[4]));
      table.set(k, { ...current, lease_expires_at: extended });
      return [{ lease_expires_at: extended }];
    }
    return [];
  };

  const writes: Array<{ text: string; params: readonly unknown[] }> = [];
  const wrapped: RuntimeStore & { seed(row: Record<string, unknown>): void } = {
    seed(row) {
      table.set(key(row.workspace_id, row.user_id), {
        version: Number(row.version),
        size: Number(row.size),
        updated_at: new Date(String(row.updated_at)),
        lease_holder: row.lease_holder === null ? null : String(row.lease_holder),
        lease_expires_at:
          row.lease_expires_at === null ? null : new Date(String(row.lease_expires_at)),
      });
    },
    transaction: async (fn) => {
      racers += 1;
      const mine = racers;
      // Only the first two transactions are the racers in L10's Promise.all;
      // any later call (a third checkout in the assertions) is plain.
      const contested = mine <= 2;
      let first = true;
      const value = await fn({
        query: async (sql, params = []) => {
          const text = sql.replace(/\s+/g, " ").trim();
          if (contested && first) {
            // Both racers read the free row before either writes.
            first = false;
            parked += 1;
            if (parked >= 2) open?.();
            await gate;
          }
          if (text.startsWith("select")) return execute(text, params);
          // The primary key is the table's arbiter: a second insert fails at
          // once, and the whole transaction rolls back with it.
          if (text.startsWith("insert")) {
            return execute(text, params);
          }
          // An update checks its `where` now (Postgres's re-check) and stages
          // its rows for commit.
          const rows = execute(text, params);
          writes.push({ text, params });
          return rows;
        },
        onCommit: async () => undefined,
      });
      return value;
    },
    readStream: () => Promise.resolve([]),
    close: () => Promise.resolve(),
  };
  return wrapped;
}

/** A sandbox whose `getArchive` runs `before` once its first chunk has been
 * handed to the save's pipeline, then (optionally) fails the stream. */
class HookedSandbox extends FakeSandbox {
  constructor(
    root: string,
    private readonly before: () => Promise<void>,
    private readonly failAtEnd = false
  ) {
    super(root);
  }

  override getArchive(dir: string): Readable {
    const inner = super.getArchive(dir);
    const out = new PassThrough();
    let first = true;
    inner.on("data", (chunk: Buffer) => {
      out.write(chunk);
      if (first) {
        first = false;
        void this.before();
      }
    });
    inner.on("end", () => {
      if (this.failAtEnd) out.destroy(new Error("sandbox archive read failed"));
      else out.end();
    });
    inner.on("error", (error) => out.destroy(error));
    return out;
  }
}

describeDrivers("tools browser-profile lease races (ANY-123)", (h) => {
  const temps: string[] = [];
  const keep = (dir: string): string => {
    temps.push(dir);
    return dir;
  };
  const workspaceId = "ws-l";

  interface Rig {
    profiles: ReturnType<typeof browserProfiles>;
    store: RuntimeStore;
    root: string;
    masterKey: Buffer;
  }

  const rig = async (options: {
    store?: RuntimeStore;
    now?: () => Date;
  } = {}): Promise<Rig> => {
    const store = options.store ?? (await h.openStore());
    await ensureBrowserProfilesSchema(store);
    const root = keep(await tempRoot("bprofile-l-root-"));
    const masterKey = randomBytes(32);
    const profiles = browserProfiles({
      store,
      workspaceId,
      folders: localFolders(root),
      masterKey,
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    return { profiles, store, root, masterKey };
  };

  const rowOf = async (
    store: RuntimeStore,
    user: string
  ): Promise<{ version: number; lease_holder: string | null }> => {
    const rows = await store.transaction((tx) =>
      tx.query(
        `select version, lease_holder from browser_profiles where workspace_id = $1 and user_id = $2`,
        [workspaceId, user]
      )
    );
    return rows[0] as unknown as { version: number; lease_holder: string | null };
  };

  test("L10 two concurrent checkouts: exactly one wins, the other refuses in use", async () => {
    const root = keep(await tempRoot("bprofile-l-root-"));
    const base = racingStore();
    // A profile with no lease (released or expired long ago): both checkouts
    // take the read-then-update branch this card's race lives in. The seed is
    // not a racer; the next `race` calls are.
    base.seed({
      workspace_id: workspaceId,
      user_id: "owner",
      version: 0,
      size: 0,
      updated_at: new Date("2025-12-01T00:00:00Z"),
      lease_holder: null,
      lease_expires_at: null,
    });
    const profiles = browserProfiles({
      store: base,
      workspaceId,
      folders: localFolders(root),
      masterKey: randomBytes(32),
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    const results = await Promise.allSettled([
      profiles.checkout("owner", { holder: "scout", ttlMs: 60_000 }),
      profiles.checkout("owner", { holder: "weaver", ttlMs: 60_000 }),
    ]);

    // Today both checkouts read "available" and both update unconditionally:
    // two winners, no refusal.
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    const winner = (won[0] as PromiseFulfilledResult<{ lease: { holder: string } }>).value;
    const loser = winner.lease.holder === "scout" ? "weaver" : "scout";
    // The loser is refused *in use* by the winner: the row now names one holder.
    expect((await rowOf(base, "owner")).lease_holder).toBe(winner.lease.holder);
    await expect(profiles.checkout("owner", { holder: loser, ttlMs: 60_000 })).rejects.toThrow(
      "profile in use"
    );
  });

  test("L11 checkout after lease expiry succeeds and reports the previous holder gone", async () => {
    let nowMs = Date.parse("2026-01-01T00:00:00Z");
    const now = (): Date => new Date(nowMs);
    const { profiles } = await rig({ now });
    const sandbox = new FakeSandbox(process.cwd());
    const fixture = keep(await profileDir("expiry"));
    const ttlMs = 60_000;

    const first = await profiles.checkout("owner", { holder: "scout", ttlMs });
    await expect(profiles.checkout("owner", { holder: "weaver", ttlMs })).rejects.toThrow(
      "profile in use by scout"
    );

    nowMs += ttlMs + 1;
    const second = await profiles.checkout("owner", { holder: "weaver", ttlMs });
    expect(second.lease.holder).toBe("weaver");
    expect(second.lease.expiresAt.getTime()).toBe(nowMs + ttlMs);
    expect(second.version).toBe(first.version);

    // The predecessor is gone: its save is refused, its re-checkout refused.
    await expect(profiles.saveFrom(first.lease, sandbox, fixture)).rejects.toThrow(/stale|expired/);
    await expect(profiles.checkout("owner", { holder: "scout", ttlMs })).rejects.toThrow(
      "profile in use by weaver"
    );
  });

  test("L12 a save whose lease expires mid-write cannot clobber its successor's blob", async () => {
    let nowMs = Date.parse("2026-01-01T00:00:00Z");
    const now = (): Date => new Date(nowMs);
    const { profiles, store, root, masterKey } = await rig({ now });
    const ttlMs = 60_000;
    const slowDir = keep(await profileDir("slow-writer"));
    const fastDir = keep(await profileDir("successor"));

    // The slow writer holds the lease and starts writing; the archive hook then
    // pushes the clock past its expiry and lets a successor commit v1 first.
    let fastDone: () => void = () => undefined;
    const fastSettled = new Promise<void>((resolve) => {
      fastDone = resolve;
    });
    const sandbox = new HookedSandbox(process.cwd(), async () => {
      nowMs += ttlMs + 1;
      const successor = await profiles.checkout("owner", { holder: "weaver", ttlMs });
      await profiles.saveFrom(successor.lease, new FakeSandbox(process.cwd()), fastDir);
      fastDone();
    });

    const slowLease = await profiles.checkout("owner", { holder: "scout", ttlMs });
    const slow = profiles.saveFrom(slowLease.lease, sandbox, slowDir);
    await expect(slow).rejects.toThrow(/stale|expired/);
    await fastSettled;

    // The row points at the successor's v1; no second version was committed,
    // and the profile dir holds exactly one blob: the row's version's.
    expect((await rowOf(store, "owner")).version).toBe(1);
    const names = await blobNames(root, "owner");
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^owner\.v1\.[0-9a-f-]+\.enc$/);

    // The successor's bytes are what the profile now holds: decryptable under
    // the row's AAD, never the slow writer's marker.
    const successor = await profiles.checkout("owner", { holder: "weaver", ttlMs });
    const dst = keep(await tempRoot("bprofile-l12-dst-"));
    await profiles.loadInto(successor.lease, new FakeSandbox(process.cwd()), dst);
    const landed = await tree(dst);
    expect(landed.get("Local State")).toEqual(await readFile(path.join(fastDir, "Local State")));
    expect(landed.get("Cookies")).not.toEqual(await readFile(path.join(slowDir, "Cookies")));

    // No foreign bytes remain anywhere in the profile dir: exactly the row's blob.
    const rowVersion = (await rowOf(store, "owner")).version;
    const rowBlob = await readBlob(root, workspaceId, masterKey, "owner", rowVersion);
    expect(rowBlob.get("Local State")).toEqual(await readFile(path.join(fastDir, "Local State")));
  });

  test("L13 saveFrom cleanup on failure deletes only the failed writer's own file", async () => {
    let nowMs = Date.parse("2026-01-01T00:00:00Z");
    const now = (): Date => new Date(nowMs);
    const { profiles, store, root, masterKey } = await rig({ now });
    const ttlMs = 60_000;
    const firstDir = keep(await profileDir("first"));
    const failingDir = keep(await profileDir("failing"));

    const first = await profiles.checkout("owner", { holder: "scout", ttlMs });
    await profiles.saveFrom(first.lease, new FakeSandbox(process.cwd()), firstDir);
    const previous = await readBlob(root, workspaceId, masterKey, "owner", 1);

    // The second save starts writing, stalls until its lease expires, then the
    // archive stream fails: its cleanup must delete only its own partial blob.
    const sandbox = new HookedSandbox(
      process.cwd(),
      async () => {
        nowMs += ttlMs + 1;
        await sleep(25);
      },
      true
    );
    await expect(profiles.saveFrom(first.lease, sandbox, failingDir)).rejects.toThrow();

    // The previous version survives byte-for-byte and still decrypts; the
    // failed writer's own file is gone.
    const names = await blobNames(root, "owner");
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^owner\.v1\.[0-9a-f-]+\.enc$/);
    const survivors = await readBlob(root, workspaceId, masterKey, "owner", 1);
    expect(survivors.get("Local State")).toEqual(previous.get("Local State"));
    expect(survivors.get("Local State")).toEqual(
      await readFile(path.join(firstDir, "Local State"))
    );
    expect((await rowOf(store, "owner")).version).toBe(1);
  });
});
