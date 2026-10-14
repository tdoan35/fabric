// ANY-73 X7–X9, X13 — read_file / write_file / edit_file through the
// registry's ToolPort. Relative paths resolve against scope.runDir;
// absolute paths anywhere on the machine work (D11: unrestricted is the
// default; safety comes from gates, not isolation).
import { expect, test } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolScope } from "../define";
import { createRegistry } from "../registry";
import { hostTools } from "../host";

type PortResult<R = unknown> = { ok: boolean; result?: R; error?: string };

const registry = createRegistry(
  hostTools({ platform: "linux", env: { SHELL: "/bin/bash" }, which: () => false })
);

const tempDir = () => mkdtemp(join(tmpdir(), "any73-files-"));

const run = <R = unknown>(name: string, args: Record<string, unknown>, runDir: string) =>
  registry
    .toolPort({ workspaceId: "w", streamId: "s", agentId: "a", runDir } satisfies ToolScope)
    .run(name, args, {}) as Promise<PortResult<R>>;

test("X7 write_file creates nested parent directories and round-trips through read_file", async () => {
  const runDir = await tempDir();
  const written = await run<{ path: string; bytes: number }>(
    "write_file",
    { path: "notes/deep/topic.txt", content: "round trip\n" },
    runDir
  );
  expect(written.ok).toBe(true);
  expect(written.result?.bytes).toBe("round trip\n".length);
  expect(await readFile(join(runDir, "notes/deep/topic.txt"), "utf8")).toBe("round trip\n");

  const read = await run<{ text: string; totalLines: number; truncated: boolean }>(
    "read_file",
    { path: "notes/deep/topic.txt" },
    runDir
  );
  expect(read.ok).toBe(true);
  expect(read.result?.text).toBe("round trip\n");
  expect(read.result?.totalLines).toBe(1);
  expect(read.result?.truncated).toBe(false);
});

test("X8 edit_file: unique match replaced; zero and ambiguous matches rejected; replaceAll opts in", async () => {
  const runDir = await tempDir();
  await run("write_file", { path: "edit.txt", content: "alpha marker omega\n" }, runDir);

  const first = await run<{ path: string; replacements: number }>(
    "edit_file",
    { path: "edit.txt", old: "marker", new: "token" },
    runDir
  );
  expect(first.ok).toBe(true);
  expect(first.result?.replacements).toBe(1);
  expect(await readFile(join(runDir, "edit.txt"), "utf8")).toBe("alpha token omega\n");

  const zero = await run("edit_file", { path: "edit.txt", old: "absent", new: "x" }, runDir);
  expect(zero.ok).toBe(false);
  expect(zero.error).toContain("no match");

  await run("write_file", { path: "two.txt", content: "first hit then hit last\n" }, runDir);
  const two = await run("edit_file", { path: "two.txt", old: "hit", new: "miss" }, runDir);
  expect(two.ok).toBe(false);
  expect(two.error).toMatch(/2 matches/);

  const all = await run<{ replacements: number }>(
    "edit_file",
    { path: "two.txt", old: "hit", new: "miss", replaceAll: true },
    runDir
  );
  expect(all.ok).toBe(true);
  expect(all.result?.replacements).toBe(2);
  expect(await readFile(join(runDir, "two.txt"), "utf8")).toBe("first miss then miss last\n");
});

test("X9 read_file windows offset/limit over totalLines; a 300 KB file reports truncated", async () => {
  const runDir = await tempDir();
  const lines = Array.from({ length: 12 }, (_, i) => `line-${i + 1}`);
  await writeFile(join(runDir, "windowed.txt"), `${lines.join("\n")}\n`, "utf8");

  const windowed = await run<{ text: string; totalLines: number; truncated: boolean }>(
    "read_file",
    { path: "windowed.txt", offset: 3, limit: 4 },
    runDir
  );
  expect(windowed.ok).toBe(true);
  expect(windowed.result?.text).toBe("line-3\nline-4\nline-5\nline-6\n");
  expect(windowed.result?.totalLines).toBe(12);
  expect(windowed.result?.truncated).toBe(false);

  await writeFile(join(runDir, "big.txt"), "z".repeat(300 * 1024 + 7), "utf8");
  const capped = await run<{ text: string; truncated: boolean }>(
    "read_file",
    { path: "big.txt" },
    runDir
  );
  expect(capped.ok).toBe(true);
  expect(capped.result?.truncated).toBe(true);
  expect((capped.result?.text ?? "").length).toBeLessThanOrEqual(256 * 1024);
});

test("X13 relative paths resolve against runDir; absolute paths outside runDir work unrestricted", async () => {
  const runDir = await tempDir();
  const rel = await run<{ path: string }>(
    "write_file",
    { path: "rel.txt", content: "relative\n" },
    runDir
  );
  expect(rel.ok).toBe(true);
  expect(rel.result?.path).toBe(join(runDir, "rel.txt"));
  expect(existsSync(join(runDir, "rel.txt"))).toBe(true);

  const outside = join(await tempDir(), "outside-run.txt"); // a different tree
  const abs = await run<{ path: string }>(
    "write_file",
    { path: outside, content: "absolute\n" },
    runDir
  );
  expect(abs.ok).toBe(true);
  expect(await readFile(outside, "utf8")).toBe("absolute\n");

  const readBack = await run<{ text: string }>("read_file", { path: outside }, runDir);
  expect(readBack.ok).toBe(true);
  expect(readBack.result?.text).toBe("absolute\n");
});
