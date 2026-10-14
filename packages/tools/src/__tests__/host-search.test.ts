// ANY-73 X10 — search_files. The JS walker leg is always exercised (rg is
// forced off through the injected `which`, so no test depends on rg being
// installed); the rg backend's --json parser is tested against a fixture
// recorded from a real `rg --json` run (rg 15.1.0) committed under
// fixtures/host/ — begin/end/summary events must be skipped, and the
// output shape must match the walker's.
import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolScope } from "../define";
import { createRegistry } from "../registry";
import { hostTools, parseRgJson } from "../host";

type Match = { path: string; line: number; text: string };
type SearchResult = { matches: Match[]; truncated: boolean };

const registry = createRegistry(
  hostTools({ platform: "linux", env: { SHELL: "/bin/bash" }, which: () => false })
);

const tempDir = () => mkdtemp(join(tmpdir(), "any73-search-"));

const search = (args: Record<string, unknown>, runDir: string) =>
  registry
    .toolPort({ workspaceId: "w", streamId: "s", agentId: "a", runDir } satisfies ToolScope)
    .run("search_files", args, {}) as Promise<{ ok: boolean; result?: SearchResult; error?: string }>;

test("X10 search_files walks nested files, skips .git and node_modules, reports runDir-relative paths", async () => {
  const runDir = await tempDir();
  await writeFile(join(runDir, "top.txt"), "nope\nfabric near the top\n");
  await mkdir(join(runDir, "nested/deeper"), { recursive: true });
  await writeFile(join(runDir, "nested/deeper/inner.md"), "# title\nfabric deep inside\n");
  await mkdir(join(runDir, "node_modules/pkg"), { recursive: true });
  await writeFile(join(runDir, "node_modules/pkg/dep.js"), "fabric must not appear\n");
  await mkdir(join(runDir, ".git"), { recursive: true });
  await writeFile(join(runDir, ".git/config"), "fabric hidden in metadata\n");

  const res = await search({ pattern: "fabric" }, runDir);
  expect(res.ok).toBe(true);
  expect(res.result?.truncated).toBe(false);
  expect(res.result?.matches).toEqual([
    { path: "nested/deeper/inner.md", line: 2, text: "fabric deep inside" },
    { path: "top.txt", line: 2, text: "fabric near the top" },
  ]);
});

test("X10 search_files honors the glob filter", async () => {
  const runDir = await tempDir();
  await writeFile(join(runDir, "note.md"), "fabric in markdown\n");
  await writeFile(join(runDir, "note.txt"), "fabric in plain text\n");

  const res = await search({ pattern: "fabric", glob: "*.md" }, runDir);
  expect(res.ok).toBe(true);
  expect(res.result?.matches).toEqual([{ path: "note.md", line: 1, text: "fabric in markdown" }]);
});

test("X10 search_files caps at 200 matches and flags truncation", async () => {
  const runDir = await tempDir();
  const many = Array.from({ length: 250 }, (_, i) => `fabric hit number ${i + 1}`).join("\n");
  await writeFile(join(runDir, "many.txt"), `${many}\n`);

  const res = await search({ pattern: "fabric hit" }, runDir);
  expect(res.ok).toBe(true);
  expect(res.result?.truncated).toBe(true);
  expect(res.result?.matches).toHaveLength(200);
  expect(res.result?.matches[0]).toEqual({ path: "many.txt", line: 1, text: "fabric hit number 1" });
  expect(res.result?.matches[199]).toEqual({
    path: "many.txt",
    line: 200,
    text: "fabric hit number 200",
  });
});

test("X10 the rg --json parser yields the walker's { path, line, text } shape from recorded rg output", () => {
  const fixturePath = fileURLToPath(new URL("./fixtures/host/rg-basic.jsonl", import.meta.url));
  const recorded = readFileSync(fixturePath, "utf8");

  expect(parseRgJson(recorded)).toEqual([
    { path: "notes/alpha.txt", line: 2, text: "fabric tools run on the host" },
    { path: "notes/nested/beta.md", line: 2, text: "the fabric host shell streams lines" },
  ]);
});
