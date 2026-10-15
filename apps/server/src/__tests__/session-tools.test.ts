// ANY-81 T14 — the listed cases J10..J14, verbatim from the card. The server
// half: the async stamp wears the toolset built from the agent's registry row,
// the seam registry feeds it, the vault lives on the runtime, the create route
// still 404s before any stream exists, and the worker port's runDir is
// FABRIC_WORK_DIR's agents/<id>. Embedded PGlite, no network.
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openStore, type RuntimeStore } from "@fabric/runtime";
import { afterEach, expect, test } from "vitest";
import { Hono } from "hono";
import { createRegistry } from "@fabric/tools";
import { builtinTools } from "@fabric/tools/builtin";
import { hostTools } from "@fabric/tools/host";
import {
  setSessionAgents,
  setSessionToolRegistry,
  sessionTurnDefinition,
  setRuntime,
  startRuntime,
  workerPorts,
  type FabricRuntime,
} from "../runtime/bootstrap";
import { danaSessionDef, withBridges, type SpecialistAgent } from "@fabric/agents/session";
import { InProcessLiveBus } from "../runtime/live-bus";
import { sessions } from "../routes/sessions";

const WORKSPACE = "local";

const RESEARCHER: SpecialistAgent = {
  id: "researcher",
  name: "Renna",
  role: "Research",
  instructions: "# SOUL.md\n\nYou are the studio's researcher.",
  tools: [{ name: "exa.search", policy: "allowed" }],
};

const DANA_ROW: SpecialistAgent = {
  id: "dana",
  name: "Dana",
  tools: [
    { name: "record_disposition", policy: "allowed" },
    { name: "propose_team", policy: "allowed" },
    { name: "propose_specialist", policy: "allowed" },
    { name: "handoff_to_team", policy: "allowed" },
  ],
};

let dataDir: string | undefined;
let rt: FabricRuntime | undefined;

afterEach(async () => {
  setRuntime(undefined);
  setSessionToolRegistry(undefined);
  if (rt) await rt.stop();
  rt = undefined;
  delete process.env.FABRIC_SECRET_EXA;
  delete process.env.FABRIC_SECRET_AGENTMAIL;
  if (dataDir !== undefined) {
    await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  }
});

const boot = async (env: Record<string, string | undefined> = {}): Promise<FabricRuntime> => {
  dataDir = await mkdtemp(path.join(tmpdir(), "fabric-t14-server-"));
  rt = await startRuntime(
    {
      RUNTIME_PGLITE_DIR: dataDir,
      MODEL_PORT: "test",
      FABRIC_MASTER_KEY_FILE: path.join(dataDir, "master.key"),
      ...env,
    },
    { worker: false },
  );
  return rt;
};

const stamp = async (agentId: string): Promise<Record<string, unknown>> =>
  (await sessionTurnDefinition(agentId)) as Record<string, unknown>;

const toolsOf = (definition: Record<string, unknown>) => ({
  tools: definition.tools as string[],
  // a stamp without survivors carries no policy map; normalize for the `in` checks
  policy: (definition.toolPolicy ?? {}) as Record<string, { access: string; gate: string; kind: string }>,
  effects: definition.toolEffects as Record<string, string>,
});

// -- J10 -----------------------------------------------------------------------

test("J10 the stamp: the researcher's exa.search row becomes web_search with its policy; dana's row maps to nothing new", async () => {
  setSessionAgents([RESEARCHER, DANA_ROW]);
  setSessionToolRegistry(createRegistry(builtinTools({ sendFrom: "sana@agentmail.to" })));

  const researcher = await stamp("researcher");
  const { tools, policy } = toolsOf(researcher);
  expect(tools).toContain("web_search");
  expect(policy.web_search).toEqual({ access: "allowed", gate: "none", kind: "read" });

  // dana's row names session tools and legacy names with no registry presence:
  // her stamp deep-equals the S8b stamp
  const dana = await stamp("dana");
  expect(dana).toEqual(withBridges(danaSessionDef()) as Record<string, unknown>);
});

// -- J11 -----------------------------------------------------------------------

