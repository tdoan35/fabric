// Sprites sandbox provider (ANY-44 D9, T9), verified against a fake Sprites
// client whose sprites are temp dirs: `spawn` runs real host processes with
// sprite paths (/workspace, /projects/<name>) translated to locations under
// the sprite's dir, so the tar seams move real bytes and kills are real. The
// fake counts tar invocations and records creates, env and network policy.
// S11 is the live-API case, run only when SPRITES_LIVE_TEST is set with a
// token; CI skips it.
import { spawn as spawnNode, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import path, { join } from "node:path";
import { expect, test, afterEach, beforeEach } from "vitest";
import { z } from "zod";
import type { ToolDef } from "../define";
import { editFileTool, readFileTool, writeFileTool } from "../host/files";
import { shellTool } from "../host/shell";
import { searchFilesTool } from "../host/search";
import { sandboxTools } from "../sandbox";
import { localFolders, type FolderStore } from "../folders";
import { spriteSandboxes } from "../sprites";

// ---------------------------------------------------------------------------
// the fake Sprites client: a temp dir per sprite, real processes, no network
// ---------------------------------------------------------------------------

/** Sprite paths are host-relative under the sprite's dir; the longest token
 * first is unnecessary — /workspace and /projects/ never prefix each other. */
const translate = (value: string): string =>
  value.replaceAll("/workspace", "workspace").replaceAll("/projects/", "projects/");

class FakeCommand extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;

  constructor(
    private readonly child: ChildProcess,
    private readonly record: { argv: string[]; killed: boolean }
  ) {
    super();
    child.stdout?.pipe(this.stdout);
    child.stderr?.pipe(this.stderr);
    this.stdin.pipe(child.stdin ?? new PassThrough());
    child.on("error", (error: Error) => this.emit("error", error));
    child.on("exit", (code: number | null) => {
      this.exitCode = code;
      this.emit("exit", code);
    });
  }

  wait(): Promise<number> {
    return new Promise((resolve) => {
      this.child.once("exit", (code: number | null) => resolve(code ?? -1));
    });
  }

  kill(): void {
    this.record.killed = true;
    try {
      this.child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

class FakeSprite {
  /** Every spawn, in order, with its killed flag — the kill record. */
  readonly commands: Array<{ argv: string[]; killed: boolean }> = [];
  policy: unknown;
  deleted = false;

  constructor(
    readonly name: string,
    readonly dir: string,
    private readonly client: FakeSpritesClient
  ) {}

  spawn(
    command: string,
    args: string[] = [],
    options: { cwd?: string; env?: Record<string, string> } = {}
  ): FakeCommand {
    const record = { argv: [command, ...args], killed: false };
    this.commands.push(record);
    if (command === "tar") this.client.tarCalls += 1;
    const cwd =
      options.cwd === undefined
        ? this.dir
        : path.resolve(this.dir, translate(options.cwd));
    const child = spawnNode(command, args.map(translate), { cwd });
    return new FakeCommand(child, record);
  }

  async delete(): Promise<void> {
    this.deleted = true;
    this.client.sprites.delete(this.name);
  }

  async updateNetworkPolicy(policy: unknown): Promise<void> {
    this.policy = policy;
  }

  command(...fragments: string[]): { argv: string[]; killed: boolean } | undefined {
    return this.commands.find((record) =>
      fragments.every((needle) => record.argv.join(" ").includes(needle))
    );
  }
}

class FakeSpritesClient {
  readonly sprites = new Map<string, FakeSprite>();
  creates = 0;
  lastCreateOptions: { environment?: Record<string, string> } | undefined;
  tarCalls = 0;

  constructor(readonly root: string) {}

  dirOf(name: string): string {
    return join(this.root, name);
  }

  sprite(name: string): FakeSprite | undefined {
    return this.sprites.get(name);
  }

  async getSprite(name: string): Promise<FakeSprite> {
    const sprite = this.sprites.get(name);
    if (sprite === undefined) throw new Error(`sprite ${name} not found`);
    return sprite;
  }

  async createSprite(
    name: string,
    options: { environment?: Record<string, string> } = {}
  ): Promise<FakeSprite> {
    this.creates += 1;
    this.lastCreateOptions = options;
    const sprite = new FakeSprite(name, this.dirOf(name), this);
    await mkdir(join(sprite.dir, "workspace"), { recursive: true });
    await mkdir(join(sprite.dir, "projects"), { recursive: true });
    this.sprites.set(name, sprite);
    return sprite;
  }

  async listSprites(): Promise<unknown> {
    return { sprites: [...this.sprites.keys()].map((name) => ({ name })) };
  }
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

let base = "";
let store: FolderStore;
let client: FakeSpritesClient;

const provider = () => spriteSandboxes({ token: "test-token", folders: store, client });

const agentDir = async (): Promise<string> => store.path({ kind: "agent", name: "researcher" });

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "fabric-sprites-"));
  store = localFolders(join(base, "folders"));
  client = new FakeSpritesClient(join(base, "sprites"));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// shared tool helpers (the runtime's call shape, as in the sandbox tests)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// S1–S10
// ---------------------------------------------------------------------------

test("S1 sprite names: prefix-workspace-agent, capped with a stable hash suffix", async () => {
  const plain = await provider().acquire({ workspaceId: "local", agentId: "researcher", mounts: [] });
  expect(plain.id).toBe("fabric-local-researcher");

  // A 70-character agent id stays within the SDK's name limit, and the cut is
  // stable across providers.
  const longAgent = "a".repeat(70);
  const first = await provider().acquire({ workspaceId: "ws", agentId: longAgent, mounts: [] });
  expect(first.id.length).toBeLessThanOrEqual(63);
  const second = await provider().acquire({ workspaceId: "ws", agentId: longAgent, mounts: [] });
  expect(second.id).toBe(first.id);

  // Two ids that cut to the same prefix still get different names.
  const shared = "agent".padEnd(60, "x");
  const one = await provider().acquire({ workspaceId: "ws", agentId: `${shared}one`, mounts: [] });
  const two = await provider().acquire({ workspaceId: "ws", agentId: `${shared}two`, mounts: [] });
  expect(one.id).not.toBe(two.id);
  expect(one.id.length).toBeLessThanOrEqual(63);
  expect(two.id.length).toBeLessThanOrEqual(63);
});

test("S2 acquire reuses one sprite per workspace and agent; an existing sprite is not re-created", async () => {
  const request = { workspaceId: "ws1", agentId: "researcher", mounts: [] };
  const first = spriteSandboxes({ token: "t", folders: store, client });
  await first.acquire({ ...request });
  const second = spriteSandboxes({ token: "t", folders: store, client });
  const live = await second.acquire({ ...request });
  const again = await second.acquire({ ...request });
  expect(again.id).toBe(live.id);
  expect(client.creates).toBe(1);
});

test("S3 sync in: agent folder and read-only project land byte-identical under /workspace and /projects", async () => {
  const workspace = await agentDir();
  await writeFile(join(workspace, "note.txt"), "hello");
  const docs = await store.path({ kind: "project", name: "docs" });
  await mkdir(join(docs, "sub"), { recursive: true });
  await writeFile(join(docs, "sub", "a.md"), "é");

  const sandbox = await provider().acquire({
    workspaceId: "ws1",
    agentId: "researcher",
    mounts: [
      { hostPath: workspace, containerPath: "/workspace" },
      { hostPath: docs, containerPath: "/projects/docs", readOnly: true },
    ],
  });

  const home = client.sprite(sandbox.id);
  if (home === undefined) throw new Error("sprite missing");
  expect(await readFile(join(home.dir, "workspace", "note.txt"))).toEqual(Buffer.from("hello"));
  expect(await readFile(join(home.dir, "projects", "docs", "sub", "a.md"))).toEqual(
    Buffer.from("é")
  );
});

test("S4 write-back: mutating tools reach the host, read-only tools and projects do not", async () => {
  const workspace = await agentDir();
  await writeFile(join(workspace, "seed.txt"), "seed");
  const shared = await store.path({ kind: "project", name: "shared" });
  const docs = await store.path({ kind: "project", name: "docs" });
  const mounts = [
    { hostPath: workspace, containerPath: "/workspace" },
    { hostPath: shared, containerPath: "/projects/shared" },
    { hostPath: docs, containerPath: "/projects/docs", readOnly: true },
  ];
  const tools = sandboxTools(provider(), async () => mounts);

  await call(findTool(tools, "write_file"), { path: "out.txt", content: "written" });
  expect(await readFile(join(workspace, "out.txt"), "utf8")).toBe("written");

  // read_file runs no tar at all: the fake counts tar invocations.
  const afterWrite = client.tarCalls;
  await call(findTool(tools, "read_file"), { path: "seed.txt" });
  expect(client.tarCalls).toBe(afterWrite);

  // A write under a read-only project (through shell, which is not mount
  // checked) never reaches the host copy.
  await call(findTool(tools, "shell"), { command: "printf 'xy' > '/projects/docs/note.md'" });
  await expect(readFile(join(docs, "note.md"))).rejects.toBeTruthy();
  // ...while the write-granted project does round-trip.
  await call(findTool(tools, "shell"), { command: "printf 'ab' > '/projects/shared/one.md'" });
  expect(await readFile(join(shared, "one.md"), "utf8")).toBe("ab");
});

test("S5 a folder over the size cap skips the write-back and leaves the host untouched", async () => {
  const workspace = await agentDir();
  await writeFile(join(workspace, "keep.txt"), "keep");
  const sandbox = await provider().acquire({
    workspaceId: "ws1",
    agentId: "researcher",
    mounts: [{ hostPath: workspace, containerPath: "/workspace" }],
  });
  const home = client.sprite(sandbox.id);
  if (home === undefined) throw new Error("sprite missing");
  await writeFile(join(home.dir, "workspace", "blob.bin"), Buffer.alloc(64, 1));

  process.env.SPRITE_SYNC_MAX_BYTES = "8";
  try {
    const result = await sandbox.exec("echo marker >> /workspace/marker.txt");
    expect((result as { sync?: string }).sync).toBe("skipped: too large");
  } finally {
    delete process.env.SPRITE_SYNC_MAX_BYTES;
  }
  expect((await readdir(workspace)).sort()).toEqual(["keep.txt"]);
});

test("S6 shell output streams with the exit code, and a timeout kills the process", async () => {
  const sandbox = await provider().acquire({ workspaceId: "ws1", agentId: "researcher", mounts: [] });

  const lines: string[] = [];
  const ran = await sandbox.exec("echo one; sleep 0.05; echo two", { onLine: (line) => lines.push(line) });
  expect(ran.exitCode).toBe(0);
  expect(ran.timedOut).toBe(false);
  expect(lines).toEqual(["one", "two"]);

  expect((await sandbox.exec("exit 3")).exitCode).toBe(3);

  const timedOut = await sandbox.exec("sleep 5; echo late", {
    timeoutMs: 150,
    onLine: (line) => lines.push(line),
  });
  expect(timedOut.timedOut).toBe(true);
  const home = client.sprite(sandbox.id);
  if (home === undefined) throw new Error("sprite missing");
  expect(home.command("sleep")?.killed).toBe(true);
});

test("S7 reap writes back and then deletes idle sprites; stopAll clears every sprite", async () => {
  const workspace = await agentDir();
  const sandbox = await provider().acquire({
    workspaceId: "ws1",
    agentId: "researcher",
    mounts: [{ hostPath: workspace, containerPath: "/workspace" }],
  });
  const home = client.sprite(sandbox.id);
  if (home === undefined) throw new Error("sprite missing");
  await writeFile(join(home.dir, "workspace", "late.txt"), "late");
  await new Promise((resolve) => setTimeout(resolve, 5));

  await provider().reap({ idleMs: 0 });
  expect(await readFile(join(workspace, "late.txt"), "utf8")).toBe("late");
  expect(client.sprite(sandbox.id)).toBeUndefined();

  const fresh = spriteSandboxes({ token: "t", folders: store, client });
  await fresh.acquire({ workspaceId: "ws2", agentId: "one", mounts: [] });
  await fresh.acquire({ workspaceId: "ws2", agentId: "two", mounts: [] });
  await fresh.stopAll();
  expect(client.sprites.size).toBe(0);
});

test("S8 without a token, available is false naming sprites and acquire fails with the same reason", async () => {
  const providerNoToken = spriteSandboxes({ folders: store, client, env: {} });
  const availability = await providerNoToken.available();
    expect(availability.ok).toBe(false);
  if (!availability.ok) expect(availability.reason).toContain("sprites");
  await expect(
    providerNoToken.acquire({ workspaceId: "ws", agentId: "a", mounts: [] })
  ).rejects.toThrow(/sprites/);
});

test("the env fallback FABRIC_SECRET_SPRITES authenticates the provider", async () => {
  const fallback = spriteSandboxes({
    folders: store,
    client,
    env: { FABRIC_SECRET_SPRITES: "from-env" },
  });
  await expect(fallback.available()).resolves.toEqual({ ok: true });
});

test("S9 the sprite is created with the open-web policy and no broker route in its env", async () => {
  const providerWithToken = spriteSandboxes({ token: "t", folders: store, client });
  await providerWithToken.acquire({
    workspaceId: "ws1",
    agentId: "researcher",
    env: { FABRIC_EGRESS_URL: "http://egress", FABRIC_EGRESS_TOKEN: "tok", HOME: "/home/agent" },
    mounts: [],
  });

  expect(client.lastCreateOptions?.environment).toEqual({ HOME: "/home/agent" });
  const home = client.sprite("fabric-ws1-researcher");
  if (home === undefined) throw new Error("sprite missing");
  const policy = home.policy as { rules: Array<{ action?: string; domain?: string; include?: string }> };
  expect(policy.rules.length).toBeGreaterThan(0);
  for (const rule of policy.rules) {
    expect(rule.action).toBe("allow");
    expect(rule.domain).toBeUndefined();
  }
});

test("S10 sandboxTools over the sprites provider keeps the host tool contracts at step 2", () => {
  const bashDetect = { name: "bash", argv: (command: string): string[] => ["bash", "-c", command] };
  const host = [
    shellTool({ detect: bashDetect }),
    readFileTool(),
    writeFileTool(),
    editFileTool(),
    searchFilesTool({ which: () => true }),
  ];
  const sprite = spriteSandboxes({ token: "t", folders: store, client });
  const spriteTools = sandboxTools(sprite, async () => []);

  expect(spriteTools.map((tool) => tool.name)).toEqual(host.map((tool) => tool.name));
  for (const hostTool of host) {
    const sandboxed = spriteTools.find((tool) => tool.name === hostTool.name);
    if (sandboxed === undefined) throw new Error(`no sandboxed ${hostTool.name}`);
    expect(z.toJSONSchema(sandboxed.parameters)).toEqual(z.toJSONSchema(hostTool.parameters));
    expect(sandboxed.effect).toBe(hostTool.effect);
    expect(sandboxed.gate).toBe(hostTool.gate);
    expect(sandboxed.kind).toBe(hostTool.kind);
    expect(sandboxed.step).toBe(2);
  }

  const shell = spriteTools.find((tool) => tool.name === "shell");
  if (shell === undefined) throw new Error("no sandboxed shell");
  for (const needle of ["bash", "sandbox", "/workspace", "/projects/"]) {
    expect(shell.description).toContain(needle);
  }
});

// ---------------------------------------------------------------------------
// S11 — the live API, only with SPRITES_LIVE_TEST and a token
// ---------------------------------------------------------------------------

const LIVE_TOKEN = process.env.FABRIC_SECRET_SPRITES ?? process.env.SPRITES_TOKEN;

test
  .skipIf(!process.env.SPRITES_LIVE_TEST || !LIVE_TOKEN)
  ("S11 live: acquire, exec, write-back and delete against the real API", async () => {
    const { SpritesClient } = await import("@fly/sprites");
    const liveBase = await mkdtemp(path.join(tmpdir(), "fabric-sprites-live-"));
    const liveStore = localFolders(join(liveBase, "folders"));
    const probe = `probe-${Date.now().toString(36)}`;
    const providerLive = spriteSandboxes({
      token: LIVE_TOKEN,
      folders: liveStore,
      client: new SpritesClient(LIVE_TOKEN ?? ""),
      namePrefix: "fabric-live",
    });
    try {
      const sandbox = await providerLive.acquire({ workspaceId: "live", agentId: probe, mounts: [] });
      const greeted = await sandbox.exec("echo hi");
      expect(greeted.exitCode).toBe(0);
      expect(greeted.tail.join("\n")).toContain("hi");

      const wrote = await sandbox.exec("printf live > /workspace/live.txt");
      expect(wrote.exitCode).toBe(0);
      const home = await liveStore.path({ kind: "agent", name: probe });
      expect(await readFile(join(home, "live.txt"), "utf8")).toBe("live");
    } finally {
      await providerLive.stopAll().catch(() => {});
      await rm(liveBase, { recursive: true, force: true });
    }
  });
