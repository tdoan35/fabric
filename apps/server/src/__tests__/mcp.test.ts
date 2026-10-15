// ANY-84 M6 — the listed cases Y1, Y2, Y3, Y4, Y7, Y8, Y9 and Y10, verbatim
// from the card. The server half: the stamp (through startRuntime's wiring)
// lists an attached server's tools with their policy and effects, skips
// unattached and needs_auth servers with no request, survives a dead port
// (the session is still created), caches discovery for 24 h, and the run
// port validates, re-checks the attachment and carries the OAuth bearer.
// A real MCP server on 127.0.0.1, embedded PGlite, no external network.
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, afterEach, test } from "vitest";
import { Hono } from "hono";
import { ensureMcpSchema, mcpServers } from "@fabric/tools/mcp";
import type { SpecialistAgent } from "@fabric/agents/session";
import {
  sessionTurnDefinition,
  setRuntime,
  setSessionAgents,
  setSessionMcp,
  setSessionSkills,
  setSessionToolRegistry,
  startRuntime,
  RUNTIME_WORKSPACE,
  workerPorts,
  type FabricRuntime,
  type RuntimeEnv,
} from "../runtime/bootstrap";
import { InProcessLiveBus } from "../runtime/live-bus";
import { sessions } from "../routes/sessions";
import { startTestMcpServer, type TestMcpServer } from "./fixtures/mcp/server";

const RESEARCHER: SpecialistAgent = {
  id: "researcher",
  name: "Renna",
  role: "Research",
  instructions: "# SOUL.md\n\nYou are the studio's researcher.",
};

const WRITER: SpecialistAgent = {
  id: "writer",
  name: "Wes",
  role: "Writing",
  instructions: "# SOUL.md\n\nYou are the studio's writer.",
};

const app = (): Hono => new Hono().route("/api", sessions);

