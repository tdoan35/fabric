// ANY-91 T19 — the route cases: V6 (project folders: create, grant, list,
// revoke, delete, the 400/409/404 edges), V7 (reset workspace: the agent's
// sandbox stops, its folder empties, the other agents' folders stay) and V8
// (GET /execution reports mode, availability and live sandboxes). Real routes
// over a booted runtime; embedded PGlite; the sandbox provider faked, the
// broker host and the clock injected.
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { Hono } from "hono";
import { afterEach, expect, test } from "vitest";
import type {
  Sandbox,
  SandboxAcquireRequest,
  SandboxAvailability,
  SandboxProvider,
} from "@fabric/tools/sandbox";
import {
  RUNTIME_WORKSPACE,
  setSessionAgents,
  setSessionToolRegistry,
  setRuntime,
  startRuntime,
  workerPorts,
  type FabricRuntime,
} from "../runtime/bootstrap";
import { folders } from "../routes/folders";
import type { SpecialistAgent } from "@fabric/agents/session";

const WORKSPACE = RUNTIME_WORKSPACE;

const RESEARCHER: SpecialistAgent = {
  id: "researcher",
  name: "Renna",
  role: "Research",
  tools: [{ name: "sprite.exec", policy: "allowed" }],
};

const WRITER: SpecialistAgent = {
  id: "writer",
  name: "Wren",
  role: "Writing",
  tools: [],
};

// -- fixtures -------------------------------------------------------------------

/** The same fake provider the execution cases use: recorded acquires and
 * reaps, one live sandbox per agent, the layer's injected clock. */
const fakeProvider = () => {
  const state = {
    acquires: [] as SandboxAcquireRequest[],
    live: new Map<string, { lastUsed: number }>(),
    clock: 1_000,
    availability: { ok: true } as SandboxAvailability,
  };

  const sandbox = (agentId: string, id: string): Sandbox => ({
    id,
    async exec() {
      const entry = state.live.get(agentId);
      if (entry !== undefined) entry.lastUsed = state.clock;
      return { exitCode: 0, timedOut: false, tail: [] };
    },
    async putArchive() {},
    getArchive: () => new PassThrough() as never,
  });

  const provider: SandboxProvider = {
    async acquire(request) {
      state.acquires.push(request);
      state.live.set(request.agentId, { lastUsed: state.clock });
      return sandbox(request.agentId, `${request.agentId}-1`);
    },
    async reap(opts) {
      const idleMs = opts?.idleMs ?? 300_000;
      for (const [agent, entry] of [...state.live]) {
        if (state.clock - entry.lastUsed >= idleMs) state.live.delete(agent);
      }
    },
    async stopAll() {
      state.live.clear();
    },
    async available() {
      return state.availability;
    },
  };

  return { provider, state };
};

const app = (): Hono => new Hono().route("/api", folders);

const call = (method: string, path: string, body?: unknown) =>
  app().request(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { "content-type": "application/json" },
  });

/** True when the path exists as a directory. */
const dirExists = async (dir: string): Promise<boolean> => {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
};

/** True when the directory exists and holds nothing. */
const dirEmpty = async (dir: string): Promise<boolean> => {
  if (!(await dirExists(dir))) return true;
  const { readdir } = await import("node:fs/promises");
  return (await readdir(dir)).length === 0;
};

let dataDir: string | undefined;
let workDir: string | undefined;
let rt: FabricRuntime | undefined;

afterEach(async () => {
  setRuntime(undefined);
  setSessionToolRegistry(undefined);
  if (rt !== undefined) await rt.stop();
  rt = undefined;
  if (dataDir !== undefined) {
    await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
    workDir = undefined;
  }
});

const boot = async (
  env: Record<string, string> = {},
  exec: { provider?: SandboxProvider; brokerHost?: string; now?: () => number } = {},
): Promise<FabricRuntime> => {
  dataDir = await mkdtemp(path.join(tmpdir(), "fabric-t19-routes-"));
  workDir = path.join(dataDir, "work");
  rt = await startRuntime(
    {
      RUNTIME_PGLITE_DIR: dataDir,
      MODEL_PORT: "test",
      FABRIC_MASTER_KEY_FILE: path.join(dataDir, "master.key"),
      FABRIC_WORK_DIR: workDir,
      ...env,
    },
    { worker: false, ...exec },
  );
  return rt;
};

/** One registry-tool run as `agentId`, through the boot's sandboxed registry. */
const runTool = (
  runtime: FabricRuntime,
  name: string,
  args: Record<string, unknown>,
  agentId = "researcher",
): Promise<unknown> =>
  workerPorts(
    { MODEL_PORT: "test", FABRIC_WORK_DIR: workDir },
    runtime.live,
    undefined,
    runtime.store,
    runtime.vault,
  ).tools!.run(name, args as never, {
    onLine: () => {},
    callId: "c1",
    streamId: "session:x",
    workspaceId: WORKSPACE,
    agentId,
  });

// -- V6 -----------------------------------------------------------------------

