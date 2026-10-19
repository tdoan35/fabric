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
  const raw = await readFile(path.join(root, "profiles", `${user}.v${version}.enc`));
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
 * A store that forces the checkout race the driver hides. A checkout's read
 * runs in the store's serialized transaction; the transaction is then done,
 * and its write is handed to a separate `write` transaction that parks until
 * every racer has parked (read the free row) — then they start together, one
 * own connection each, the READ COMMITTED interleaving Postgres allows. Every
 * other statement runs through the checkout's own transaction untouched.
 */
function racingStore(store: RuntimeStore, count: number): RuntimeStore {
  let parked = 0;
  let open: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const wrapped: RuntimeStore = {
    transaction: (fn) =>
      store.transaction(async (tx) => {
        const racing: RuntimeTx = {
          query: async (sql, params) => {
            const verb = sql.trim().split(/\s+/)[0]?.toLowerCase();
            const read = verb === "select" || !sql.includes("browser_profiles");
            // A checkout's write goes to its own connection after this (read-only)
            // transaction has ended: the reads stay serialized, the writes race.
            return read ? tx.query(sql, params) : Promise.resolve([]);
          },
          onCommit: (hook) => tx.onCommit(hook),
        };
        return fn(racing);
      }),
    write: (sql: string, params?: readonly unknown[]) => {
      parked += 1;
      return (async () => {
        if (parked >= count) open?.();
        await gate;
        return store.transaction((tx) => tx.query(sql, params));
      })();
    },
    readStream: (streamId, options) => store.readStream(streamId, options),
    close: () => store.close(),
  } as RuntimeStore & { write(sql: string, params?: readonly unknown[]): Promise<unknown[]> };
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
    const base = await h.openStore();
    await ensureBrowserProfilesSchema(base);
    const root = keep(await tempRoot("bprofile-l-root-"));
    const profiles = browserProfiles({
      store: racingStore(base, 2),
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
    const refusal = (lost[0] as PromiseRejectedResult).reason as Error;
    expect(refusal.message).toBe(`profile in use by ${loser}`);

    // The row names exactly the winner, and the loser cannot try again.
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

    // The row points at the successor's v1; no second version was committed.
    expect((await rowOf(store, "owner")).version).toBe(1);
    expect(await blobNames(root, "owner")).toEqual(["owner.v1.enc"]);

    // The successor's bytes are what the profile now holds: decryptable under
    // the row's AAD, never the slow writer's marker.
    const successor = await profiles.checkout("owner", { holder: "weaver", ttlMs });
    const dst = keep(await tempRoot("bprofile-l12-dst-"));
    await profiles.loadInto(successor.lease, new FakeSandbox(process.cwd()), dst);
    const landed = await tree(dst);
    expect(landed.get("Local State")).toEqual(await readFile(path.join(fastDir, "Local State")));
    expect(landed.get("Cookies")).not.toEqual(await readFile(path.join(slowDir, "Cookies")));

    // No foreign bytes remain anywhere in the profile dir: exactly the row's blob.
    const names = await blobNames(root, "owner");
    expect(names).toHaveLength(1);
    const rowVersion = (await rowOf(store, "owner")).version;
    expect(names[0]).toMatch(new RegExp(`^owner\\.v${rowVersion}\\.`));
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
    expect(names[0]).toMatch(/^owner\.v1\./);
    const survivors = await readBlob(root, workspaceId, masterKey, "owner", 1);
    expect(survivors.get("Local State")).toEqual(previous.get("Local State"));
    expect(survivors.get("Local State")).toEqual(
      await readFile(path.join(firstDir, "Local State"))
    );
    expect((await rowOf(store, "owner")).version).toBe(1);
  });
});
