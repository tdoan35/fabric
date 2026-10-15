// ANY-85 M7 — the listed cases Z1–Z10, verbatim from the card. The server
// half: the MCP management routes on a real runtime (embedded PGlite, no
// workers), a real MCP test server and a local fake OAuth authorization
// server, both on 127.0.0.1, no external network. The route module is
// imported dynamically on purpose: the red commit (TDD: required) ships
// these tests before routes/mcp.ts exists, so every case fails on the
// missing route rather than on a broken import. Z10 runs last and scans
// everything Z1–Z9 observed — every response body and every captured
// console line — for the fake AS's access tokens, refresh tokens, client
// secrets and code verifiers.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, afterEach, test } from "vitest";
import { Hono } from "hono";
import type { SpecialistAgent } from "@fabric/agents/session";
import { env } from "../env";
import {
  setRuntime,
  setSessionAgents,
  setSessionMcp,
  setSessionSkills,
  setSessionToolRegistry,
  startRuntime,
  type FabricRuntime,
  type RuntimeEnv,
} from "../runtime/bootstrap";
import { startTestMcpServer, type TestMcpServer } from "./fixtures/mcp/server";
import { startFakeAuthServer, type FakeAuthServer } from "./fixtures/mcp/auth-server";

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

// TDD red: routes/mcp.ts lands in the second commit; until then every
// request below fails on the missing route.
let mcpRoutes: Hono | undefined;
const routes = async (): Promise<Hono> => (mcpRoutes ??= (await import("../routes/mcp")).mcp);

/** Z10's scan: every response body and every console line (log, error and
 * warn) the run produced. */
const bodies: string[] = [];
const capturedLogs: string[] = [];
for (const level of ["log", "error", "warn"] as const) {
  console[level] = (...args: unknown[]) => {
    capturedLogs.push(args.map((value) => String(value)).join(" "));
  };
}

/** Every fake AS the file started; Z10 scans what they issued. */
const authServers: FakeAuthServer[] = [];

let rt: FabricRuntime | undefined;
let runtimeEnv: RuntimeEnv | undefined;
let dataDir: string | undefined;
let fixture: TestMcpServer | undefined;
let secure: TestMcpServer | undefined;
let auth: FakeAuthServer | undefined;

afterEach(async () => {
  delete process.env.FABRIC_PUBLIC_URL;
  setRuntime(undefined);
  setSessionToolRegistry(undefined);
  setSessionSkills(undefined);
  setSessionMcp(undefined);
  setSessionAgents([]);
  if (rt) await rt.stop();
  rt = undefined;
  runtimeEnv = undefined;
  if (fixture) await fixture.close();
  fixture = undefined;
  if (secure) await secure.close();
  secure = undefined;
  if (auth) await auth.close();
  auth = undefined;
  if (dataDir !== undefined) {
    await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  }
});

const request = async (pathName: string, init?: RequestInit): Promise<{ status: number; text: string; type: string }> => {
  const app = new Hono().route("/api", await routes());
  const response = await app.request(`/api${pathName}`, init);
  const text = await response.text();
  bodies.push(text);
  return { status: response.status, text, type: response.headers.get("content-type") ?? "" };
};

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined
    ? {}
    : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
});
const post = (pathName: string, body?: unknown) => request(pathName, jsonInit("POST", body));
const put = (pathName: string, body?: unknown) => request(pathName, jsonInit("PUT", body));
const del = (pathName: string) => request(pathName, { method: "DELETE" });
const get = (pathName: string) => request(pathName);

/** Boots the runtime (PGlite, no workers) plus this test's plain MCP server. */
const boot = async (): Promise<void> => {
  dataDir = await mkdtemp(path.join(tmpdir(), "fabric-m7-routes-"));
  runtimeEnv = {
    RUNTIME_PGLITE_DIR: dataDir,
    MODEL_PORT: "test",
    FABRIC_MASTER_KEY_FILE: path.join(dataDir, "master.key"),
    FABRIC_WORK_DIR: path.join(dataDir, "work"),
  };
  setSessionAgents([RESEARCHER, WRITER]);
  rt = await startRuntime(runtimeEnv, { worker: false });
  fixture = await startTestMcpServer();
};