test("V6 project routes: create, grant read, list, revoke, delete; 400 bad name; 409 duplicate", async () => {
  setSessionAgents([RESEARCHER, WRITER]);
  const runtime = await boot({});
  const execution = runtime.execution!;

  const created = await call("POST", "/api/folders/projects", { name: "alpha" });
  expect(created.status).toBe(201);
  await expect(dirExists(path.join(workDir!, "projects", "alpha"))).resolves.toBe(true);

  const duplicate = await call("POST", "/api/folders/projects", { name: "alpha" });
  expect(duplicate.status).toBe(409);

  const bad = await call("POST", "/api/folders/projects", { name: "Alpha" });
  expect(bad.status).toBe(400);

  const granted = await call("PUT", "/api/folders/projects/alpha/agents/researcher", { access: "read" });
  expect(granted.status).toBe(200);

  const listed = await call("GET", "/api/folders/projects");
  expect(listed.status).toBe(200);
  await expect(listed.json()).resolves.toEqual([
    { name: "alpha", agents: [{ agentId: "researcher", access: "read" }] },
  ]);

  const revoked = await call("DELETE", "/api/folders/projects/alpha/agents/researcher");
  expect(revoked.status).toBe(204);
  const afterRevoke = await call("GET", "/api/folders/projects");
  await expect(afterRevoke.json()).resolves.toEqual([{ name: "alpha", agents: [] }]);

  // edges: a bad access, an unknown agent under the loaded snapshot, an
  // unknown project
  const badAccess = await call("PUT", "/api/folders/projects/alpha/agents/researcher", { access: "rw" });
  expect(badAccess.status).toBe(400);
  const ghostAgent = await call("PUT", "/api/folders/projects/alpha/agents/ghost", { access: "read" });
  expect(ghostAgent.status).toBe(404);
  const ghostProject = await call("PUT", "/api/folders/projects/ghosty/agents/researcher", { access: "read" });
  expect(ghostProject.status).toBe(404);

  const removed = await call("DELETE", "/api/folders/projects/alpha");
  expect(removed.status).toBe(204);
  await expect(dirExists(path.join(workDir!, "projects", "alpha"))).resolves.toBe(false);
  await expect(execution.grants.agentsFor("alpha")).resolves.toEqual([]);
});

// -- V7 -----------------------------------------------------------------------

test("V7 DELETE /agents/researcher/workspace stops researcher's sandbox, empties the folder; writer untouched", async () => {
  setSessionAgents([RESEARCHER, WRITER]);
  const fake = fakeProvider();
  const runtime = await boot({ FABRIC_EXECUTION: "docker" }, {
    provider: fake.provider,
    brokerHost: "127.0.0.1",
  });
  const execution = runtime.execution!;

  // researcher: folder content and a live sandbox (a registry call); writer:
  // folder content, never ran
  await mkdir(path.join(workDir!, "agents", "researcher"), { recursive: true });
  await writeFile(path.join(workDir!, "agents", "researcher", "notes.txt"), "scratch");
  await mkdir(path.join(workDir!, "agents", "writer"), { recursive: true });
  await writeFile(path.join(workDir!, "agents", "writer", "draft.txt"), "kept");
  const run = await runTool(runtime, "write_file", { path: "out.txt", content: "hi" });
  expect(run).toMatchObject({ ok: true });
  const token = fake.state.acquires.at(-1)!.env?.["FABRIC_EGRESS_TOKEN"] as string;

  const response = await call("DELETE", "/api/agents/researcher/workspace");
  expect(response.status).toBe(204);

  // the sandbox is gone and the token with it
  expect(fake.state.live.has("researcher")).toBe(false);
  expect(execution.tokens!.resolve(token)).toBeNull();
  // the agent folder is empty; the writer's folder is untouched
  expect(await dirEmpty(path.join(workDir!, "agents", "researcher"))).toBe(true);
  expect(await readFile(path.join(workDir!, "agents", "writer", "draft.txt"), "utf8")).toBe("kept");
});

// -- V8 -----------------------------------------------------------------------

test("V8 GET /execution reports the mode, availability and live sandboxes", async () => {
  setSessionAgents([RESEARCHER, WRITER]);

  // host: the mode, available, no sandboxes
  await boot({});
  const hostResponse = await call("GET", "/api/execution");
  expect(hostResponse.status).toBe(200);
  await expect(hostResponse.json()).resolves.toEqual({ mode: "host", available: true, sandboxes: [] });

  // docker: the live sandboxes after a registry call
  const fake = fakeProvider();
  const runtime = await boot({ FABRIC_EXECUTION: "docker" }, {
    provider: fake.provider,
    brokerHost: "127.0.0.1",
  });
  const empty = await call("GET", "/api/execution");
  await expect(empty.json()).resolves.toEqual({ mode: "docker", available: true, sandboxes: [] });

    const run = await runTool(runtime, "write_file", { path: "out.txt", content: "hi" });
  expect(run).toMatchObject({ ok: true });

  const response = await call("GET", "/api/execution");
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    mode: string;
    available: boolean;
    sandboxes: Array<{ agentId: string; idleMs: number }>;
  };
  expect(body.mode).toBe("docker");
  expect(body.available).toBe(true);
  expect(body.sandboxes).toHaveLength(1);
  expect(body.sandboxes[0]!.agentId).toBe("researcher");
  expect(typeof body.sandboxes[0]!.idleMs).toBe("number");
});
