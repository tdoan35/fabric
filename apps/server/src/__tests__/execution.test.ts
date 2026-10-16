// ANY-91 T19 — the execution-switch cases that need no routes and no real
// docker: V1 (the host path stays byte-identical), V2 (docker swaps the five
// host tools for the step-2 sandbox ones over a fake provider, policies and
// gates unchanged), V3 (an unavailable provider refuses the boot), V4 (a
// registry call acquires with the grant mounts and an egress token the
// broker's store resolves), V5 (the reaper takes idle sandboxes and their
// tokens, fake clock) and V9 (the broker lives in docker mode only and is
// fail-closed with no rules). Embedded PGlite; the provider, the broker bind
// host and the clock are injected.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, test } from "vitest";
import { hostTools } from "@fabric/tools/host";
import type {
  Sandbox,
  SandboxAcquireRequest,
  SandboxAvailability,
  SandboxProvider,
} from "@fabric/tools/sandbox";
import {
  RUNTIME_WORKSPACE,
  getRuntime,
  sessionTurnDefinition,
  setSessionAgents,
  setSessionToolRegistry,
  setRuntime,
  startRuntime,
  workerPorts,
  type FabricRuntime,
} from "../runtime/bootstrap";
import type { SpecialistAgent } from "@fabric/agents/session";

const WORKSPACE = RUNTIME_WORKSPACE;

/** The T19 row: the legacy name that maps to the five host-tool names. */
const RESEARCHER: SpecialistAgent = {
  id: "researcher",
  name: "Renna",
  role: "Research",
  tools: [{ name: "sprite.exec", policy: "allowed" }],
};

const FIVE = ["shell", "read_file", "write_file", "edit_file", "search_files"] as const;

// -- fixtures -------------------------------------------------------------------

/** A fake `SandboxProvider`: records acquires and reaps, one live sandbox per
 * agent, idle clock shared with the layer through the injected `now`. */
const fakeProvider = () => {
  const state = {
    acquires: [] as SandboxAcquireRequest[],
    reapCalls: [] as Array<{ idleMs?: number } | undefined>,
    live: new Map<string, { lastUsed: number }>(),
    stopped: false,
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
      state.reapCalls.push(opts);
      const idleMs = opts?.idleMs ?? 300_000;
      for (const [agent, entry] of [...state.live]) {
        if (state.clock - entry.lastUsed >= idleMs) state.live.delete(agent);
      }
    },
    async stopAll() {
      state.stopped = true;
      state.live.clear();
    },
    async available() {
      return state.availability;
    },
  };

  return { provider, state };
};

type ExecOpts = { provider?: SandboxProvider; brokerHost?: string; now?: () => number };

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