/** The OAuth pair on top of a booted runtime: a fake authorization server
 * and a protected MCP server whose 401 challenge and metadata point at it.
 * `authOptions` shape the AS (the review's follow-up 1 uses one without
 * dynamic registration). */
const securePair = async (authOptions: Parameters<typeof startFakeAuthServer>[0] = {}): Promise<void> => {
  auth = await startFakeAuthServer(authOptions);
  authServers.push(auth);
  secure = await startTestMcpServer({
    auth: {
      accepts: (authorization) => auth!.accepts(authorization),
      resourceMetadataPath: "/meta/prm",
      metadata: { authorization_servers: [auth!.issuer], scopes_supported: ["repo", "read"] },
    },
  });
};

/** Adds `secure` as an oauth server through the route, attached to researcher. */
const addSecure = async (): Promise<void> => {
  await post("/mcp/servers", { name: "secure", url: secure!.url, auth: "oauth" });
  await put("/mcp/servers/secure/agents/researcher");
};

/** The whole browser-side sign-in: start, the user approves, the callback
 * finishes. Returns the consumed state. */
const signIn = async (): Promise<string> => {
  const started = await post("/mcp/servers/secure/oauth/start");
  const authorizeUrl = authorizeUrlFrom(started.text);
  const code = auth!.approve(authorizeUrl);
  const state = new URL(authorizeUrl).searchParams.get("state")!;
  await get(`/mcp/oauth/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`);
  return state;
};

/** The authorizeUrl an oauth/start response carries, checked at the boundary. */
function authorizeUrlFrom(text: string): string {
  const parsed = JSON.parse(text) as { authorizeUrl?: unknown };
  if (typeof parsed.authorizeUrl !== "string") throw new Error("oauth/start returned no authorizeUrl");
  return parsed.authorizeUrl;
}

// -- Z1 ------------------------------------------------------------------------

test(
  "Z1 POST /mcp/servers: a valid none server → 201 ready; oauth → 201 needs_auth; a_b → 400 naming the rule; http://example.com → 400; a duplicate → 409",
  async () => {
    await boot();

    const none = await post("/mcp/servers", { name: "alpha", url: fixture!.url, auth: "none" });
    expect(none.status).toBe(201);
    expect(JSON.parse(none.text).status).toBe("ready");

    const oauthServer = await post("/mcp/servers", { name: "secure", url: "https://mcp.example/mcp", auth: "oauth" });
    expect(oauthServer.status).toBe(201);
    expect(JSON.parse(oauthServer.text).status).toBe("needs_auth");

    const badName = await post("/mcp/servers", { name: "a_b", url: fixture!.url, auth: "none" });
    expect(badName.status).toBe(400);
    expect(badName.text).toContain("must match ^[a-z][a-z0-9]{0,19}$");

    const badUrl = await post("/mcp/servers", { name: "beta", url: "http://example.com", auth: "none" });
    expect(badUrl.status).toBe(400);
    expect(badUrl.text).toContain("must be https:");

    const duplicate = await post("/mcp/servers", { name: "alpha", url: fixture!.url, auth: "none" });
    expect(duplicate.status).toBe(409);
  },
  30_000,
);

// -- Z2 ------------------------------------------------------------------------

test(
  "Z2 GET /mcp/servers lists the servers in name order with their attachments, and the JSON has no token, secret or access_token key anywhere",
  async () => {
    await boot();
    await post("/mcp/servers", { name: "alpha", url: fixture!.url, auth: "none" });
    await post("/mcp/servers", { name: "secure", url: "https://mcp.example/mcp", auth: "oauth" });
    await put("/mcp/servers/alpha/agents/researcher");
    await put("/mcp/servers/alpha/agents/writer", { access: "approval" });

    const listing = await get("/mcp/servers");
    expect(listing.status).toBe(200);
    const servers = JSON.parse(listing.text) as {
      name: string;
      url: string;
      auth: string;
      status: string;
      lastError: string | null;
      agents: { agentId: string; access: string }[];
    }[];
    expect(servers.map((server) => server.name)).toEqual(["alpha", "secure"]);
    expect(servers[0].agents).toEqual([
      { agentId: "researcher", access: "allowed" },
      { agentId: "writer", access: "approval" },
    ]);
    expect(listing.text).not.toMatch(/"(token|secret|access_token)"\s*:/);
  },
  30_000,
);

