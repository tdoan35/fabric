// ANY-90 T12 — the browser-profile store: one encrypted profile per user
// (the package-owned `browser_profiles` table plus
// `<root>/profiles/<user>.v<version>.enc`), the one-job lease, and load/save
// through a sandbox's archive seam. Cases B1–B8 from the card, on both store
// drivers; the daemon-backed B9 lives in browser-profiles-docker.test.ts.
// The sandbox here is the card's fake: its archive methods read and write
// real temp dirs through plain tar streams.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PassThrough, type Readable } from "node:stream";
import { Header, Pack, Parser, ReadEntry, type ReadEntry as TarEntry } from "tar";

import { expect, test } from "vitest";
import type { RuntimeStore } from "@fabric/runtime";
import { describeDrivers } from "@fabric/runtime/testing";
import { localFolders } from "../folders";
import { browserProfiles, ensureBrowserProfilesSchema, PROFILE_MAX_BYTES } from "../browser-profiles";

const run = promisify(execFile);

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

/** Files the card excludes on save, as written in the fixture layout. */
const EXCLUDED = [
  "Cache/0001",
  "Code Cache/blockfile",
  "Crashpad/settings.dat",
  "Service Worker/CacheStorage/segment",
  "Default/LOCK",
  "SingletonLock",
  "SingletonSocket",
  "SingletonCookie",
];

interface Fixture {
  dir: string;
  cookieValue: string;
}

/** A Chromium-shaped profile dir: a Cookies file, Local State, and the lot. */
async function makeProfileDir(): Promise<Fixture> {
  const dir = await tempRoot("bprofile-src-");
  const cookieValue = `fabric-cookie-${randomUUID()}`;
  await mkdir(path.join(dir, "Default"), { recursive: true });
  await mkdir(path.join(dir, "Cache"), { recursive: true });
  await mkdir(path.join(dir, "Code Cache"), { recursive: true });
  await mkdir(path.join(dir, "Crashpad"), { recursive: true });
  await mkdir(path.join(dir, "Service Worker", "CacheStorage"), { recursive: true });
  await mkdir(path.join(dir, "Service Worker", "Database"), { recursive: true });
  await writeFile(
    path.join(dir, "Cookies"),
    Buffer.concat([
      Buffer.from("SQLite format 3\u0000", "utf8"),
      Buffer.from(`\n${cookieValue}\n`, "utf8"),
    ])
  );
  await writeFile(path.join(dir, "Local State"), JSON.stringify({ profile: "fixture" }));
  await writeFile(path.join(dir, "Default", "Preferences"), JSON.stringify({ homepage: "fabric.dev" }));
  await writeFile(path.join(dir, "Service Worker", "Database", "keep.db"), Buffer.from("keep me"));
  await writeFile(path.join(dir, "Cache", "0001"), Buffer.from("cache entry"));
  await writeFile(path.join(dir, "Code Cache", "blockfile"), Buffer.from("cached code"));
  await writeFile(path.join(dir, "Crashpad", "settings.dat"), Buffer.from("crash"));
  await writeFile(path.join(dir, "Service Worker", "CacheStorage", "segment"), Buffer.from("sw cache"));
  await writeFile(path.join(dir, "Default", "LOCK"), Buffer.from("lock"));
  await writeFile(path.join(dir, "SingletonLock"), Buffer.from("singleton"));
  await writeFile(path.join(dir, "SingletonSocket"), Buffer.from("socket"));
  await writeFile(path.join(dir, "SingletonCookie"), Buffer.from("cookie"));
  return { dir, cookieValue };
}

/** The card's fake Sandbox: plain (uncompressed) tar in and out, on real dirs. */
class FakeSandbox {
  readonly id = "fake-sandbox";

  constructor(readonly root: string) {}