const postJson = async (pathName: string, body: unknown): Promise<Response> =>
  app().request(pathName, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

interface StoredEventLike {
  type: string;
  payload: Record<string, unknown>;
}

/** The stamped definition's extra shape (T14's test twin). */
type StampedDef = {
  tools?: string[];
  toolSchemas?: { name: string }[];
  toolEffects?: Record<string, unknown>;
  toolPolicy?: Record<string, { access?: string; gate?: string; kind?: string }>;
};

const stamp = async (agentId: string): Promise<StampedDef> =>
  (await sessionTurnDefinition(agentId)) as StampedDef;

let rt: FabricRuntime | undefined;
let env: RuntimeEnv | undefined;
let dataDir: string | undefined;
let fixture: TestMcpServer | undefined;

afterEach(async () => {
  setRuntime(undefined);
  setSessionToolRegistry(undefined);
  setSessionSkills(undefined);
  setSessionMcp(undefined);
  setSessionAgents([]);
  if (rt) await rt.stop();
  rt = undefined;
  env = undefined;
  if (fixture) await fixture.close();
  fixture = undefined;
  if (dataDir !== undefined) {
    await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  }
});

/** Boots the runtime (PGlite, no workers) plus this test's MCP server, and
 * returns the workspace's mcpServers over the same store. */
const boot = async (): Promise<ReturnType<typeof mcpServers>> => {
  dataDir = await mkdtemp(path.join(tmpdir(), "fabric-m6-server-"));
  env = {
    RUNTIME_PGLITE_DIR: dataDir,
    MODEL_PORT: "test",
    FABRIC_MASTER_KEY_FILE: path.join(dataDir, "master.key"),
    FABRIC_WORK_DIR: path.join(dataDir, "work"),
  };
  setSessionAgents([RESEARCHER, WRITER]);
  rt = await startRuntime(env, { worker: false });
  fixture = await startTestMcpServer();
  await ensureMcpSchema(rt.store);
  return mcpServers(rt.store, RUNTIME_WORKSPACE);
};

/** The worker's tool port, as the decide loop would call it. */
const toolPort = () => {
  const runtime = rt!;
  const ports = workerPorts(env!, new InProcessLiveBus(), undefined, runtime.store, runtime.vault);
  if (ports.tools === undefined) throw new Error("no tool port in this fixture");
  return ports.tools;
};
const runTool = (name: string, args: Record<string, unknown>) =>
  toolPort().run(name, args, {
    agentId: "researcher",
    streamId: "session:y-case",
    workspaceId: RUNTIME_WORKSPACE,
    callId: "call-y-case",
  });

/** A URL whose port refuses connections: bind, then close. */
async function refusingUrl(): Promise<string> {
  const http = createServer();
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as { port: number };
  await new Promise<void>((resolve) => http.close(() => resolve()));
  return `http://127.0.0.1:${port}/mcp`;
}

// -- Y1 ------------------------------------------------------------------------

test("Y1 Stamp: researcher is attached to `local` (lookup/create/upsert); the definition lists the three mcp_ names with read/external kinds, gate mode, access allowed, effects read/once/idempotent", async () => {
  const servers = await boot();
  await servers.add({ name: "local", url: fixture!.url, auth: "none" });
  await servers.attach("local", "researcher");

  const def = await stamp("researcher");
  const mcpNames = (def.tools ?? []).filter((name) => name.startsWith("mcp_")).sort();
  expect(mcpNames).toEqual(["mcp_local_create", "mcp_local_lookup", "mcp_local_upsert"]);
  expect((def.toolSchemas ?? []).map((tool) => tool.name)).toEqual(
    expect.arrayContaining(mcpNames),
  );

  expect(def.toolPolicy?.mcp_local_lookup).toEqual({ access: "allowed", gate: "mode", kind: "read" });
  expect(def.toolPolicy?.mcp_local_create).toEqual({ access: "allowed", gate: "mode", kind: "external" });
  expect(def.toolPolicy?.mcp_local_upsert).toEqual({ access: "allowed", gate: "mode", kind: "external" });

  expect(def.toolEffects?.mcp_local_lookup).toBe("read");
  expect(def.toolEffects?.mcp_local_create).toBe("once");
  expect(def.toolEffects?.mcp_local_upsert).toBe("idempotent");
},
30_000,
);

// -- Y2 ------------------------------------------------------------------------

test("Y2 an agent with no attachments gets no mcp_* tools and the server's counter stays 0; a needs_auth server is skipped with no request (an attached ready server is the control)", async () => {
  const servers = await boot();
  await servers.add({ name: "local", url: fixture!.url, auth: "none" });
  await servers.attach("local", "writer");
  await servers.add({ name: "authy", url: fixture!.url, auth: "none" });
  await servers.setStatus("authy", "needs_auth", "sign in first");
  await servers.attach("authy", "researcher");

  const none = await stamp("researcher");
  expect((none.tools ?? []).filter((name) => name.startsWith("mcp_"))).toEqual([]);
  expect(fixture!.calls("tools/list")).toBe(0);

  // the control: a ready server attached to researcher does stamp its tools
  await servers.attach("local", "researcher");
  const some = await stamp("researcher");
  expect(some.tools ?? []).toContain("mcp_local_lookup");
},
30_000,
);

// -- Y3 ------------------------------------------------------------------------

test("Y3 a server whose port refuses connections: the session is still created (200), the stamp has no tools from it, and its status is error with last_error set", async () => {
  const servers = await boot();
  await servers.add({ name: "dead", url: await refusingUrl(), auth: "none" });
  await servers.attach("dead", "researcher");

  const response = await postJson("/api/sessions", { agentId: "researcher" });
  expect(response.status).toBe(200);
  const { sessionId } = (await response.json()) as { sessionId: string };

  const events = (await rt!.store.readStream(`session:${sessionId}`, {
    workspaceId: RUNTIME_WORKSPACE,
  })) as unknown as StoredEventLike[];
  const created = events.find((event) => event.type === "run.created");
  const definition = created?.payload.definition as StampedDef | undefined;
  expect((definition?.tools ?? []).filter((name) => name.startsWith("mcp_"))).toEqual([]);

  const record = await servers.get("dead");
  expect(record?.status).toBe("error");
  expect(typeof record?.lastError).toBe("string");
  expect(record!.lastError!).not.toBe("");
},
30_000,
);

// -- Y4 ------------------------------------------------------------------------

test("Y4 a second session for researcher within 24 h makes no tools/list request (the cache)", async () => {
  const servers = await boot();
  await servers.add({ name: "local", url: fixture!.url, auth: "none" });
  await servers.attach("local", "researcher");

  await stamp("researcher");
  expect(fixture!.calls("tools/list")).toBe(1);

  await stamp("researcher");
  expect(fixture!.calls("tools/list")).toBe(1);
},
30_000,
);

// -- Y7 ------------------------------------------------------------------------

test("Y7 Port: tools.run mcp_local_lookup returns ok with the server's text, and the call counter is 1", async () => {
  const servers = await boot();
  await servers.add({ name: "local", url: fixture!.url, auth: "none" });
  await servers.attach("local", "researcher");
  await stamp("researcher");

  const result = await runTool("mcp_local_lookup", { q: "x" });
  expect(result.ok).toBe(true);
  expect((result as { result?: { text?: string } }).result?.text).toBe("lookup: x");
  expect(fixture!.calls("tools/call")).toBe(1);
},
30_000,
);

// -- Y8 ------------------------------------------------------------------------

test("Y8 detached after the stamp: the same run is ok false naming the server, and the call counter is unchanged", async () => {
  const servers = await boot();
  await servers.add({ name: "local", url: fixture!.url, auth: "none" });
  await servers.attach("local", "researcher");
  await stamp("researcher");

  await servers.detach("local", "researcher");
  const result = await runTool("mcp_local_lookup", { q: "x" });
  expect(result.ok).toBe(false);
  expect((result as { error?: string }).error).toContain("not attached");
  expect((result as { error?: string }).error).toContain("local");
  expect(fixture!.calls("tools/call")).toBe(0);
},
30_000,
);

// -- Y9 ------------------------------------------------------------------------

test("Y9 invalid arguments give `invalid arguments` with the counter at 0; an unknown mcp_local_nope gives `unknown tool: mcp_local_nope`", async () => {
  const servers = await boot();
  await servers.add({ name: "local", url: fixture!.url, auth: "none" });
  await servers.attach("local", "researcher");
  await stamp("researcher");

  const invalid = await runTool("mcp_local_lookup", { q: 3 });
  expect(invalid.ok).toBe(false);
  expect((invalid as { error?: string }).error).toContain("invalid arguments");
  expect(fixture!.calls("tools/call")).toBe(0);

  const unknown = await runTool("mcp_local_nope", { q: "x" });
  expect(unknown.ok).toBe(false);
  expect((unknown as { error?: string }).error).toBe("unknown tool: mcp_local_nope");
},
30_000,
);

// -- Y10 -----------------------------------------------------------------------

test("Y10 OAuth: tokens in the vault under mcp_secure_oauth reach the server as a Bearer on the call; with no tokens the run is ok false and the status is needs_auth", async () => {
  const servers = await boot();
  await servers.add({ name: "secure", url: fixture!.url, auth: "oauth" });
  await servers.attach("secure", "researcher");

  // A synthetic test token — never a real credential.
  const token = "test-bearer-y10";
  await rt!.vault.put(
    "mcp_secure_oauth",
    JSON.stringify({
      accessToken: token,
      tokenEndpoint: "http://127.0.0.1:9/token",
      clientId: "fabric-test",
      resource: fixture!.url,
    }),
    { agents: ["researcher"] },
  );

  const result = await runTool("mcp_secure_lookup", { q: "x" });
  expect(result.ok).toBe(true);
  expect(fixture!.authorizations().at(-1)).toBe(`Bearer ${token}`);

  await servers.add({ name: "sealed", url: fixture!.url, auth: "oauth" });
  await servers.attach("sealed", "researcher");
  const denied = await runTool("mcp_sealed_lookup", { q: "x" });
  expect(denied.ok).toBe(false);
  expect((await servers.get("sealed"))?.status).toBe("needs_auth");
},
30_000,
);