// -- Z3 ------------------------------------------------------------------------

test(
  "Z3 PUT /mcp/servers/:name/agents/:agentId attaches with allowed by default and changes the access to approval; an unknown server → 404; an unknown agent under a loaded snapshot → 404",
  async () => {
    await boot();
    await post("/mcp/servers", { name: "alpha", url: fixture!.url, auth: "none" });

    const first = await put("/mcp/servers/alpha/agents/researcher");
    expect(first.status).toBe(200);
    expect(JSON.parse(first.text)).toEqual({ server: "alpha", agentId: "researcher", access: "allowed" });

    const second = await put("/mcp/servers/alpha/agents/researcher", { access: "approval" });
    expect(second.status).toBe(200);
    expect(JSON.parse(second.text).access).toBe("approval");

    const unknownServer = await put("/mcp/servers/nope/agents/researcher");
    expect(unknownServer.status).toBe(404);

    const unknownAgent = await put("/mcp/servers/alpha/agents/ghost");
    expect(unknownAgent.status).toBe(404);
  },
  30_000,
);

// -- Z4 ------------------------------------------------------------------------

test(
  "Z4 DELETE /mcp/servers/:name/agents/:agentId → 204 and GET no longer lists it; detaching the last agent of a signed-in OAuth server signs it out: the vault entry is gone and the status is needs_auth",
  async () => {
    await boot();
    await post("/mcp/servers", { name: "alpha", url: fixture!.url, auth: "none" });
    await put("/mcp/servers/alpha/agents/researcher");

    const removed = await del("/mcp/servers/alpha/agents/researcher");
    expect(removed.status).toBe(204);
    const listing = await get("/mcp/servers");
    const servers = JSON.parse(listing.text) as { name: string; agents: unknown[] }[];
    expect(servers.find((server) => server.name === "alpha")?.agents).toEqual([]);

    await securePair();
    await addSecure();
    await signIn();
    const detached = await del("/mcp/servers/secure/agents/researcher");
    expect(detached.status).toBe(204);
    expect((await rt!.vault.list()).map((entry) => entry.name)).not.toContain("mcp_secure_oauth");
    const signed = await get("/mcp/servers");
    const statuses = JSON.parse(signed.text) as { name: string; status: string }[];
    expect(statuses.find((server) => server.name === "secure")?.status).toBe("needs_auth");
  },
  30_000,
);

// -- Z5 ------------------------------------------------------------------------

test(
  "Z5 DELETE /mcp/servers/secure with tokens stored → 204, the vault entry is deleted, and the fake AS saw one revocation request; an unknown server → 404",
  async () => {
    await boot();
    await securePair();
    await addSecure();
    await signIn();
    expect(auth!.count("/revoke")).toBe(0);

    const removed = await del("/mcp/servers/secure");
    expect(removed.status).toBe(204);
    expect((await rt!.vault.list()).map((entry) => entry.name)).not.toContain("mcp_secure_oauth");
    expect(auth!.count("/revoke")).toBe(1);
    const listing = await get("/mcp/servers");
    expect(JSON.parse(listing.text)).toEqual([]);

    const unknown = await del("/mcp/servers/nope");
    expect(unknown.status).toBe(404);
  },
  30_000,
);

// -- Z6 ------------------------------------------------------------------------