test(
  "J11 FABRIC_SEND_FROM unset leaves no send on any stamp; set, send asks with gate always",
  async () => {
  const sender: SpecialistAgent = { ...RESEARCHER, id: "sender", tools: [{ name: "agentmail.send", policy: "allowed" }] };
  setSessionAgents([sender]);

    // boot 1: no sendFrom -> the registry carries no send -> the row drops silently
  await boot({});
  const without = toolsOf(await stamp("sender"));
  expect(without.tools).not.toContain("send");
  expect("send" in without.policy).toBe(false);

  // boot 2: the identity set -> send, gated always
    await boot({ FABRIC_SEND_FROM: "sana@agentmail.to" });
  const withSend = toolsOf(await stamp("sender"));
  expect(withSend.tools).toContain("send");
  expect(withSend.policy.send?.gate).toBe("always");
  },
  // two full runtime boots (PGlite + vault + registry); the repo's 30s budget, as in runtime/tools
  30_000,
);

// -- J12 -----------------------------------------------------------------------

test("J12 startRuntime creates the 0600 master key, mounts the vault, and the env fallback serves FABRIC_SECRET_EXA as exa", async () => {
  process.env.FABRIC_SECRET_EXA = "from-the-env";
  const runtime = await boot({});
  expect(runtime.vault).toBeDefined();

  const keyPath = path.join(dataDir!, "master.key");
  const info = await stat(keyPath);
  expect(info.mode & 0o777).toBe(0o600);

  // env fallback: no table row yet, the env serves exa to every agent
  expect(await runtime.vault!.get("exa", { agentId: "anyone" })).toBe("from-the-env");

  // the table round-trips under the same key
  await runtime.vault!.put("agentmail", "table-value", { agents: ["dana"] });
  expect(await runtime.vault!.get("agentmail", { agentId: "dana" })).toBe("table-value");
  await expect(runtime.vault!.get("agentmail", { agentId: "writer" })).rejects.toThrow("secret denied: agentmail");
});

// -- J13 -----------------------------------------------------------------------

test("J13 POST /sessions: unknown agent 404s with no stream; the researcher's run.created carries the toolset", async () => {
  setSessionAgents([RESEARCHER, DANA_ROW]);
  const runtime = await boot({ FABRIC_SEND_FROM: "sana@agentmail.to" });

  const app = (): Hono => new Hono().route("/api", sessions);
  const post = (body: unknown) =>
    app().request("/api/sessions", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

    const before = await runtime.store.transaction((tx) => tx.query("select id from streams"));
  const missing = await post({ agentId: "ghost" });
  expect(missing.status).toBe(404);
  const after = await runtime.store.transaction((tx) => tx.query("select id from streams"));
  expect(after).toEqual(before);

  const created = await post({ agentId: "researcher" });
  expect(created.status).toBe(200);
  const { sessionId } = (await created.json()) as { sessionId: string };
  const events = (await runtime.store.readStream(`session:${sessionId}`, { workspaceId: WORKSPACE })) as unknown as {
    type: string;
    payload: Record<string, unknown>;
  }[];
  const run = events.find((event) => event.type === "run.created");
  expect(run).toBeDefined();
  const definition = (run!.payload.definition ?? {}) as Record<string, unknown>;
  const { tools, policy } = toolsOf(definition);
  expect(tools).toContain("web_search");
  expect(policy.web_search).toMatchObject({ access: "allowed", gate: "none" });
  expect((run!.payload.definition as Record<string, unknown>).userChosenAgent).toBe("researcher");
});

// -- J14 -----------------------------------------------------------------------

test("J14 workerPorts' registry scope runs host tools under FABRIC_WORK_DIR/agents/<id>, creating it", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "fabric-t14-work-"));
  const store: RuntimeStore = await openStore({ driver: "pglite", dataDir: path.join(workDir, "pg") });
  setSessionToolRegistry(createRegistry(hostTools()));
  try {
    const ports = workerPorts(
      { MODEL_PORT: "test", FABRIC_WORK_DIR: workDir },
      new InProcessLiveBus(),
      undefined,
      store,
    );

    const result = await ports.tools!.run(
      "write_file",
      { path: "notes/deep.txt", content: "hi" },
      { onLine: () => {}, callId: "c1", streamId: "session:x", workspaceId: WORKSPACE, agentId: "researcher" },
    );
    expect(result).toMatchObject({ ok: true });
    expect(await readFile(path.join(workDir, "agents", "researcher", "notes", "deep.txt"), "utf8")).toBe("hi");
  } finally {
    setSessionToolRegistry(undefined);
    await store.close();
    await rm(workDir, { recursive: true, force: true });
  }
});
