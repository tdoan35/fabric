// Sandbox provider, docker backend and sandboxed tools, verified against the
// fake `docker` CLI in fixtures/sandbox — no daemon, no image, real processes.
// Every provider call is observable in the state file and `exec` runs its
// argv as a real process, so streaming, kills and the tar archive seam are
// exercised for real. The daemon-backed cases (D1–D11) live in
// sandbox-docker.test.ts; the tool contracts (D12) are daemon-free, here.
import { chmodSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import { Pack, Parser, type ReadEntry } from "tar";
import { expect, test, afterEach, beforeEach } from "vitest";
import { z } from "zod";
import type { ToolDef, ToolScope } from "../define";
import { readFileTool, writeFileTool, editFileTool } from "../host/files";
import { shellTool } from "../host/shell";
import { searchFilesTool } from "../host/search";
import { dockerSandboxes, sandboxTools } from "../sandbox";

const IMAGE = "fake-image:1";
const SHIM = fileURLToPath(new URL("./fixtures/sandbox/fake-docker.mjs", import.meta.url));
const BUILD_HINT = "npm run sandbox:build -w @fabric/tools";

interface FakeContainer {
  id: string;
  labels: Record<string, string>;
  argv: string[];
}

interface FakeState {
  seq: number;
  images: string[];
  containers: FakeContainer[];
}

let base = "";
let statePath = "";

const seed = async (state: FakeState): Promise<void> => {
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
};

const fakeState = async (): Promise<FakeState> =>
  JSON.parse(await readFile(statePath, "utf8")) as FakeState;

const fakeProvider = () => dockerSandboxes({ image: IMAGE, docker: SHIM });

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "fabric-sandbox-"));
  statePath = join(base, "fake-docker-state.json");
  // The shim is committed executable; enforce the bit for odd checkouts.
  chmodSync(SHIM, 0o755);
  process.env.FABRIC_FAKE_DOCKER_STATE = statePath;
  await seed({ seq: 0, images: [IMAGE], containers: [] });
});

