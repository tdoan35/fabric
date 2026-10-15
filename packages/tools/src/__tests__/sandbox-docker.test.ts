// The daemon-backed sandbox cases D1–D11 (T8). They run against the real
// Docker daemon with the sandbox image, which the vitest globalSetup builds
// from sandbox/Dockerfile when it is missing. The whole suite is skipped, with
// a printed reason, only when `docker info` fails and CI is unset; in CI a
// missing daemon fails the suite. D12 (the tool contracts, daemon-free) lives
// in sandbox-local.test.ts.
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { userInfo } from "node:os";
import path, { join } from "node:path";
import { promisify } from "node:util";
import { Pack, Parser, type ReadEntry } from "tar";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ToolDef } from "../define";
import { dockerSandboxes, sandboxTools, type SandboxMount, type SandboxProvider } from "../sandbox";

const run = promisify(execFile);

const daemonOk = await run("docker", ["info", "--format", "ok"]).then(
  () => true,
  (error: unknown) => {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    console.log(`[sandbox] docker daemon unreachable (${reason})`);
    return false;
  }
);

// Skip only when the daemon is gone AND CI is unset; in CI the cases run and
// a missing daemon fails them.
const withoutDaemon = !daemonOk && process.env.CI === undefined;
if (withoutDaemon) {
  console.log(
    "[sandbox] skipping D1-D11: `docker info` failed and CI is unset; run them on a machine with the daemon"
  );
}

const docker = test.skipIf(withoutDaemon);

let base = "";
let agentDir = "";
let projectDir = "";
let provider: SandboxProvider | undefined;
/** One provider per test: the daemon-backed cases exercise one live sandbox
 * table, not several providers racing each one's crash-recovery sweep. */
const theProvider = (): SandboxProvider => (provider ??= dockerSandboxes());

/** The mounts D3/D8 use: the agent folder at /workspace, one read project. */
const mountsFor = (agentId: string): SandboxMount[] => [
  { hostPath: agentDir, containerPath: "/workspace" },
  { hostPath: projectDir, containerPath: `/projects/${agentId}`, readOnly: true },
];

const acquire = async (agentId: string) => {
  const instance = theProvider();
  return instance.acquire({ workspaceId: "ws1", agentId, mounts: mountsFor(agentId) });
};

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "fabric-sandbox-d-"));
  agentDir = path.join(base, "agent");
  projectDir = path.join(base, "project");
  // Container uid 1000 writes here over the bind mount. The explicit chmod is
  // umask-proof: mkdir's mode lands masked (022 -> 755, no `w` for others) and
  // the runner user's uid is not the container's 1000, so the mask alone makes
  // every container-side write fail.
  await Promise.all([
    mkdir(agentDir, { recursive: true, mode: 0o777 }),
    mkdir(projectDir, { recursive: true, mode: 0o777 }),
  ]);
  await Promise.all([chmod(agentDir, 0o777), chmod(projectDir, 0o777)]);
});

afterEach(async () => {
  await provider?.stopAll().catch(() => {});
  provider = undefined;
  await rm(base, { recursive: true, force: true });
});

const containerIds = async (labels: string): Promise<string[]> => {
  const { stdout } = await run("docker", ["ps", "-aq", "--filter", `label=${labels}`]);
  return stdout
    .split("\n")
    .map((id) => id.trim())
    .filter((id) => id !== "");
};

const labelsOf = async (id: string): Promise<Record<string, string>> => {
  const { stdout } = await run("docker", [
    "inspect",
    "--format",
    "{{json .Config.Labels}}",
    id,
  ]);
  return JSON.parse(stdout.trim()) as Record<string, string>;
};

docker("D1 available() is ok against the daemon", async () => {
  const probe = dockerSandboxes();
  await expect(probe.available()).resolves.toEqual({ ok: true });
});

docker("D2 one container per agent, both carrying the three labels", async () => {
  const researcher = await acquire("researcher");
  const researcherAgain = await acquire("researcher");
  const writer = await acquire("writer");

  expect(researcherAgain.id).toBe(researcher.id);
  expect(writer.id).not.toBe(researcher.id);

  for (const [sandbox, agent] of [
    [researcher, "researcher"],
    [writer, "writer"],
  ] as const) {
    expect(await labelsOf(sandbox.id)).toMatchObject({
      "fabric.sandbox": "1",
      "fabric.agent": agent,
      "fabric.workspace": "ws1",
    });
  }
});

