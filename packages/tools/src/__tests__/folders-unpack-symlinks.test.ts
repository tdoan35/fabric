// ANY-118 — unpack's lexical symlink validation is defeated by a link chain
// (a→. then b→a/..): the lexical `inside()` check passes but the write follows
// the just-created links, so `b` resolves outside the folder and files escape.
// Cases F10–F13 from the card, plus F14/F15: the fix makes the writer refuse
// any entry whose path (or, for hardlinks, whose link target) runs through an
// existing symlink, instead of trusting lexics.
import { mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Header, Pack, ReadEntry } from "tar";
import { expect, test } from "vitest";
import { localFolders, type FolderRef } from "../folders";

function tempRoot(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

interface RawEntry {
  path: string;
  type: "File" | "Directory" | "SymbolicLink" | "Link";
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

test("F10 unpack of a a→. b→a/.. chain refuses the entry and writes nothing outside the folder", async () => {
  const root = await tempRoot("folders-f10-");
  const store = localFolders(root);
  const ref: FolderRef = { kind: "agent", name: "chain" };
  const dir = await store.path(ref);

  const archive = await tarball([
    { path: "a", type: "SymbolicLink", linkpath: "." },
    { path: "b", type: "SymbolicLink", linkpath: "a/.." },
    { path: "b/escaped5", type: "File", data: Buffer.from("P1-ESCAPED") },
  ]);
  await expect(store.unpack(ref, Readable.from([archive]))).rejects.toThrow(/refused/);

  // The escape the A4 probe caught: writeFileSync through `b` landed the
  // payload as agents/escaped5, next to the folder. It must not exist.
  const escaped = path.join(path.dirname(dir), "escaped5");
  await expect(stat(escaped), "agents/escaped5 must not exist").rejects.toThrow();
  expect(await readdir(path.dirname(dir)), "the kind dir holds only the folder").toEqual(["chain"]);
});

test("F11 a link to a real subdirectory with a file written beside it, not through it, still unpacks", async () => {
  const root = await tempRoot("folders-f11-");
  const store = localFolders(root);
  const ref: FolderRef = { kind: "agent", name: "legal" };
  const dir = await store.path(ref);

  const archive = await tarball([
    { path: "d", type: "Directory" },
    { path: "s", type: "SymbolicLink", linkpath: "d" },
    { path: "d/ok", type: "File", data: Buffer.from("fine") },
  ]);
  await expect(store.unpack(ref, Readable.from([archive]))).resolves.toBeUndefined();

  expect(await readFile(path.join(dir, "d", "ok"), "utf8")).toBe("fine");
  expect(await readFile(path.join(dir, "s", "ok"), "utf8")).toBe("fine");
});

test("F12 an entry whose parent directory is a pre-existing symlink in the folder is refused", async () => {
  const root = await tempRoot("folders-f12-");
  const store = localFolders(root);
  const ref: FolderRef = { kind: "agent", name: "prelink" };
  const dir = await store.path(ref);

  // A symlink left by an earlier archive: real dir + link to it.
  await mkdir(path.join(dir, "real"));
  await symlink("real", path.join(dir, "alias"));
  await writeFile(path.join(dir, "keep.txt"), "keep");

  const archive = await tarball([
    { path: "alias/through-link", type: "File", data: Buffer.from("via link") },
  ]);
  await expect(store.unpack(ref, Readable.from([archive]))).rejects.toThrow(/refused/);

  // The refusal is before the write: the link still points at the real dir
  // and nothing new appeared through it.
  expect(await readdir(path.join(dir, "real"))).toEqual([]);
  expect(await readFile(path.join(dir, "keep.txt"), "utf8")).toBe("keep");
});

test("F13 the Sprites write-back path (replace) with a hostile chain throws and leaves the old contents intact", async () => {
  const root = await tempRoot("folders-f13-");
  const store = localFolders(root);
  const ref: FolderRef = { kind: "run", name: "writeback" };
  const dir = await store.path(ref);
  await mkdir(path.join(dir, "sub"));
  await writeFile(path.join(dir, "a.txt"), "old-a");
  await writeFile(path.join(dir, "sub", "b.txt"), "bee");

  const hostile = await tarball([
    { path: "c.txt", type: "File", data: Buffer.from("sea") },
    { path: "a", type: "SymbolicLink", linkpath: "." },
    { path: "b", type: "SymbolicLink", linkpath: "a/.." },
    { path: "b/escaped5", type: "File", data: Buffer.from("P1-ESCAPED") },
  ]);
  await expect(store.unpack(ref, Readable.from([hostile]), { replace: true })).rejects.toThrow(/refused/);

  // The swap never happened: the old folder survives untouched, and the
  // staging scratch (plus anything the chain wrote through it) is gone.
  expect(await readdir(dir)).toEqual(["a.txt", "sub"]);
  expect(await readFile(path.join(dir, "a.txt"), "utf8")).toBe("old-a");
  expect(await readFile(path.join(dir, "sub", "b.txt"), "utf8")).toBe("bee");
  expect(await readdir(path.dirname(dir)), "the kind dir holds only the folder").toEqual(["writeback"]);
});

test("F14 a file entry landing on a chain symlink itself is refused and writes nothing outside", async () => {
  const root = await tempRoot("folders-f14-");
  const store = localFolders(root);
  const ref: FolderRef = { kind: "agent", name: "onto" };
  const dir = await store.path(ref);

  // No subpath needed: writeFile on `b` follows the chain just the same.
  const archive = await tarball([
    { path: "a", type: "SymbolicLink", linkpath: "." },
    { path: "b", type: "SymbolicLink", linkpath: "a/.." },
    { path: "b", type: "File", data: Buffer.from("P1-ESCAPED") },
  ]);
  await expect(store.unpack(ref, Readable.from([archive]))).rejects.toThrow(/refused/);

  const escaped = path.join(path.dirname(dir), "b");
  await expect(stat(escaped), "agents/b must not exist").rejects.toThrow();
  expect(await readdir(path.dirname(dir)), "the kind dir holds only the folder").toEqual(["onto"]);
});

test("F15 a hardlink entry whose target runs through a chain symlink is refused", async () => {
  const root = await tempRoot("folders-f15-");
  const store = localFolders(root);
  const ref: FolderRef = { kind: "agent", name: "hardlink" };
  const dir = await store.path(ref);

  // link(2) resolves the source path, so `h` would hardlink whatever the
  // chain resolves to — the lexical containment check cannot see that.
  const archive = await tarball([
    { path: "a", type: "SymbolicLink", linkpath: "." },
    { path: "b", type: "SymbolicLink", linkpath: "a/.." },
    { path: "h", type: "Link", linkpath: "b/ghost" },
  ]);
  await expect(store.unpack(ref, Readable.from([archive]))).rejects.toThrow(/refused/);

  expect(await readdir(path.dirname(dir)), "the kind dir holds only the folder").toEqual(["hardlink"]);
});
