// ANY-86 T10 — the FolderStore port over the local-disk backend: the layout
// (agents/, projects/, runs/ under one root), the name rule, pack/unpack
// round-trips, refused entries, atomic replace and size. Cases F1–F4 and F8
// from the card; grants and retention live in their own files.
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Header, Pack, ReadEntry } from "tar";
import { expect, test } from "vitest";
import { localFolders, type FolderRef } from "../folders";

const NAME_RULE = "^[a-z][a-z0-9-]{0,39}$";

function tempRoot(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

interface RawEntry {
  path: string;
  type: "File" | "Directory" | "SymbolicLink";
  data?: Buffer;
  linkpath?: string;
}

/** A gzip tarball built from raw entries — for archives the store did not pack. */
async function tarball(entries: RawEntry[]): Promise<Buffer> {
  const pack = new Pack({ gzip: true, preservePaths: true });
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve, reject) => {
    pack.on("data", (chunk: Buffer) => chunks.push(chunk as Buffer));
    pack.on("end", resolve);
    pack.on("error", reject);
  });
  for (const entry of entries) {
    const header = new Header({
      path: entry.path,
      type: entry.type,
      mode: 0o644,
      size: entry.data?.byteLength ?? 0,
      linkpath: entry.linkpath,
      mtime: new Date(),
    });
    const readEntry = new ReadEntry(header);
    pack.write(readEntry);
    readEntry.end(entry.data ?? Buffer.alloc(0));
  }
  pack.end();
  await done;
  return Buffer.concat(chunks);
}

interface TreeNode {
  rel: string;
  dir?: boolean;
  link?: string;
  mode?: number;
  hex?: string;
}