docker("D3 the agent folder is /workspace; a read project is read-only inside", async () => {
  const sandbox = await acquire("researcher");

  // Host writes are visible inside; inside writes land on the host.
  await writeFile(join(agentDir, "from-host.txt"), "host says hi\n", "utf8");
  const cat = await sandbox.exec("cat /workspace/from-host.txt");
  expect(cat.tail).toEqual(["host says hi"]);

  await sandbox.exec("echo inside > /workspace/from-sandbox.txt");
  expect(await readFile(path.join(agentDir, "from-sandbox.txt"), "utf8")).toBe("inside\n");

  // A `read` grant is read-only inside: the tool says so, the host is untouched.
  const tools = toolbelt();
  const before = await readdir(projectDir);
  await expect(
    call(findTool(tools, "write_file"), { path: "/projects/researcher/new.txt", content: "x" })
  ).rejects.toThrow(/read-only/);
  expect(await readdir(projectDir)).toEqual(before);
});

docker("D4 shell streams lines in order; a non-zero exit is a normal result", async () => {
  const tools = toolbelt("researcher");
  const shell = findTool(tools, "shell");

  const lines: string[] = [];
  const at: number[] = [];
  const result = (await call(
    shell,
    { command: "for i in 1 2 3; do echo $i; sleep 0.1; done" },
    (line) => {
      at.push(Date.now());
      lines.push(line);
    }
  )) as { exitCode: number; timedOut: boolean; tail: string[] };
  expect(lines).toEqual(["1", "2", "3"]);
  // The lines trailed in over the sleeps rather than arriving at close.
  expect(at[2] - at[0]).toBeGreaterThanOrEqual(50);
  expect(result).toEqual({ exitCode: 0, timedOut: false, tail: ["1", "2", "3"] });

  const failing = (await call(shell, { command: "exit 3" })) as { exitCode: number };
  expect(failing.exitCode).toBe(3);
});

docker("D5 a timed-out exec is killed inside the container within 3s", async () => {
  const sandbox = await acquire("researcher");

  const started = Date.now();
  const result = await sandbox.exec("sleep 30", { timeoutMs: 500 });
  expect(result.timedOut).toBe(true);
  expect(Date.now() - started).toBeLessThan(3_000);

  const procs: string[] = [];
  await sandbox.exec("ps -ef", { onLine: (line) => procs.push(line) });
  expect(procs.filter((line) => line.includes("sleep 30"))).toEqual([]);
});

docker("D6 no network inside; the process runs as uid 1000", async () => {
  const sandbox = await acquire("researcher");

  const curl = await sandbox.exec("curl -sS https://example.com");
  expect(curl.exitCode).not.toBe(0);

  const getent = await sandbox.exec("getent hosts example.com");
  expect(getent.exitCode).not.toBe(0);

  const id = await sandbox.exec("id -u");
  expect(id.exitCode).toBe(0);
  expect(id.tail).toEqual(["1000"]);
});

docker("D7 read_file follows symlinks to the container's own /etc/passwd", async () => {
  const sandbox = await acquire("researcher");
  await sandbox.exec("ln -s /etc/passwd /workspace/p");

  const tools = toolbelt("researcher");
  const read = (await call(findTool(tools, "read_file"), { path: "p" })) as {
    text: string;
    totalLines: number;
    truncated: boolean;
  };

  const hostUser = userInfo().username;
  const lines = read.text.split("\n");
  expect(read.truncated).toBe(false);
  expect(lines.some((line) => line.startsWith("root:"))).toBe(true);
  expect(lines.some((line) => line.startsWith(`${hostUser}:`))).toBe(false);
});

docker("D8 write, edit, read and search round-trip inside", async () => {
  const tools = toolbelt("researcher");
  const write = findTool(tools, "write_file");
  const edit = findTool(tools, "edit_file");
  const read = findTool(tools, "read_file");
  const search = findTool(tools, "search_files");

  const written = (await call(write, { path: "note.txt", content: "hello\nworld\n" })) as {
    path: string;
    bytes: number;
  };
  expect(written).toEqual({ path: "/workspace/note.txt", bytes: 12 });

  const edited = (await call(edit, { path: "note.txt", old: "world", new: "fabric" })) as {
    replacements: number;
  };
  expect(edited).toEqual({ path: "/workspace/note.txt", replacements: 1 });

  const readBack = (await call(read, { path: "note.txt" })) as {
    path: string;
    text: string;
    totalLines: number;
    truncated: boolean;
  };
  expect(readBack).toEqual({
    path: "/workspace/note.txt",
    text: "hello\nfabric\n",
    totalLines: 2,
    truncated: false,
  });

  const found = (await call(search, { path: "/workspace", pattern: "fabric" })) as {
    matches: Array<{ path: string; line: number; text: string }>;
    truncated: boolean;
  };
  expect(found.truncated).toBe(false);
  expect(found.matches).toEqual([{ path: "note.txt", line: 2, text: "fabric" }]);
});

