// Sandbox provider, docker backend and sandboxed tools, verified against the
// fake `docker` CLI in fixtures/sandbox — no daemon, no image, real processes.
// Every provider call is observable in the state file and `exec` runs its
// argv as a real process, so streaming, kills and the tar archive seam are
// exercised for real. The daemon-backed cases (D1–D11) live in
// sandbox-docker.test.ts; the tool contracts (D12) are daemon-free, here.
import { chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
  name?: string;
  labels: Record<string, string>;
  argv: string[];
  /** docker ps state (running/created/exited); absent means created. */
  state?: string;
}

interface FakeState {
  seq: number;
  images: string[];
  containers: FakeContainer[];
  /** The last recorded `rm` argv (the shim's rm case); the sweep's no-force
   * contract reads it. */
  lastRm?: string[];
}

let base = "";
let statePath = "";
let savedPath: string | undefined;

/** The minimal rg stand-in for hosts without ripgrep (CI runner images ship
 * none); a real rg on PATH always wins. */
const RG_FIXTURE_BIN = path.join(path.dirname(SHIM), "bin");

const seed = async (state: FakeState): Promise<void> => {
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
};

const fakeState = async (): Promise<FakeState> =>
  JSON.parse(await readFile(statePath, "utf8")) as FakeState;

const fakeProvider = () => dockerSandboxes({ image: IMAGE, docker: SHIM });

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "fabric-sandbox-"));
  statePath = path.join(base, "fake-docker-state.json");
  // The shim is committed executable; enforce the bit for odd checkouts.
  chmodSync(SHIM, 0o755);
  chmodSync(path.join(RG_FIXTURE_BIN, "rg"), 0o755);
  process.env.FABRIC_FAKE_DOCKER_STATE = statePath;
  // The sandboxed search tool execs `rg` by name; when the host has none, put
  // the fixture's first on PATH for the duration of the test.
  if (spawnSync("rg", ["--version"], { stdio: "ignore" }).error !== undefined) {
    savedPath = process.env.PATH;
    process.env.PATH = `${RG_FIXTURE_BIN}${path.delimiter}${process.env.PATH ?? ""}`;
  }
  await seed({ seq: 0, images: [IMAGE], containers: [] });
});

afterEach(async () => {
  delete process.env.FABRIC_FAKE_DOCKER_STATE;
  if (savedPath !== undefined) {
    process.env.PATH = savedPath;
    savedPath = undefined;
  }
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

  const runs = (await fakeState()).containers.filter((run) => run.labels["fabric.sandbox"] === "1");
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

  // T18: the sandbox runs on the internal network with the proxy env; the
  // egress gateway container is recorded separately (see its own test).
  const run = (await fakeState()).containers.find((candidate) => candidate.labels["fabric.sandbox"] === "1");
  expect(run?.argv).toEqual([
    "run", "-d", "--init", "--network", "fabric-sbx",
    "--label", "fabric.sandbox=1", "--label", "fabric.agent=researcher", "--label", "fabric.workspace=ws1",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "512",
    "--memory", "4g", "--cpus", "2",
    "-e", "HTTP_PROXY=http://egress:3128",
    "-e", "HTTPS_PROXY=http://egress:3128",
    "-e", "http_proxy=http://egress:3128",
    "-e", "https_proxy=http://egress:3128",
    "-e", "ALL_PROXY=http://egress:3128",
    "-e", "NO_PROXY=egress",
    "-e", "FABRIC_EGRESS_URL=http://egress",
    "-v", "/host/agent:/workspace",
    "-v", "/host/proj:/projects/proj:ro",
    "-e", "FOO=bar",
    "-w", "/workspace",
    IMAGE, "sleep", "infinity",
  ]);
});

test("the egress gateway container is ensured once per provider and removed by stopAll", async () => {
  const provider = fakeProvider();
  await provider.acquire({ workspaceId: "w", agentId: "a", mounts: [] });
  await provider.acquire({ workspaceId: "w", agentId: "b", mounts: [] });

  const gateways = (await fakeState()).containers.filter((container) => container.labels["fabric.egress"] === "1");
  expect(gateways).toHaveLength(1);
  expect(gateways[0]?.labels["fabric.egress.instance"]).toBeTruthy();
  expect(gateways[0]?.argv).toContain("node");
  expect(gateways[0]?.argv).toContain("/opt/fabric/egress.mjs");
  expect(gateways[0]?.argv).toContain("fabric-sbx");
  expect(gateways[0]?.argv).toContain("--cap-drop");
  expect(gateways[0]?.argv).toContain("NET_BIND_SERVICE");

  await provider.stopAll();
  expect((await fakeState()).containers).toEqual([]);
});

