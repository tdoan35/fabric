// ANY-73 X2–X6, X11 — the host shell tool, called through the registry's
// ToolPort (the path tool.exec takes), so failures surface as the port's
// { ok: false } and streaming rides io.onLine. POSIX execution; Windows
// shell choice is covered purely by X1's detection table.
import { expect, test } from "vitest";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolScope } from "../define";
import { createRegistry } from "../registry";
import { hostTools } from "../host";

type ShellResult = { exitCode: number | null; timedOut: boolean; tail: string[] };
type PortResult<R = unknown> = { ok: boolean; result?: R; error?: string };

const tools = hostTools({
  platform: "linux",
  env: { SHELL: "/bin/bash" },
  which: () => false,
});
const registry = createRegistry(tools);

const tempDir = () => mkdtemp(join(tmpdir(), "any73-shell-"));

/** One shell call in `runDir`, collecting the streamed lines. */
const shell = async (command: string, extra: Record<string, unknown> = {}, runDir: string) => {
  const lines: string[] = [];
  const res = (await registry
    .toolPort({ workspaceId: "w", streamId: "s", agentId: "a", runDir } satisfies ToolScope)
    .run("shell", { command, ...extra }, { onLine: (line) => lines.push(line) })) as PortResult<ShellResult>;
  return { res, lines };
};
test("X11 metadata table: every host tool declares the exact effect, gate, kind and step", () => {
  expect(tools.map((tool) => tool.name).sort()).toEqual([
    "edit_file",
    "read_file",
    "search_files",
    "shell",
    "write_file",
  ]);
  expect(registry.meta("shell")).toEqual({
    effect: "rerunnable",
    gate: "mode",
    kind: "command",
    step: "host",
  });
  expect(registry.meta("read_file")).toEqual({
    effect: "read",
    gate: "none",
    kind: "read",
    step: "host",
  });
  expect(registry.meta("write_file")).toEqual({
    effect: "idempotent",
    gate: "mode",
    kind: "edit",
    step: "host",
  });
  expect(registry.meta("edit_file")).toEqual({
    effect: "rerunnable",
    gate: "mode",
    kind: "edit",
    step: "host",
  });
  expect(registry.meta("search_files")).toEqual({
    effect: "read",
    gate: "none",
    kind: "read",
    step: "host",
  });
});

test("X2 shell streams stdout line by line in arrival order and exits 0", async () => {
  const { res, lines } = await shell("printf 'a\\nb\\n'", {}, await tempDir());
  expect(res.ok).toBe(true);
  expect(lines).toEqual(["a", "b"]);
  expect(res.result?.exitCode).toBe(0);
  expect(res.result?.timedOut).toBe(false);
});

test("X3 a non-zero exit is a normal result, not a tool error", async () => {
  const { res } = await shell("exit 3", {}, await tempDir());
  expect(res.ok).toBe(true);
  expect(res.result?.exitCode).toBe(3);
});

test("X4 timeout kills the whole process tree within 3 s", { timeout: 15_000 }, async () => {
  const runDir = await tempDir();
  const command = "sleep 30 & echo $! > grandchild.pid; sleep 30";
  const started = Date.now();
  const { res } = await shell(command, { timeoutMs: 500 }, runDir);

  expect(res.ok).toBe(true);
  expect(res.result?.timedOut).toBe(true);
  expect(Date.now() - started).toBeLessThan(3_000);

  // The background child shared the detached group; it must be gone too.
  const grandchild = Number(await readFile(join(runDir, "grandchild.pid"), "utf8"));
  expect(Number.isInteger(grandchild)).toBe(true);
  expect(() => process.kill(grandchild, 0)).toThrow(/ESRCH/);
});

test("X5 with no cwd the command runs in scope.runDir, created if missing", async () => {
  const runDir = join(await tempDir(), "nested", "run"); // does not exist yet
  const { lines } = await shell("pwd", {}, runDir);
  expect(lines[0]).toBe(runDir);
  expect((await stat(runDir)).isDirectory()).toBe(true);
});

test("X6 tail keeps the last 50 lines and caps each line at 2,000 chars", { timeout: 15_000 }, async () => {
  // 500 numbered lines, then one 5,000-char line: tail = 49 numbers + the cap.
  const command = `seq 1 500; printf -v pad '%*s' 5000 ''; printf '%s\\n' "\${pad// /x}"`;
  const { res } = await shell(command, {}, await tempDir());
  const tail = res.result?.tail ?? [];
  expect(tail).toHaveLength(50);
  expect(tail[0]).toBe("452");
  expect(tail[48]).toBe("500");
  expect(tail[49]).toBe("x".repeat(2000));
});