async function treeOf(dir: string): Promise<TreeNode[]> {
  const out: TreeNode[] = [];
  const walk = async (rel: string): Promise<void> => {
    const abs = path.join(dir, rel);
    const info = await stat(abs);
    if (info.isDirectory()) {
      out.push({ rel, dir: true });
      for (const child of (await readdir(abs)).sort()) await walk(path.join(rel, child));
    } else {
      // Only regular files and links are expected here; modes round-trip or not.
      out.push({ rel, mode: info.mode, hex: (await readFile(abs)).toString("hex") });
    }
  };
  await walk("");
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

test("F1 path creates the agent, project and run folders, and names breaking the rule are errors that create nothing", async () => {
  const root = await tempRoot("folders-f1-");
  const folders = localFolders(root);

  expect(await folders.path({ kind: "agent", name: "researcher" })).toBe(
    path.join(root, "agents", "researcher")
  );
  expect(await folders.path({ kind: "project", name: "launch-plan" })).toBe(
    path.join(root, "projects", "launch-plan")
  );
  expect(await folders.path({ kind: "run", name: "r-1" })).toBe(path.join(root, "runs", "r-1"));
  for (const created of [
    path.join(root, "agents", "researcher"),
    path.join(root, "projects", "launch-plan"),
    path.join(root, "runs", "r-1"),
  ]) {
    expect((await stat(created)).isDirectory()).toBe(true);
  }

  for (const bad of ["../x", "A", "a".repeat(41), ""]) {
    await expect(folders.path({ kind: "agent", name: bad }), `agent ${JSON.stringify(bad)}`).rejects.toThrow(
      NAME_RULE
    );
    await expect(folders.path({ kind: "project", name: bad }), `project ${JSON.stringify(bad)}`).rejects.toThrow(
      NAME_RULE
    );
    await expect(folders.path({ kind: "run", name: bad }), `run ${JSON.stringify(bad)}`).rejects.toThrow(
      NAME_RULE
    );
  }
  // The boundary is inclusive: exactly 40 characters is a valid name.
  await expect(folders.path({ kind: "run", name: "a".repeat(40) })).resolves.toBe(
    path.join(root, "runs", "a".repeat(40))
  );

  // The invalid names created nothing anywhere.
  expect((await readdir(path.join(root, "agents"))).sort()).toEqual(["researcher"]);
  expect((await readdir(path.join(root, "projects"))).sort()).toEqual(["launch-plan"]);
  expect((await readdir(path.join(root, "runs"))).sort()).toEqual(["a".repeat(40), "r-1"]);
});

test("F2 pack then unpack round-trips bytes, nesting, an empty file and executable modes", async () => {
  const source = localFolders(await tempRoot("folders-f2-src-"));
  const target = localFolders(await tempRoot("folders-f2-dst-"));

  const src = await source.path({ kind: "agent", name: "poet" });
  await mkdir(path.join(src, "deep", "nest"), { recursive: true });
  await writeFile(path.join(src, "run.sh"), "#!/bin/sh\necho packed\n", { mode: 0o755 });
  await writeFile(path.join(src, "deep", "nest", "data.bin"), Buffer.from([0, 1, 2, 254, 255]));
  await writeFile(path.join(src, "empty.txt"), "");
  await mkdir(path.join(src, "empty-dir"));

  await target.path({ kind: "run", name: "restore" });
  await target.unpack({ kind: "run", name: "restore" }, source.pack({ kind: "agent", name: "poet" }));

  const dst = path.join(await target.root, "runs", "restore");
  expect(await treeOf(src)).toEqual(await treeOf(dst));

  const scriptBefore = await stat(path.join(src, "run.sh"));
  const scriptAfter = await stat(path.join(dst, "run.sh"));
  expect(scriptAfter.mode).toBe(scriptBefore.mode);
  expect(scriptAfter.mode & 0o100).not.toBe(0);
  expect((await readFile(path.join(dst, "empty.txt"))).length).toBe(0);
  expect(await readFile(path.join(dst, "deep", "nest", "data.bin"))).toEqual(
    Buffer.from([0, 1, 2, 254, 255])
  );
});

test("F3 unpack refusals: dot-dot, absolute paths and outside symlinks fail and leave the folder unchanged", async () => {
  const root = await tempRoot("folders-f3-");
  const folders = localFolders(root);
  const ref: FolderRef = { kind: "agent", name: "keeper" };
  const dir = await folders.path(ref);
  await writeFile(path.join(dir, "keep.txt"), "keep");

  const cases: Array<[string, RawEntry[]]> = [
    ["dot-dot path", [{ path: "../evil", type: "File", data: Buffer.from("x") }]],
    ["absolute path", [{ path: "/etc/x", type: "File", data: Buffer.from("x") }]],
    ["link outside", [{ path: "link", type: "SymbolicLink", linkpath: "/etc/passwd" }]],
  ];
  for (const [name, entries] of cases) {
    const archive = await tarball(entries);
    await expect(
      folders.unpack(ref, Readable.from([archive])),
      `${name}: unpack rejects`
    ).rejects.toThrow();
    expect(await readdir(dir), `${name}: folder unchanged`).toEqual(["keep.txt"]);
    expect(await readFile(path.join(dir, "keep.txt"), "utf8"), `${name}: bytes unchanged`).toBe("keep");
  }
});

test("F4 replace swaps atomically, and a refused entry after good ones leaves the old contents intact", async () => {
  const source = localFolders(await tempRoot("folders-f4-src-"));
  const target = localFolders(await tempRoot("folders-f4-dst-"));
  const ref: FolderRef = { kind: "run", name: "swap" };

  const src = await source.path({ kind: "agent", name: "fresh" });
  await mkdir(path.join(src, "sub"), { recursive: true });
  await writeFile(path.join(src, "a.txt"), "new-a");
  await writeFile(path.join(src, "sub", "b.txt"), "bee");

  const dir = await target.path(ref);
  await writeFile(path.join(dir, "a.txt"), "old-a");
  await writeFile(path.join(dir, "stale.txt"), "stale");

  await target.unpack(ref, source.pack({ kind: "agent", name: "fresh" }), { replace: true });

  // The swap removed what the archive does not have and put the archive's bytes in place.
  expect(await readdir(dir)).toEqual(["a.txt", "sub"]);
  expect(await readFile(path.join(dir, "a.txt"), "utf8")).toBe("new-a");
  expect(await readFile(path.join(dir, "sub", "b.txt"), "utf8")).toBe("bee");

  // A refusal after a good entry: nothing is written, the old contents survive.
  const mixed = await tarball([
    { path: "c.txt", type: "File", data: Buffer.from("sea") },
    { path: "../evil", type: "File", data: Buffer.from("x") },
  ]);
  await expect(target.unpack(ref, Readable.from([mixed]), { replace: true })).rejects.toThrow();
  expect(await readdir(dir)).toEqual(["a.txt", "sub"]);
  expect(await readFile(path.join(dir, "a.txt"), "utf8")).toBe("new-a");
  expect(await readFile(path.join(dir, "sub", "b.txt"), "utf8")).toBe("bee");
  expect(await readdir(path.join(dir, "sub"))).toEqual(["b.txt"]);
});

test("F8 size sums the file bytes across nesting and is zero for an empty folder", async () => {
  const root = await tempRoot("folders-f8-");
  const folders = localFolders(root);

  const sized = await folders.path({ kind: "project", name: "sized" });
  await writeFile(path.join(sized, "one.txt"), "abc");
  await mkdir(path.join(sized, "sub", "deeper"), { recursive: true });
  await writeFile(path.join(sized, "sub", "two.md"), "12345");
  await writeFile(path.join(sized, "sub", "deeper", "three"), "xy");
  expect(await folders.size({ kind: "project", name: "sized" })).toBe(3 + 5 + 2);

  await folders.path({ kind: "run", name: "hollow" });
  expect(await folders.size({ kind: "run", name: "hollow" })).toBe(0);
});