test(
  "Z6 oauth/start → an authorizeUrl on the fake AS with redirect_uri http://localhost:<PORT>/api/mcp/oauth/callback; FABRIC_PUBLIC_URL moves it to that origin; a none server → 400",
  async () => {
    await boot();
    await securePair();
    await post("/mcp/servers", { name: "secure", url: secure!.url, auth: "oauth" });
    await post("/mcp/servers", { name: "plain", url: fixture!.url, auth: "none" });

    const local = await post("/mcp/servers/secure/oauth/start");
    expect(local.status).toBe(200);
    const localUrl = new URL(authorizeUrlFrom(local.text));
    expect(localUrl.origin).toBe(auth!.issuer);
    expect(localUrl.searchParams.get("redirect_uri")).toBe(
      `http://localhost:${env.PORT}/api/mcp/oauth/callback`,
    );

    process.env.FABRIC_PUBLIC_URL = "https://fabric.example";
    const publicOrigin = await post("/mcp/servers/secure/oauth/start");
    expect(publicOrigin.status).toBe(200);
    const publicUrl = new URL(authorizeUrlFrom(publicOrigin.text));
    expect(publicUrl.searchParams.get("redirect_uri")).toBe(
      "https://fabric.example/api/mcp/oauth/callback",
    );

    // The review's follow-up 3: a trailing slash must not double up.
    process.env.FABRIC_PUBLIC_URL = "https://fabric.example/";
    const slashed = await post("/mcp/servers/secure/oauth/start");
    expect(slashed.status).toBe(200);
    const slashedUrl = new URL(authorizeUrlFrom(slashed.text));
    expect(slashedUrl.searchParams.get("redirect_uri")).toBe(
      "https://fabric.example/api/mcp/oauth/callback",
    );

    const none = await post("/mcp/servers/plain/oauth/start");
    expect(none.status).toBe(400);
  },
  30_000,
);

// -- Z7 ------------------------------------------------------------------------

test(
  "Z7 the callback with the fake AS's code and the started state → 200 HTML 'Signed in to secure', the status is ready and the vault holds the tokens; the same state again → 400 HTML; ?error=access_denied → 400 HTML naming it, and nothing is stored",
  async () => {
    await boot();
    await securePair();
    await addSecure();

    const started = await post("/mcp/servers/secure/oauth/start");
    const authorizeUrl = authorizeUrlFrom(started.text);
    const code = auth!.approve(authorizeUrl);
    const state = new URL(authorizeUrl).searchParams.get("state")!;

    const signedIn = await get(
      `/mcp/oauth/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`,
    );
    expect(signedIn.status).toBe(200);
    expect(signedIn.type).toContain("text/html");
    expect(signedIn.text).toContain("Signed in to secure");

    const listing = await get("/mcp/servers");
    const servers = JSON.parse(listing.text) as { name: string; status: string }[];
    expect(servers.find((server) => server.name === "secure")?.status).toBe("ready");

    const stored = JSON.parse(await rt!.vault.get("mcp_secure_oauth", { agentId: "researcher" })) as {
      accessToken: string;
    };
    expect(stored.accessToken).not.toBe("");

    const replayed = await get(
      `/mcp/oauth/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`,
    );
    expect(replayed.status).toBe(400);
    expect(replayed.type).toContain("text/html");

    const second = await post("/mcp/servers/secure/oauth/start");
    const secondState = new URL(authorizeUrlFrom(second.text)).searchParams.get("state")!;
    const denied = await get(`/mcp/oauth/callback?error=access_denied&state=${encodeURIComponent(secondState)}`);
    expect(denied.status).toBe(400);
    expect(denied.type).toContain("text/html");
    expect(denied.text).toContain("access_denied");
    expect(auth!.count("/token")).toBe(1);
    expect((await rt!.vault.list()).map((entry) => entry.name)).toEqual(["mcp_secure_oauth"]);
  },
  30_000,
);

// -- Z8 ------------------------------------------------------------------------