  async exec(command: string): Promise<{ exitCode: number; timedOut: boolean; tail: string[] }> {
    try {
      const { stdout } = await run("bash", ["-lc", command], { cwd: this.root });
      return { exitCode: 0, timedOut: false, tail: stdout.split("\n") };
    } catch (error: unknown) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      const text = `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`;
      return { exitCode: failure.code ?? 1, timedOut: false, tail: text.split("\n") };
    }
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

/** A store whose Nth transaction throws: the crash window of B5, after the
 * new versioned file is written but before the version bump commits. */
function storeFailingTransactionN(store: RuntimeStore, n: number): RuntimeStore {
  let seen = 0;
  const wrapped: RuntimeStore = {
    transaction: (fn) => {
      seen += 1;
      if (seen === n) return Promise.reject(new Error(`crashed before commit ${seen}`));
      return store.transaction(fn);
    },
    readStream: (streamId, options) => store.readStream(streamId, options),
    close: () => store.close(),
  };
  return wrapped;
}

/** The one blob the row's version names (its suffix is the writer's uuid). */
async function blobFor(root: string, user: string, version: number): Promise<string> {
  const entries = await readdir(path.join(root, "profiles"));
  const names = entries.filter(
    (name) => name.startsWith(`${user}.v${version}.`) && name.endsWith(".enc")
  );
  if (names.length !== 1) {
    throw new Error(`expected one ${user}.v${version} blob, found ${JSON.stringify(names)}`);
  }
  return path.join(root, "profiles", names[0]);
}

describeDrivers("tools browser profiles (ANY-90 T12)", (h) => {
  const temps: string[] = [];
  const keep = (dir: string): string => {
    temps.push(dir);
    return dir;
  };

  interface Rig {
    profiles: ReturnType<typeof browserProfiles>;
    store: RuntimeStore;
    root: string;
    workspaceId: string;
    masterKey: Buffer;
  }

  const rig = (overrides: {
    now?: () => Date;
    maxBytes?: number;
    masterKey?: Buffer;
    workspaceId?: string;
  } = {}): Promise<Rig> =>
    (async () => {
      const store = await h.openStore();
      await ensureBrowserProfilesSchema(store);
      await ensureBrowserProfilesSchema(store); // idempotent, safe on every boot
      const root = keep(await tempRoot("bprofile-root-"));
      const masterKey = overrides.masterKey ?? randomBytes(32);
      const profiles = browserProfiles({
        store,
        workspaceId: overrides.workspaceId ?? "ws-b",
        folders: localFolders(root),
        masterKey,
        ...(overrides.now !== undefined ? { now: overrides.now } : {}),
        ...(overrides.maxBytes !== undefined ? { maxBytes: overrides.maxBytes } : {}),
      });
      return { profiles, store, root, workspaceId: overrides.workspaceId ?? "ws-b", masterKey };
    })();

  test("B1 round trip: saveFrom then loadInto reproduces the profile minus the exclusions", async () => {
    const { profiles, root } = await rig();
    const fixture = await makeProfileDir();
    keep(fixture.dir);
    const dst = keep(await tempRoot("bprofile-dst-"));
    const sandbox = new FakeSandbox(process.cwd());

    const { lease } = await profiles.checkout("owner", { holder: "scout" });
    await profiles.saveFrom(lease, sandbox, fixture.dir);
    await profiles.loadInto(lease, sandbox, dst);

    const landed = await tree(dst);
    const expected = await tree(fixture.dir);
    for (const gone of EXCLUDED) expected.delete(gone);
    expect([...landed.keys()].sort()).toEqual([...expected.keys()].sort());
    expect(landed.get("Cookies")).toEqual(expected.get("Cookies"));
    expect(landed.get("Local State")).toEqual(expected.get("Local State"));
    // The blob is the encrypted versioned file in the folder store.
    const enc = await readFile(await blobFor(root, "owner", 1));
    expect(enc.length).toBeGreaterThan(0);
  });

  test("B2 at rest: the .enc hides cookie and SQLite plaintext, binds to key and AAD", async () => {
    const { profiles, root } = await rig();
    const fixture = await makeProfileDir();
    keep(fixture.dir);
    const sandbox = new FakeSandbox(process.cwd());

    const owner = await profiles.checkout("owner", { holder: "scout" });
    await profiles.saveFrom(owner.lease, sandbox, fixture.dir);

    const raw = await readFile(await blobFor(root, "owner", 1));
    expect(raw.includes(Buffer.from(fixture.cookieValue, "utf8"))).toBe(false);
    expect(raw.includes(Buffer.from("SQLite format", "utf8"))).toBe(false);

    // A different master key cannot read the profile.
    const stranger = browserProfiles({
      store: await h.openStore(),
      workspaceId: "ws-b",
      folders: localFolders(root),
      masterKey: randomBytes(32),
    });
    const strangerDst = keep(await tempRoot("bprofile-stranger-"));
    await expect(stranger.loadInto(owner.lease, sandbox, strangerDst)).rejects.toThrow();

    // Swapping two users' blobs breaks the AAD binding on both.
    const alice = await profiles.checkout("alice", { holder: "scout" });
    await profiles.saveFrom(alice.lease, sandbox, fixture.dir);
    const ownerEnc = await blobFor(root, "owner", 1);
    const aliceEnc = await blobFor(root, "alice", 1);
    const ownerBytes = await readFile(ownerEnc);
    await writeFile(ownerEnc, await readFile(aliceEnc));
    await writeFile(aliceEnc, ownerBytes);
    const swappedDst = keep(await tempRoot("bprofile-swapped-"));
    await expect(profiles.loadInto(owner.lease, sandbox, swappedDst)).rejects.toThrow();
  });

  test("B3 lease, both drivers: second holder waits, expiry hands over, stale save refused", async () => {
    const ttlMs = 60_000;
    let nowMs = Date.parse("2026-01-01T00:00:00Z");
    const { profiles } = await rig({ now: () => new Date(nowMs) });
    const sandbox = new FakeSandbox(process.cwd());
    const fixture = await makeProfileDir();
    keep(fixture.dir);

    const first = await profiles.checkout("owner", { holder: "scout", ttlMs });
    expect(first.version).toBe(0);
    expect(first.lease.holder).toBe("scout");

    await expect(profiles.checkout("owner", { holder: "weaver", ttlMs })).rejects.toThrow(
      "profile in use by scout"
    );

    nowMs += ttlMs + 1;
    const second = await profiles.checkout("owner", { holder: "weaver", ttlMs });

    // The expired holder's save is refused and the version does not move.
    const dst = keep(await tempRoot("bprofile-stale-"));
    await expect(profiles.saveFrom(first.lease, sandbox, fixture.dir)).rejects.toThrow(/lease/);
    const again = await profiles.checkout("owner", { holder: "weaver", ttlMs });
    expect(again.version).toBe(second.version);
  });

  test("B4 release then checkout is granted; renew pushes the expiry out", async () => {
    const ttlMs = 60_000;
    let nowMs = Date.parse("2026-01-01T00:00:00Z");
    const { profiles } = await rig({ now: () => new Date(nowMs) });
    const sandbox = new FakeSandbox(process.cwd());
    const dst = keep(await tempRoot("bprofile-renew-"));

    const lease = await profiles.checkout("owner", { holder: "scout", ttlMs });
    nowMs += 1_000; // a renewal happens mid-lease, not at the same instant
    const renewed = await profiles.renew(lease.lease, { ttlMs });
    expect(renewed.expiresAt.getTime()).toBeGreaterThan(lease.lease.expiresAt.getTime());

    // The renewed lease outlives the original expiry.
    nowMs = Date.parse("2026-01-01T00:00:00Z") + 60_500;
    await profiles.loadInto(renewed, sandbox, dst); // no profile yet: an empty dir is fine

    await profiles.release(renewed);
    const next = await profiles.checkout("owner", { holder: "weaver", ttlMs });
    expect(next.version).toBe(0);
  });

  test("B5 crash mid-save: the old version survives and the next save clears the orphan", async () => {
    const { profiles, store, root, masterKey } = await rig();
    const sandbox = new FakeSandbox(process.cwd());
    const fixture = await makeProfileDir();
    keep(fixture.dir);

    const lease = await profiles.checkout("owner", { holder: "scout" });
    await profiles.saveFrom(lease.lease, sandbox, fixture.dir);
    const oldState = await readFile(path.join(fixture.dir, "Local State"));

    // Change the profile, then crash between the file write and the commit:
    // saveFrom's second transaction is the version bump.
    const newState = JSON.stringify({ rev: 2 });
    await writeFile(path.join(fixture.dir, "Local State"), newState);
    const crashy = browserProfiles({
      store: storeFailingTransactionN(store, 2),
      workspaceId: "ws-b",
      folders: localFolders(root),
      masterKey,
    });
    await expect(crashy.saveFrom(lease.lease, sandbox, fixture.dir)).rejects.toThrow(/commit/);

    // The row still points at the old version: loadInto yields the old bytes.
    const dst = keep(await tempRoot("bprofile-crash-"));
    await profiles.loadInto(lease.lease, sandbox, dst);
    expect(await readFile(path.join(dst, "Local State"))).toEqual(oldState);

    // The written-but-uncommitted v2 file is the orphan; it is still there...
    const profilesDir = path.join(root, "profiles");
    const orphan = (await readdir(profilesDir)).filter(
      (name) => name.startsWith("owner.") && !name.startsWith("owner.v1.")
    );
    expect(orphan).toHaveLength(1);
    expect(orphan[0]).toMatch(/^owner\.v2\.[0-9a-f-]+\.enc$/);

    // ...and the next successful save writes its own v2 file and clears
    // every stray: exactly the row's version remains.
    await profiles.saveFrom(lease.lease, sandbox, fixture.dir);
    const later = await profiles.checkout("owner", { holder: "scout" });
    expect(later.version).toBe(2);
    const left = await readdir(profilesDir);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(/^owner\.v2\.[0-9a-f-]+\.enc$/);
    const after = keep(await tempRoot("bprofile-crash-after-"));
    await profiles.loadInto(later.lease, sandbox, after);
    expect(await readFile(path.join(after, "Local State"))).toEqual(Buffer.from(newState));
  });

  test("B6 no profile yet: loadInto creates an empty dir at version 0", async () => {
    const { profiles } = await rig();
    const dst = keep(await tempRoot("bprofile-empty-"));
    const sandbox = new FakeSandbox(process.cwd());

    const lease = await profiles.checkout("owner", { holder: "scout" });
    expect(lease.version).toBe(0);
    await profiles.loadInto(lease.lease, sandbox, dst);
    await expect(readdir(path.join(dst))).resolves.toEqual([]);
  });

  test("B7 over-size archive: refused with the size, nothing written", async () => {
    expect(PROFILE_MAX_BYTES).toBe(512 * 1024 * 1024);
    const { profiles, root } = await rig({ maxBytes: 100 });
    const fixture = await makeProfileDir();
    keep(fixture.dir);
    const sandbox = new FakeSandbox(process.cwd());

    const lease = await profiles.checkout("owner", { holder: "scout" });
    await expect(profiles.saveFrom(lease.lease, sandbox, fixture.dir)).rejects.toThrow(
      /of \d+ bytes exceeds the 100 byte limit/
    );
    const again = await profiles.checkout("owner", { holder: "scout" });
    expect(again.version).toBe(0);
    const left = await readdir(path.join(root, "profiles")).catch(() => [] as string[]);
    expect(left.filter((name) => name.startsWith("owner."))).toEqual([]);
  });

  test("B8 remove: row and files gone, next checkout starts at version 0", async () => {
    const { profiles, root } = await rig();
    const fixture = await makeProfileDir();
    keep(fixture.dir);
    const sandbox = new FakeSandbox(process.cwd());

    const lease = await profiles.checkout("owner", { holder: "scout" });
    await profiles.saveFrom(lease.lease, sandbox, fixture.dir);
    expect((await tree(path.join(root, "profiles"))).size).toBeGreaterThan(0);

    await profiles.remove("owner");

    const next = await profiles.checkout("owner", { holder: "weaver" });
    expect(next.version).toBe(0);
    const left = await readdir(path.join(root, "profiles"));
    expect(left.filter((name) => name.startsWith("owner."))).toEqual([]);
  });
});