const boot = async (env: Record<string, string> = {}, exec: ExecOpts = {}): Promise<FabricRuntime> => {
  dataDir = await mkdtemp(path.join(tmpdir(), "fabric-t19-"));
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

const definitionOf = async (agentId: string) => {
  const def = (await sessionTurnDefinition(agentId)) as Record<string, unknown>;
  return {
    tools: def.tools as string[],
    effects: def.toolEffects as Record<string, string>,
    policy: (def.toolPolicy ?? {}) as Record<string, { access: string; gate: string; kind: string }>,
  };
};

/** The registry port over the boot's registry, run once. */
const runTool = async (
    runtime: FabricRuntime,
    name: string,
    args: Record<string, unknown>,
    agentId = "researcher",
  ) => {
  const ports = workerPorts(
    { MODEL_PORT: "test", FABRIC_WORK_DIR: workDir },
    runtime.live,
    undefined,
    runtime.store,
    runtime.vault,
  );
  return ports.tools!.run(name, args as never, {
    onLine: () => {},
    callId: "c1",
    streamId: "session:x",
    workspaceId: WORKSPACE,
    agentId,
  });
};

// -- V1 -----------------------------------------------------------------------

test("V1 FABRIC_EXECUTION unset: host mode, and the stamp and port are byte-identical to T14's", async () => {
  setSessionAgents([RESEARCHER]);
  const runtime = await boot({});
  // the switch reports host, the workdir layout is T14's
  expect(runtime.execution?.mode).toBe("host");

  const { tools, effects, policy } = await definitionOf("researcher");
  const hostDefs = hostTools();
  for (const name of FIVE) {
    expect(tools).toContain(name);
    const hostDef = hostDefs.find((def) => def.name === name);
    expect(hostDef).toBeDefined();
    // the stamp's row is the host tool's, byte for byte: same effect, same
    // gate and kind, access allowed by the row
    expect(policy[name]).toEqual({
      access: "allowed",
      gate: hostDef!.gate,
      kind: hostDef!.kind,
    });
    expect(effects[name]).toBe(hostDef!.effect);
  }

  // the port is the host path: the file lands directly, no provider in between
  const result = await runTool(runtime, "write_file", { path: "host.txt", content: "host" });
  expect(result).toMatchObject({ ok: true });
  expect(await readFile(path.join(workDir!, "agents", "researcher", "host.txt"), "utf8")).toBe("host");
});

// -- V2 -----------------------------------------------------------------------

test("V2 docker: the same five names at step 2 with unchanged policies and gates", async () => {
  setSessionAgents([RESEARCHER]);
  const fake = fakeProvider();
  const runtime = await boot({ FABRIC_EXECUTION: "docker" }, {
    provider: fake.provider,
    brokerHost: "127.0.0.1",
  });

  const { tools, effects, policy } = await definitionOf("researcher");
  const hostDefs = hostTools();
  for (const name of FIVE) {
    expect(tools).toContain(name);
    const hostDef = hostDefs.find((def) => def.name === name)!;
    // policies and gates are the host tools': T3 still asks under `ask`
    expect(policy[name]).toEqual({
      access: "allowed",
      gate: hostDef.gate,
      kind: hostDef.kind,
    });
    expect(effects[name]).toBe(hostDef.effect);
  }

  // step 2, behaviorally: the registry call runs inside the sandbox
  const before = fake.state.acquires.length;
  const result = await runTool(runtime, "write_file", { path: "out.txt", content: "hi" });
  expect(result).toMatchObject({ ok: true });
  expect(fake.state.acquires.length).toBe(before + 1);
});

// -- V3 -----------------------------------------------------------------------

test("V3 docker with the provider unavailable: startRuntime rejects with the reason, no runtime", async () => {
  setSessionAgents([RESEARCHER]);
  const fake = fakeProvider();
  fake.state.availability = { ok: false, reason: "no docker daemon on this box" };

  await expect(
    boot({ FABRIC_EXECUTION: "docker" }, { provider: fake.provider, brokerHost: "127.0.0.1" }),
  ).rejects.toThrow("no docker daemon on this box");
  // refused, not fallen back: no runtime came up, so no worker did either
  expect(getRuntime()).toBeUndefined();
});

// -- V4 -----------------------------------------------------------------------

test("V4 a registry call acquires with the grant mounts, agent folder first, and an egress token", async () => {
  setSessionAgents([RESEARCHER]);
  const fake = fakeProvider();
  const runtime = await boot({ FABRIC_EXECUTION: "docker" }, {
    provider: fake.provider,
    brokerHost: "127.0.0.1",
  });
  const execution = runtime.execution!;
  await execution.grants.grant("alpha", "researcher", "write");

  const result = await runTool(runtime, "write_file", { path: "out.txt", content: "hi" });
  expect(result).toMatchObject({ ok: true });

  const acquire = fake.state.acquires.at(-1)!;
  expect(acquire.workspaceId).toBe(WORKSPACE);
  expect(acquire.agentId).toBe("researcher");
  // the agent folder `write` first, then the granted projects with their access
  expect(acquire.mounts).toEqual([
    { hostPath: path.join(workDir!, "agents", "researcher"), containerPath: "/workspace", readOnly: false },
    { hostPath: path.join(workDir!, "projects", "alpha"), containerPath: "/projects/alpha", readOnly: false },
  ]);

  // the env carries the egress token; the broker's store resolves it
  const token = (acquire.env ?? {})["FABRIC_EGRESS_TOKEN"];
  expect(typeof token).toBe("string");
  expect(execution.tokens!.resolve(token as string)).toEqual({
    workspaceId: WORKSPACE,
    agentId: "researcher",
  });
});

// -- V5 -----------------------------------------------------------------------

test("V5 reaping (fake clock): the idle sandbox goes and its egress token no longer resolves", async () => {
  setSessionAgents([RESEARCHER]);
  const fake = fakeProvider();
  const runtime = await boot({ FABRIC_EXECUTION: "docker" }, {
    provider: fake.provider,
    brokerHost: "127.0.0.1",
    now: () => fake.state.clock,
  });
  const execution = runtime.execution!;

  await runTool(runtime, "write_file", { path: "out.txt", content: "hi" });
  const token = fake.state.acquires.at(-1)!.env?.["FABRIC_EGRESS_TOKEN"] as string;
  expect(execution.tokens!.resolve(token)).not.toBeNull();
  expect(fake.state.live.has("researcher")).toBe(true);

  // past the idle window the reaper takes the sandbox and revokes the token
  fake.state.clock += 300_000 + 1;
  await execution.reap();
  expect(fake.state.live.has("researcher")).toBe(false);
  expect(execution.tokens!.resolve(token)).toBeNull();
});

// -- V9 -----------------------------------------------------------------------

test("V9 the broker is docker-mode only and fail-closed with no rules", async () => {
  setSessionAgents([RESEARCHER]);
  const fake = fakeProvider();
  const runtime = await boot({ FABRIC_EXECUTION: "docker" }, {
    provider: fake.provider,
    brokerHost: "127.0.0.1",
  });
  const execution = runtime.execution!;

  // up, on the injected (production: brokerBindHost()) address, token store shared
  expect(execution.broker).toBeDefined();
  expect(execution.broker!.url.startsWith("http://127.0.0.1:")).toBe(true);
  expect(execution.tokens).toBeDefined();

  // no rules file -> every request refused, token or not
  const token = execution.tokens!.issue({ workspaceId: WORKSPACE, agentId: "researcher", ttlMs: 60_000 });
  const refused = await fetch(`${execution.broker!.url}/api.github.com/repos/x/y`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(refused.status).toBe(403);
  const anonymous = await fetch(`${execution.broker!.url}/api.github.com/repos/x/y`);
  expect(anonymous.status).toBe(403);
  void token;

  // host mode: no broker, no token store
  const hostRuntime = await boot({});
    expect(hostRuntime.execution?.broker).toBeUndefined();
  expect(hostRuntime.execution?.tokens).toBeUndefined();
});