docker("D9 putArchive/getArchive round-trip through /tmp/x byte for byte", async () => {
  const sandbox = await acquire("researcher");

  const src = path.join(base, "src");
  await mkdir(path.join(src, "sub"), { recursive: true });
  const files = new Map<string, Buffer>([
    ["a.txt", Buffer.from("alpha\n", "utf8")],
    ["sub/b.bin", Buffer.from([0, 1, 2, 254, 255])],
  ]);
  for (const [rel, data] of files) await writeFile(path.join(src, rel), data);

  const packer = new Pack({ cwd: src });
  for (const rel of files.keys()) packer.add(rel);
  packer.end();
  await sandbox.putArchive("/tmp/x", packer as unknown as import("node:stream").Readable);

  const entries = await new Promise<Array<{ path: string; data: Buffer }>>((resolve, reject) => {
    const parser = new Parser();
    const collected: Array<{ path: string; data: Buffer }> = [];
    parser.on("entry", (entry: ReadEntry) => {
      // Directory entries ride along in the tar stream; the assertion is about
      // the files.
      if (entry.type !== "File") return;
      const chunks: Buffer[] = [];
      entry.on("data", (chunk: Buffer) => chunks.push(chunk));
      entry.on("end", () => {
        const rel = String(entry.path ?? "").replace(/^\.\//, "").replace(/\/+$/, "");
        if (rel !== "") collected.push({ path: rel, data: Buffer.concat(chunks) });
      });
    });
    parser.on("error", reject);
    parser.on("end", () => resolve(collected));
    const archive = sandbox.getArchive("/tmp/x");
    archive.on("data", (chunk: Buffer) => parser.write(chunk));
    archive.on("end", () => parser.end());
    archive.on("error", reject);
  });

  expect(new Set(entries.map((entry) => entry.path))).toEqual(new Set(files.keys()));
  for (const entry of entries) {
    expect(entry.data.equals(files.get(entry.path) ?? Buffer.alloc(0))).toBe(true);
  }
});

docker("D10 reap removes the idle container; the next acquire is fresh", async () => {
  const sandbox = await acquire("researcher");
  await new Promise((resolve) => setTimeout(resolve, 300));

  await provider?.reap({ idleMs: 200 });
  const ids = await containerIds("fabric.sandbox=1");
  expect(ids).not.toContain(sandbox.id);

  const next = await acquire("researcher");
  expect(next.id).not.toBe(sandbox.id);
});

docker("D11 a starting provider clears containers left by a dead run", async () => {
  const stale = await run("docker", [
    "create",
    "--label",
    "fabric.sandbox=1",
    "--label",
    "fabric.agent=ghost",
    "--label",
    "fabric.workspace=ws1",
    "busybox",
    "true",
  ]);
  const staleId = stale.stdout.trim();

  const fresh = dockerSandboxes();
  await fresh.acquire({ workspaceId: "other", agentId: "probe", mounts: [] });

  const ids = await containerIds("fabric.sandbox=1");
  expect(ids).not.toContain(staleId);

  await fresh.stopAll().catch(() => {});
});

// ---------------------------------------------------------------------------
// shared tool helpers (the runtime's call shape, narrowed for the assertions)
// ---------------------------------------------------------------------------

function toolbelt(agentId = "researcher"): ToolDef[] {
  return sandboxTools(theProvider(), async () => mountsFor(agentId));
}

function findTool(tools: ToolDef[], name: string): ToolDef {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return tool;
}

async function call(tool: ToolDef, args: unknown, onLine?: (line: string) => void): Promise<unknown> {
  return await tool.execute(tool.parameters.parse(args), {
    scope: { workspaceId: "ws1", streamId: "stream-1", agentId: "researcher" },
    onLine: onLine ?? (() => {}),
  });
}