test(
  "Z8 a server name or provider error containing <script> is HTML-escaped in the callback page",
  async () => {
    await boot();
    await securePair();
    await addSecure();

    const started = await post("/mcp/servers/secure/oauth/start");
    const authorizeUrl = authorizeUrlFrom(started.text);
    const state = new URL(authorizeUrl).searchParams.get("state")!;

    // The provider's error parameter, echoed by the 400 page.
    const scripted = await get(
      `/mcp/oauth/callback?error=${encodeURIComponent("<script>alert(1)</script>")}&state=${encodeURIComponent(state)}`,
    );
    expect(scripted.status).toBe(400);
    expect(scripted.type).toContain("text/html");
    expect(scripted.text).toContain("&lt;script&gt;");
    expect(scripted.text).not.toContain("<script");

    // The failure page names what finish threw; a hostile AS puts a script
    // tag in its token-endpoint error, and the server name rides the same
    // escaping.
    auth!.failToken("<script>boom</script>");
    const code = auth!.approve(authorizeUrl);
    const failed = await get(
      `/mcp/oauth/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`,
    );
    expect(failed.status).toBe(400);
    expect(failed.type).toContain("text/html");
    expect(failed.text).not.toContain("<script");
    expect(failed.text).toContain("&lt;script&gt;boom&lt;/script&gt;");
    auth!.failToken(undefined);
  },
  30_000,
);

// -- Z9 ------------------------------------------------------------------------

test(
  "Z9 POST /mcp/servers/:name/refresh → the tool names and the skipped list, and the test server saw one tools/list; with no attachments → 409 attach an agent first",
  async () => {
    await boot();
    await post("/mcp/servers", { name: "alpha", url: fixture!.url, auth: "none" });
    await put("/mcp/servers/alpha/agents/researcher");
    await post("/mcp/servers", { name: "beta", url: fixture!.url, auth: "none" });

    const refreshed = await post("/mcp/servers/alpha/refresh");
    expect(refreshed.status).toBe(200);
    expect(JSON.parse(refreshed.text)).toEqual({
      tools: ["mcp_alpha_lookup", "mcp_alpha_create", "mcp_alpha_upsert"],
      skipped: [],
    });
    expect(fixture!.calls("tools/list")).toBe(1);

    const unattached = await post("/mcp/servers/beta/refresh");
    expect(unattached.status).toBe(409);
    expect(unattached.text).toContain("attach an agent first");
    expect(fixture!.calls("tools/list")).toBe(1);
  },
  30_000,
);

// -- pass-through (the review's follow-up 1) -----------------------------------

test(
  "M7 oauth/start with a user-supplied clientId/clientSecret (a provider without dynamic registration) carries them through to the AS exchange, and the secret never reaches a response body",
  async () => {
    await boot();
    await securePair({ registration: false });
    await addSecure();

    const clientSecret = "cs_pre_registered_secret_0123456789abcdef";
    const started = await post("/mcp/servers/secure/oauth/start", {
      clientId: "pre-registered",
      clientSecret,
    });
    expect(started.status).toBe(200);
    const authorizeUrl = authorizeUrlFrom(started.text);
    expect(new URL(authorizeUrl).searchParams.get("client_id")).toBe("pre-registered");
    expect(started.text).not.toContain(clientSecret);

    const code = auth!.approve(authorizeUrl);
    const state = new URL(authorizeUrl).searchParams.get("state")!;
    const signedIn = await get(
      `/mcp/oauth/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`,
    );
    expect(signedIn.status).toBe(200);

    // The exchange proves the pass-through: the AS saw the pre-registered
    // client id and its secret on the token request (form post or Basic).
    const exchange = auth!.log().find((entry) => entry.path === "/token");
    expect(exchange?.params.client_id ?? exchange?.authorization).toBeDefined();
    const secretSeen =
      exchange?.params.client_secret === clientSecret ||
      exchange?.authorization ===
        `Basic ${Buffer.from(`pre-registered:${clientSecret}`).toString("base64")}`;
    expect(secretSeen).toBe(true);
  },
  30_000,
);

// -- Z10 -----------------------------------------------------------------------

test(
  "Z10 across Z1–Z9 no response body and no captured log line contains the fake AS's access token, refresh token or client secret",
  async () => {
    const secrets = authServers.flatMap((server) => server.issued());
    expect(secrets.length).toBeGreaterThan(0);
    const everything = `${bodies.join("\n")}\n${capturedLogs.join("\n")}`;
    for (const secret of secrets) {
      expect(everything).not.toContain(secret);
    }
  },
  30_000,
);