test("a dead gateway is replaced on the next acquire of a live sandbox", async () => {
  const provider = dockerSandboxes({ image: IMAGE, docker: SHIM, egress: { instance: "t1" } });
  await provider.acquire({ workspaceId: "w", agentId: "a", mounts: [] });

  // The gateway dies without the provider noticing (E8: `docker rm -f`); the
  // next acquire — even a cache hit for a live sandbox — must replace it.
  spawnSync(SHIM, ["rm", "-f", "fabric-egress-t1"], { stdio: "ignore" });
  await provider.acquire({ workspaceId: "w", agentId: "a", mounts: [] });

  const gateways = (await fakeState()).containers.filter((container) => container.labels["fabric.egress"] === "1");
  expect(gateways).toHaveLength(1);
  expect(gateways[0]?.name).toBe("fabric-egress-t1");
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
  // The command records the session leader's pid: the kill is verified against
  // that process group, never against a host-wide `ps`. The fake sandbox has
  // no PID namespace, so a host listing would count unrelated `sleep 30`s —
  // the daemon suite's parallel execs, any stray host process — as survivors.
  const pgidFile = join(base, "killed-pgid");
  const result = await sandbox.exec(`echo $$ > ${pgidFile}; sleep 30 && echo done`, {
    timeoutMs: 300,
    onLine: (line) => lines.push(line),
  });
  expect(result.timedOut).toBe(true);
  expect(Date.now() - started).toBeLessThan(3_000);
  // Killed before the chain finished: no `done`, but bash's own kill notice
  // on stderr is expected stream traffic.
  expect(lines.includes("done")).toBe(false);

  // No survivor of the killed group: the recorded group empties. Bounded
  // poll — SIGKILL death is quick, a loaded CI runner is not; a silently
  // no-op killer (the container-side kill exits 0 regardless) keeps the
  // group alive and fails here.
  const check = await sandbox.exec(
    `[ -s ${pgidFile} ] || exit 3; ` +
      `for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do ` +
      `kill -0 -- -$(cat ${pgidFile}) 2>/dev/null || exit 0; sleep 0.05; done; exit 1`,
    { timeoutMs: 5_000 }
  );
  expect(check.exitCode).toBe(0);
});

test("putArchive and getArchive round-trip a tree byte for byte", async () => {
  const provider = fakeProvider();
  const sandbox = await provider.acquire({ workspaceId: "w", agentId: "a", mounts: [] });

  const src = join(base, "src");
  await mkdir(src, { recursive: true });
  const files = new Map<string, Buffer>([
    ["a.txt", Buffer.from("alpha\n", "utf8")],
    ["sub/b.bin", Buffer.from([0, 1, 2, 254, 255])],
    ["sub/deep/c.txt", Buffer.from("gamma\ndelta\n", "utf8")],
  ]);
  for (const [rel, data] of files) {
    await mkdir(join(src, rel, ".."), { recursive: true });
    await writeFile(join(src, rel), data);
  }

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

  // Directory entries ride along; every file must come back byte-identical.
  expect(entries.length).toBeGreaterThanOrEqual(files.size);
  for (const [rel, data] of files) {
    const entry = entries.find((candidate) => candidate.path === rel);
    expect(entry, rel).toBeDefined();
    expect(entry?.data.equals(data) ?? false).toBe(true);
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
  const kept = (await fakeState()).containers.filter((container) => container.labels["fabric.sandbox"] === "1");
  expect(kept.map((container) => container.id)).toEqual([sandbox.id]);
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

  const ids = (await fakeState()).containers
    .filter((container) => container.labels["fabric.sandbox"] === "1")
    .map((container) => container.id);
  expect(ids).not.toContain("stale-one");
  expect(ids).toEqual([probe.id]);
});

test("the startup sweep spares the running sandboxes of a concurrent run", async () => {
  // CI runs the daemon suites' workers side by side; a starting provider's
  // crash-recovery sweep must not stop another worker's live sandbox mid-test
  // (the D8 `cannot exec in a stopped state` bounce). Only stopped leftovers
  // are reaped; a running sandbox belongs to a live provider until proven else.
  await seed({
    seq: 8,
    images: [IMAGE],
    containers: [
      { id: "live-one", state: "running", labels: { "fabric.sandbox": "1" }, argv: [] },
      { id: "done-one", labels: { "fabric.sandbox": "1" }, argv: [] },
    ],
  });

  const provider = fakeProvider();
  const probe = await provider.acquire({ workspaceId: "w", agentId: "probe", mounts: [] });

  const ids = (await fakeState()).containers
    .filter((container) => container.labels["fabric.sandbox"] === "1")
    .map((container) => container.id);
  expect(ids).not.toContain("done-one");
  expect(ids).toContain("live-one");
  expect(ids).toContain(probe.id);
});

test("the startup sweep reaps without force, so a sandbox that starts during the sweep survives", async () => {
  // The ps -> rm window: a container the sweep recorded as `created` may be
  // running by the time the rm lands (CI run 291: E4's first proxyGet and D6's
  // `id -u` each saw `docker exec` exit 1 after the sandbox vanished; run 285
  // shows the same assertion at 137, the rm -f stop). A plain `rm` is refused
  // for a running container, so the race degrades to a no-op instead of
  // killing a live sandbox between its `docker run` and first exec.
  await seed({
    seq: 9,
    images: [IMAGE],
    containers: [{ id: "gone-one", labels: { "fabric.sandbox": "1" }, argv: [] }],
  });

  const provider = fakeProvider();
  await provider.acquire({ workspaceId: "w", agentId: "probe", mounts: [] });

  const reaping = (await fakeState()).lastRm ?? [];
  expect(reaping).toContain("gone-one");
  expect(reaping).not.toContain("-f");
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