afterEach(async () => {
  delete process.env.FABRIC_FAKE_DOCKER_STATE;
  await rm(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// the provider and its docker backend
// ---------------------------------------------------------------------------

test("one live sandbox per workspace and agent, labelled a fabric sandbox", async () => {
  const provider = fakeProvider();
  const researcherA = await provider.acquire({ workspaceId: "ws1", agentId: "researcher", mounts: [] });
  const researcherB = await provider.acquire({ workspaceId: "ws1", agentId: "researcher", mounts: [] });
  const writer = await provider.acquire({ workspaceId: "ws1", agentId: "writer", mounts: [] });

  // A second acquire is the same sandbox, not a second container.
  expect(researcherB.id).toBe(researcherA.id);
  expect(writer.id).not.toBe(researcherA.id);

  const runs = (await fakeState()).containers;
  expect(runs).toHaveLength(2);
  for (const run of runs) {
    expect(run.labels["fabric.sandbox"]).toBe("1");
    expect(run.labels["fabric.workspace"]).toBe("ws1");
  }
  const agentOf = (id: string): string | undefined =>
    runs.find((run) => run.id === id)?.labels["fabric.agent"];
  expect(agentOf(researcherA.id)).toBe("researcher");
  expect(agentOf(writer.id)).toBe("writer");
});

test("the docker run argv carries the isolation flags, mounts and env", async () => {
  const provider = fakeProvider();
  await provider.acquire({
    workspaceId: "ws1",
    agentId: "researcher",
    env: { FOO: "bar" },
    mounts: [
      { hostPath: "/host/agent", containerPath: "/workspace" },
      { hostPath: "/host/proj", containerPath: "/projects/proj", readOnly: true },
    ],
  });

  const [run] = (await fakeState()).containers;
  expect(run.argv).toEqual([
    "run", "-d", "--init", "--network", "none",
    "--label", "fabric.sandbox=1", "--label", "fabric.agent=researcher", "--label", "fabric.workspace=ws1",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "512",
    "--memory", "4g", "--cpus", "2",
    "-v", "/host/agent:/workspace",
    "-v", "/host/proj:/projects/proj:ro",
    "-e", "FOO=bar",
    "-w", "/workspace",
    IMAGE, "sleep", "infinity",
  ]);
});

test("exec streams lines as they arrive and reports them in the tail", async () => {
  const provider = fakeProvider();
  const sandbox = await provider.acquire({ workspaceId: "w", agentId: "a", mounts: [] });

  const lines: string[] = [];
  const result = await sandbox.exec("echo one; echo two; echo three", { onLine: (line) => lines.push(line) });
  expect(lines).toEqual(["one", "two", "three"]);
  expect(result).toEqual({ exitCode: 0, timedOut: false, tail: ["one", "two", "three"] });
});

test("a non-zero exit is a normal result, not a rejection", async () => {
  const provider = fakeProvider();
  const sandbox = await provider.acquire({ workspaceId: "w", agentId: "a", mounts: [] });
  const result = await sandbox.exec("echo before; exit 3");
  expect(result.exitCode).toBe(3);
  expect(result.timedOut).toBe(false);
  expect(result.tail).toEqual(["before"]);
});

test("stderr joins the same line stream as stdout", async () => {
  const provider = fakeProvider();
  const sandbox = await provider.acquire({ workspaceId: "w", agentId: "a", mounts: [] });
  const lines: string[] = [];
  await sandbox.exec("echo out; echo err 1>&2", { onLine: (line) => lines.push(line) });
  expect([...lines].sort()).toEqual(["err", "out"]);
});

test("exec kills the process group when the timeout lands", async () => {
  const provider = fakeProvider();
  const sandbox = await provider.acquire({ workspaceId: "w", agentId: "a", mounts: [] });

  const started = Date.now();
  const lines: string[] = [];
  const result = await sandbox.exec("sleep 30 && echo done", {
    timeoutMs: 300,
    onLine: (line) => lines.push(line),
  });
  expect(result.timedOut).toBe(true);
  expect(Date.now() - started).toBeLessThan(3_000);
  expect(lines).toEqual([]); // `done` never ran

  // A follow-up process listing finds no survivor of the killed group.
  const procs: string[] = [];
  await sandbox.exec("ps -ef", { onLine: (line) => procs.push(line) });
  expect(procs.filter((line) => line.includes("sleep 30"))).toEqual([]);
});

test("putArchive and getArchive round-trip a tree byte for byte", async () => {
  const provider = fakeProvider();
  const sandbox = await provider.acquire({ workspaceId: "w", agentId: "a", mounts: [] });

  const src = join(base, "src");
  await mkdir(join(src, "sub"), { recursive: true });
  const files = new Map<string, Buffer>([
    ["a.txt", Buffer.from("alpha\n", "utf8")],
    ["sub/b.bin", Buffer.from([0, 1, 2, 254, 255])],
    ["sub/deep/c.txt", Buffer.from("gamma\ndelta\n", "utf8")],
  ]);
  for (const [rel, data] of files) await writeFile(join(src, rel), data);

  const packer = new Pack({ cwd: src });
  for (const rel of files.keys()) packer.add(rel);
  packer.end();

  const dest = join(base, "dest");
  await sandbox.putArchive(dest, packer as unknown as Readable);

  // The archive the sandbox hands back parses into the very same bytes.
  const entries = await new Promise<Array<{ path: string; data: Buffer }>>((resolve, reject) => {
    const parser = new Parser();
    const collected: Array<{ path: string; data: Buffer }> = [];
    parser.on("entry", (entry: ReadEntry) => {
      const chunks: Buffer[] = [];
      entry.on("data", (chunk: Buffer) => chunks.push(chunk));
      entry.on("end", () => {
        const rel = String(entry.path ?? "").replace(/^\.\//, "").replace(/\/+$/, "");
        if (rel !== "") collected.push({ path: rel, data: Buffer.concat(chunks) });
      });
    });
    parser.on("error", reject);
    parser.on("end", () => resolve(collected));
    const archive = sandbox.getArchive(dest);
    archive.on("data", (chunk: Buffer) => parser.write(chunk));
    archive.on("end", () => parser.end());
    archive.on("error", reject);
  });

  expect(new Set(entries.map((entry) => entry.path))).toEqual(new Set(files.keys()));
  for (const entry of entries) {
    expect(entry.data.equals(files.get(entry.path) ?? Buffer.alloc(0))).toBe(true);
  }

  // And the tree really sits under the destination.
  const onDisk = await readFile(join(dest, "sub/b.bin"));
  expect(onDisk.equals(files.get("sub/b.bin") ?? Buffer.alloc(0))).toBe(true);
});

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("reap drops sandboxes idle past the threshold; the next acquire is fresh", async () => {
  const provider = fakeProvider();
  const first = await provider.acquire({ workspaceId: "w", agentId: "a", mounts: [] });
  await delay(250);

  await provider.reap({ idleMs: 100 });
  const ids = (await fakeState()).containers.map((container) => container.id);
  expect(ids).not.toContain(first.id);

  const second = await provider.acquire({ workspaceId: "w", agentId: "a", mounts: [] });
  expect(second.id).not.toBe(first.id);
});

test("reap keeps sandboxes idle under the threshold", async () => {
  const provider = fakeProvider();
  const sandbox = await provider.acquire({ workspaceId: "w", agentId: "a", mounts: [] });
  await provider.reap({ idleMs: 60_000 });
  expect((await fakeState()).containers.map((container) => container.id)).toEqual([sandbox.id]);
});

test("stopAll removes every sandbox the provider started", async () => {
  const provider = fakeProvider();
  await provider.acquire({ workspaceId: "w", agentId: "a", mounts: [] });
  await provider.acquire({ workspaceId: "w", agentId: "b", mounts: [] });
  await provider.stopAll();
  expect((await fakeState()).containers).toEqual([]);
});

test("a starting provider clears stale sandboxes left by a dead run", async () => {
  await seed({
    seq: 7,
    images: [IMAGE],
    containers: [{ id: "stale-one", labels: { "fabric.sandbox": "1" }, argv: [] }],
  });

  const provider = fakeProvider();
  const probe = await provider.acquire({ workspaceId: "w", agentId: "probe", mounts: [] });

  const ids = (await fakeState()).containers.map((container) => container.id);
  expect(ids).not.toContain("stale-one");
  expect(ids).toEqual([probe.id]);
});

test("available() is false, naming the binary, when docker is missing", async () => {
  const provider = dockerSandboxes({ docker: "/no/such/docker-fixture-binary" });
  const verdict = await provider.available();
  if (verdict.ok) throw new Error("expected available() to fail without a docker binary");
  expect(verdict.reason).toContain("/no/such/docker-fixture-binary");
});

test("acquire without the image fails, naming the build command", async () => {
  await seed({ seq: 0, images: [], containers: [] });
  const provider = fakeProvider();
  await expect(
    provider.acquire({ workspaceId: "w", agentId: "a", mounts: [] })
  ).rejects.toThrow(/sandbox:build/);
});

// ---------------------------------------------------------------------------
// the sandboxed tools
// ---------------------------------------------------------------------------

/** The tool scope the way the runtime hands it over; the ids are opaque. */
const scopeFor = (over: Partial<ToolScope> = {}): ToolScope => ({
  workspaceId: "ws1",
  streamId: "stream-1",
  agentId: "researcher",
  ...over,
});

/** Parses args through the tool's schema (the runtime does) and runs it. */
const call = async (tool: ToolDef, args: unknown, onLine?: (line: string) => void): Promise<unknown> => {
  const parsed = tool.parameters.parse(args);
  return tool.execute(parsed, { scope: scopeFor(), onLine: onLine ?? (() => {}) });
};

let agentDir = "";
let projectDir = "";
let mountsFor: (agentId: string) => Promise<FakeMount[]>;

interface FakeMount {
  hostPath: string;
  containerPath: string;
  readOnly?: boolean;
}

beforeEach(async () => {
  agentDir = join(base, "agent");
  projectDir = join(base, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  mountsFor = async () => [
    { hostPath: agentDir, containerPath: agentDir },
    { hostPath: projectDir, containerPath: projectDir, readOnly: true },
  ];
});

const sandboxed = (name: string): ToolDef => {
  const tools = sandboxTools(fakeProvider(), mountsFor);
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`no sandboxed tool ${name}`);
  return tool;
};

test("the sandboxed shell runs the command and streams like the host shell", async () => {
  const lines: string[] = [];
  const result = (await call(
    sandboxed("shell"),
    { command: "echo hello", cwd: agentDir, timeoutMs: 5_000 },
    (line) => lines.push(line)
  )) as { exitCode: number; timedOut: boolean; tail: string[] };
  expect(lines).toEqual(["hello"]);
  expect(result).toEqual({ exitCode: 0, timedOut: false, tail: ["hello"] });
});

test("write_file, edit_file and read_file round-trip inside the sandbox", async () => {
  const target = join(agentDir, "note.txt");

  const written = (await call(sandboxed("write_file"), { path: target, content: "hello\nworld\n" })) as {
    path: string;
    bytes: number;
  };
  expect(written).toEqual({ path: target, bytes: 12 });
  expect(await readFile(target, "utf8")).toBe("hello\nworld\n");

  const edited = (await call(sandboxed("edit_file"), { path: target, old: "world", new: "fabric" })) as {
    path: string;
    replacements: number;
  };
  expect(edited).toEqual({ path: target, replacements: 1 });

  const read = (await call(sandboxed("read_file"), { path: target })) as {
    path: string;
    text: string;
    totalLines: number;
    truncated: boolean;
  };
  expect(read).toEqual({ path: target, text: "hello\nfabric\n", totalLines: 2, truncated: false });
});

test("write_file creates missing parent directories", async () => {
  const target = join(agentDir, "deeply", "nested", "file.txt");
  await call(sandboxed("write_file"), { path: target, content: "x" });
  expect(await readFile(target, "utf8")).toBe("x");
});

test("edit_file demands a unique anchor unless replaceAll is set", async () => {
  const target = join(agentDir, "dup.txt");
  await writeFile(target, "same same\n", "utf8");
  await expect(
    call(sandboxed("edit_file"), { path: target, old: "same", new: "different" })
  ).rejects.toThrow(/2 matches; pass replaceAll or more context/);
  const edited = (await call(sandboxed("edit_file"), {
    path: target,
    old: "same",
    new: "different",
    replaceAll: true,
  })) as { replacements: number };
  expect(edited.replacements).toBe(2);
  expect(await readFile(target, "utf8")).toBe("different different\n");
});

test("edit_file with no match is an error, not a silent write", async () => {
  const target = join(agentDir, "nomatch.txt");
  await writeFile(target, "content\n", "utf8");
  await expect(
    call(sandboxed("edit_file"), { path: target, old: "absent", new: "x" })
  ).rejects.toThrow(/no match for old in/);
});

test("writing under a read-only project is the read-only error, and the host is untouched", async () => {
  const before = await readdir(projectDir);
  await expect(
    call(sandboxed("write_file"), { path: join(projectDir, "new.txt"), content: "x" })
  ).rejects.toThrow(/read-only/);
  expect(await readdir(projectDir)).toEqual(before);
});

test("search_files finds matches with path and line number", async () => {
  await writeFile(join(agentDir, "a.txt"), "needle one\n", "utf8");
  await mkdir(join(agentDir, "sub"), { recursive: true });
  await writeFile(join(agentDir, "sub", "b.md"), "the needle two\n", "utf8");

  const result = (await call(sandboxed("search_files"), { path: agentDir, pattern: "needle" })) as {
    matches: Array<{ path: string; line: number; text: string }>;
    truncated: boolean;
  };
  expect(result.truncated).toBe(false);
  expect(result.matches).toEqual([
    { path: "a.txt", line: 1, text: "needle one" },
    { path: join("sub", "b.md"), line: 1, text: "the needle two" },
  ]);
});

// ---------------------------------------------------------------------------
// D12 — the sandboxed tools keep the host tools' contracts, at step 2
// ---------------------------------------------------------------------------

test("D12 sandboxed tool definitions mirror the host tools, at step 2", () => {
  // The sandbox shell is bash by definition; so is the host comparison stub.
  const bashDetect = { name: "bash", argv: (command: string): string[] => ["bash", "-c", command] };
  const host = [
    shellTool({ detect: bashDetect }),
    readFileTool(),
    writeFileTool(),
    editFileTool(),
    searchFilesTool({ which: () => true }),
  ];
  const sandboxedTools = sandboxTools(fakeProvider(), async () => []);

  expect(sandboxedTools.map((tool) => tool.name)).toEqual(host.map((tool) => tool.name));
  for (const hostTool of host) {
    const sandboxTool = sandboxedTools.find((tool) => tool.name === hostTool.name);
    if (sandboxTool === undefined) throw new Error(`no sandboxed ${hostTool.name}`);
    expect(z.toJSONSchema(sandboxTool.parameters)).toEqual(z.toJSONSchema(hostTool.parameters));
    expect(sandboxTool.effect).toBe(hostTool.effect);
    expect(sandboxTool.gate).toBe(hostTool.gate);
    expect(sandboxTool.kind).toBe(hostTool.kind);
    expect(sandboxTool.step).toBe(2);
  }

  const shell = sandboxedTools.find((tool) => tool.name === "shell");
  if (shell === undefined) throw new Error("no sandboxed shell");
  for (const needle of ["bash", "sandbox", "/workspace", "/projects/"]) {
    expect(shell.description).toContain(needle);
  }
});
