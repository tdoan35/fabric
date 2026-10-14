// ANY-78 O1–O14 — MCP OAuth (authorization code + PKCE S256, RFC 8707
// resource) against an in-process fake authorization server and a protected
// MCP test server on 127.0.0.1, tokens in memoryVault, an injectable clock.
// Both drivers via @fabric/runtime/testing. The cases run in order: O14
// scans everything O1–O13 observed (thrown messages, vault.list() output,
// status rows) for any secret the fake servers issued or received.
import { createHash } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { describeDrivers, type DriverHarness } from "@fabric/runtime/testing";
import type { RuntimeStore } from "@fabric/runtime";
import { createRegistry } from "../index";
import { memoryVault, VaultDenied, type Vault } from "../vault";
import {
  discover,
  ensureMcpSchema,
  mcpClient,
  mcpOAuth,
  mcpServers,
  mcpToolDefs,
  type McpClient,
  type McpOAuth,
  type McpServers,
} from "../mcp";
import { startFakeAuthServer, type FakeAuthServer } from "./fixtures/mcp/auth-server";
import { startTestMcpServer, type TestMcpServer } from "./fixtures/mcp/server";
import { createIssue, getFile } from "./fixtures/mcp/tools";

const WORKSPACE = "ws-mcp-oauth";
const REDIRECT = "http://127.0.0.1:7777/oauth/callback";
const VAULT_NAME = "mcp_local_oauth";
const T0 = Date.parse("2026-10-14T00:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/** What O14 scans: every secret issued, every message thrown, every listing. */
const hygiene = { issued: new Set<string>(), errors: [] as string[], listings: [] as string[] };

type Ctx = {
  auth: FakeAuthServer;
  mcp: TestMcpServer;
  store: RuntimeStore;
  servers: McpServers;
  vault: Vault;
  oauth: McpOAuth;
  clock: { now: number };
  clients: McpClient[];
};

const open: Ctx[] = [];
afterEach(async () => {
  for (const ctx of open.splice(0)) {
    for (const value of ctx.auth.issued()) hygiene.issued.add(value);
    await Promise.all(ctx.clients.map((client) => client.close()));
    await ctx.mcp.close();
    await ctx.auth.close();
  }
});

async function setup(
  h: DriverHarness,
  options: {
    auth?: Parameters<typeof startFakeAuthServer>[0];
    /** false: the 401 challenge carries no resource_metadata. */
    challengeMetadata?: boolean;
    /** The protected server refuses every token. */
    alwaysUnauthorized?: boolean;
    name?: string;
  } = {}
): Promise<Ctx> {
  const auth = await startFakeAuthServer(options.auth);
  const mcp = await startTestMcpServer({
    tools: [createIssue, getFile],
    auth: {
      accepts: (authorization) => options.alwaysUnauthorized !== true && auth.accepts(authorization),
      ...(options.challengeMetadata === false ? {} : { resourceMetadataPath: "/meta/prm" }),
      metadata: { authorization_servers: [auth.issuer], scopes_supported: ["repo", "read"] },
    },
  });
  const store = await h.openStore();
  await ensureMcpSchema(store);
  await ensureMcpSchema(store);
  const servers = mcpServers(store, WORKSPACE);
  await servers.add({ name: options.name ?? "local", url: mcp.url, auth: "oauth" });
  await servers.attach(options.name ?? "local", "dana");
  const vault = memoryVault();
  const clock = { now: T0 };
  const oauth = mcpOAuth({ servers, vault, store, workspaceId: WORKSPACE, now: () => clock.now });
  const ctx = { auth, mcp, store, servers, vault, oauth, clock, clients: [] };
  open.push(ctx);
  return ctx;
}

/** The whole sign-in: start, the user approves, the callback finishes. */
async function signIn(ctx: Ctx, server = "local"): Promise<{ authorizeUrl: string; state: string }> {
  const { authorizeUrl } = await ctx.oauth.start(server, { redirectUri: REDIRECT });
  const code = ctx.auth.approve(authorizeUrl);
  const state = new URL(authorizeUrl).searchParams.get("state")!;
  await ctx.oauth.finish({ state, code });
  return { authorizeUrl, state };
}

/** The rejection's message, kept for O14. */
async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    hygiene.errors.push(err.message);
    return err;
  }
  throw new Error("expected a rejection");
}

/** The vault listing and status rows, kept for O14. */
async function snapshot(ctx: Ctx): Promise<void> {
  hygiene.listings.push(JSON.stringify(await ctx.vault.list()));
  hygiene.listings.push(JSON.stringify(await ctx.servers.list()));
}

async function storedTokens(ctx: Ctx, agentId = "dana") {
  return JSON.parse(await ctx.vault.get(VAULT_NAME, { agentId })) as {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    tokenEndpoint: string;
    clientId: string;
    clientSecret?: string;
    resource: string;
    revocationEndpoint?: string;
  };
}

async function pendingRows(store: RuntimeStore): Promise<number> {
  const rows = await store.transaction((tx) =>
    tx.query(`select state from mcp_oauth_pending where workspace_id = $1`, [WORKSPACE])
  );
  return rows.length;
}

/** A ToolPort over the server's tools for `agentId`, through oauth.fetchFor. */
async function portFor(ctx: Ctx, agentId = "dana") {
  const client = mcpClient({ url: ctx.mcp.url, fetch: ctx.oauth.fetchFor("local", agentId) });
  ctx.clients.push(client);
  const { tools } = await discover(ctx.servers, client, "local");
  return createRegistry(tools).toolPort({ workspaceId: WORKSPACE, streamId: "run:oauth", agentId });
}

const refreshes = (ctx: Ctx) =>
  ctx.auth.log().filter((entry) => entry.path === "/token" && entry.params.grant_type === "refresh_token");

describeDrivers("tools mcp oauth (ANY-78)", (h) => {
  test("O1 start with a resource_metadata challenge → an S256 authorize URL with client_id, redirect_uri, state and resource", async () => {
    const ctx = await setup(h);
    const { authorizeUrl } = await ctx.oauth.start("local", { redirectUri: REDIRECT });
    const url = new URL(authorizeUrl);

    expect(`${url.origin}${url.pathname}`).toBe(`${ctx.auth.issuer}/authorize`);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toMatch(/^client_/);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, base64url
    expect(url.searchParams.get("resource")).toBe(ctx.mcp.url);
    expect(url.searchParams.get("scope")).toBe("repo read");

    // Discovery: one tokenless request, then the challenge's metadata URL.
    expect(ctx.mcp.authorizations()[0]).toBeUndefined();
    expect(ctx.mcp.paths()).toContain("/meta/prm");
    expect(ctx.mcp.paths()).not.toContain("/.well-known/oauth-protected-resource");
    expect(await pendingRows(ctx.store)).toBe(1);
    await snapshot(ctx);
  });

  test("O2 fallbacks: no resource_metadata → the well-known resource URL; a 404 on oauth-authorization-server → openid-configuration", async () => {
    const ctx = await setup(h, { challengeMetadata: false, auth: { oauthMetadata: false } });
    const { authorizeUrl } = await ctx.oauth.start("local", { redirectUri: REDIRECT });

    expect(authorizeUrl.startsWith(`${ctx.auth.issuer}/authorize?`)).toBe(true);
    expect(ctx.mcp.paths()).toContain("/.well-known/oauth-protected-resource");
    expect(ctx.auth.count("/.well-known/oauth-authorization-server")).toBeGreaterThan(0);
    expect(ctx.auth.count("/.well-known/openid-configuration")).toBeGreaterThan(0);
    await snapshot(ctx);
  });

  test("O3 no clientId → exactly one registration, used in the URL; a passed clientId → no registration", async () => {
    const ctx = await setup(h);
    const { authorizeUrl } = await ctx.oauth.start("local", { redirectUri: REDIRECT });
    expect(ctx.auth.count("/register")).toBe(1);
    const registration = ctx.auth.log().find((entry) => entry.path === "/register")!;
    expect(registration.params.redirect_uris).toContain(REDIRECT);
    const registered = new URL(authorizeUrl).searchParams.get("client_id")!;
    expect(registered).toMatch(/^client_/);
    // The registered client is the one the token endpoint accepts.
    await ctx.oauth.finish({
      state: new URL(authorizeUrl).searchParams.get("state")!,
      code: ctx.auth.approve(authorizeUrl),
    });
    expect((await storedTokens(ctx)).clientId).toBe(registered);

    const again = await ctx.oauth.start("local", { redirectUri: REDIRECT, clientId: "fabric-preregistered" });
    expect(new URL(again.authorizeUrl).searchParams.get("client_id")).toBe("fabric-preregistered");
    expect(ctx.auth.count("/register")).toBe(1);
    await snapshot(ctx);
  });

  test("O4 no registration endpoint and no clientId → an error naming the client id; no S256 → refused before any URL", async () => {
    const noRegistration = await setup(h, { auth: { registration: false } });
    const missing = await caught(noRegistration.oauth.start("local", { redirectUri: REDIRECT }));
    expect(missing.message).toBe("mcp server local needs a client id");
    expect(await pendingRows(noRegistration.store)).toBe(0);
    await snapshot(noRegistration);

    const plainOnly = await setup(h, { auth: { s256: false }, name: "plain" });
    const refused = await caught(
      plainOnly.oauth.start("plain", { redirectUri: REDIRECT, clientId: "fabric-preregistered" })
    );
    expect(refused.message).toMatch(/S256/);
    expect(await pendingRows(plainOnly.store)).toBe(0);
    expect(plainOnly.auth.count("/register")).toBe(0);
    await snapshot(plainOnly);
  });

  test("O5 finish → the token request carries the matching verifier and the resource; the vault entry follows the attached agents; status ready", async () => {
    const ctx = await setup(h);
    await ctx.servers.attach("local", "scout");
    const { authorizeUrl } = await signIn(ctx);

    const token = ctx.auth.log().find((entry) => entry.path === "/token")!;
    expect(token.params.grant_type).toBe("authorization_code");
    expect(s256(token.params.code_verifier!)).toBe(new URL(authorizeUrl).searchParams.get("code_challenge"));
    expect(token.params.resource).toBe(ctx.mcp.url);
    expect(token.params.redirect_uri).toBe(REDIRECT);

    const [entry] = await ctx.vault.list();
    expect(entry).toMatchObject({ name: VAULT_NAME });
    expect([...(entry!.agents as string[])].sort()).toEqual(["dana", "scout"]);
    const stored = await storedTokens(ctx);
    expect(stored).toMatchObject({
      accessToken: expect.stringMatching(/^at_/),
      refreshToken: expect.stringMatching(/^rt_/),
      expiresAt: T0 + HOUR,
      tokenEndpoint: `${ctx.auth.issuer}/token`,
      clientId: expect.stringMatching(/^client_/),
      resource: ctx.mcp.url,
      revocationEndpoint: `${ctx.auth.issuer}/revoke`,
    });
    expect(await ctx.servers.get("local")).toMatchObject({ status: "ready", lastError: null });
    expect(await pendingRows(ctx.store)).toBe(0);
    await snapshot(ctx);
  });

  test("O6 an unknown, an 11-minute-old and a reused state each error with no vault write; a token-endpoint error → needs_auth with the code only", async () => {
    const ctx = await setup(h);

    await caught(ctx.oauth.finish({ state: "not-a-state", code: "whatever" }));
    expect(await ctx.vault.list()).toEqual([]);

    const old = await ctx.oauth.start("local", { redirectUri: REDIRECT });
    const oldCode = ctx.auth.approve(old.authorizeUrl);
    ctx.clock.now += 11 * MINUTE;
    await caught(ctx.oauth.finish({ state: new URL(old.authorizeUrl).searchParams.get("state")!, code: oldCode }));
    expect(await ctx.vault.list()).toEqual([]);
    expect(ctx.auth.count("/token")).toBe(0);

    const { state } = await signIn(ctx);
    const before = await ctx.vault.get(VAULT_NAME, { agentId: "dana" });
    await caught(ctx.oauth.finish({ state, code: "reused" }));
    expect(await ctx.vault.get(VAULT_NAME, { agentId: "dana" })).toBe(before);
    expect(ctx.auth.count("/token")).toBe(1);

    ctx.auth.failToken("invalid_client");
    const failing = await ctx.oauth.start("local", { redirectUri: REDIRECT });
    const failed = await caught(
      ctx.oauth.finish({
        state: new URL(failing.authorizeUrl).searchParams.get("state")!,
        code: ctx.auth.approve(failing.authorizeUrl),
      })
    );
    expect(failed.message).toMatch(/invalid_client/);
    expect(await ctx.servers.get("local")).toMatchObject({ status: "needs_auth", lastError: "invalid_client" });
    await snapshot(ctx);
  });

  test("O7 end to end with M4: discover and call a tool on the protected server, which sees the bearer token", async () => {
    const ctx = await setup(h);
    await signIn(ctx);
    const port = await portFor(ctx);

    const result = await port.run("mcp_local_create_issue", { repo: "acme/web", title: "Broken build" }, {});
    expect(result).toMatchObject({ ok: true, result: { text: "created Broken build\n\nin acme/web" } });
    const { accessToken } = await storedTokens(ctx);
    const seen = ctx.mcp.authorizations();
    expect(seen.at(-1)).toBe(`Bearer ${accessToken}`);
    expect(seen.filter((value) => value !== undefined).every((value) => value === `Bearer ${accessToken}`)).toBe(true);
    await snapshot(ctx);
  });

  test("O8 a token expiring in 30 s is refreshed before the call; the vault holds the rotated tokens; the old refresh token isn't reused", async () => {
    const ctx = await setup(h, { auth: { lifetimes: { code: 30, refresh: 3600 } } });
    await signIn(ctx);
    const first = await storedTokens(ctx);
    expect(first.expiresAt).toBe(T0 + 30_000);

    const port = await portFor(ctx);
    expect((await port.run("mcp_local_create_issue", { repo: "acme/web", title: "a" }, {})).ok).toBe(true);
    expect(await port.run("mcp_local_create_issue", { repo: "acme/web", title: "b" }, {})).toMatchObject({ ok: true });

    expect(refreshes(ctx)).toHaveLength(1);
    expect(refreshes(ctx)[0]!.params.refresh_token).toBe(first.refreshToken);
    const rotated = await storedTokens(ctx);
    expect(rotated.accessToken).not.toBe(first.accessToken);
    expect(rotated.refreshToken).not.toBe(first.refreshToken);
    expect(rotated.expiresAt).toBe(T0 + HOUR);
    expect(ctx.mcp.authorizations()).not.toContain(`Bearer ${first.accessToken}`);
    expect(ctx.mcp.authorizations().at(-1)).toBe(`Bearer ${rotated.accessToken}`);
    await snapshot(ctx);
  });

  test("O9 five concurrent calls with an expired token → exactly one refresh request", async () => {
    const ctx = await setup(h);
    await signIn(ctx);
    const port = await portFor(ctx);
    ctx.clock.now += 2 * HOUR;

    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => port.run("mcp_local_create_issue", { repo: "acme/web", title: `t${n}` }, {}))
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect(refreshes(ctx)).toHaveLength(1);
    await snapshot(ctx);
  });

  test("O10 a 401 mid-call → one refresh and a retry that succeeds; a server that always answers 401 → needs_auth, no token in the error", async () => {
    const ctx = await setup(h);
    await signIn(ctx);
    const port = await portFor(ctx);
    ctx.auth.expireAccessTokens(); // the server forgets the token; the clock says it's fresh

    const result = await port.run("mcp_local_create_issue", { repo: "acme/web", title: "retry" }, {});
    expect(result).toMatchObject({ ok: true });
    expect(refreshes(ctx)).toHaveLength(1);

    const refusing = await setup(h, { alwaysUnauthorized: true, name: "refusing" });
    await signIn(refusing, "refusing");
    const client = mcpClient({ url: refusing.mcp.url, fetch: refusing.oauth.fetchFor("refusing", "dana") });
    refusing.clients.push(client);
    const failed = await caught(client.listTools());
    expect(failed.message).toContain("mcp server refusing needs sign-in again");
    expect(refreshes(refusing)).toHaveLength(1);
    for (const value of refusing.auth.issued()) expect(failed.message).not.toContain(value);
    expect(await refusing.servers.get("refusing")).toMatchObject({ status: "needs_auth" });
    await snapshot(ctx);
    await snapshot(refusing);
  });

  test("O11 invalid_grant on refresh → needs_auth and 'mcp server <name> needs sign-in again'", async () => {
    const ctx = await setup(h);
    await signIn(ctx);
    ctx.clock.now += 2 * HOUR;
    ctx.auth.failToken("invalid_grant");

    const failed = await caught(ctx.oauth.headers("local", "dana"));
    expect(failed.message).toBe("mcp server local needs sign-in again");
    expect(await ctx.servers.get("local")).toMatchObject({ status: "needs_auth", lastError: "invalid_grant" });

    const client = mcpClient({ url: ctx.mcp.url, fetch: ctx.oauth.fetchFor("local", "dana") });
    ctx.clients.push(client);
    expect((await caught(client.listTools())).message).toContain("mcp server local needs sign-in again");
    await snapshot(ctx);
  });

  test("O12 an unattached agent gets VaultDenied as the tool's error; attach lets it read, detach denies it again", async () => {
    const ctx = await setup(h);
    await signIn(ctx);

    expect(await caught(ctx.oauth.headers("local", "outsider"))).toBeInstanceOf(VaultDenied);

    // The vault is the second line: even with policy bypassed (an
    // isAttached that says yes), the outsider's calls can't get a token.
    const client = mcpClient({ url: ctx.mcp.url, fetch: ctx.oauth.fetchFor("local", "outsider") });
    ctx.clients.push(client);
    const { defs } = mcpToolDefs(
      { name: "local", isAttached: async () => true },
      [createIssue.tool as Parameters<typeof mcpToolDefs>[1][number]],
      (_server, name, args) => client.callTool(name, args)
    );
    const port = createRegistry(defs).toolPort({ workspaceId: WORKSPACE, streamId: "run:x", agentId: "outsider" });
    const denied = await port.run("mcp_local_create_issue", { repo: "acme/web", title: "x" }, {});
    expect(denied.ok).toBe(false);
    expect(denied).toMatchObject({ error: expect.stringContaining(`secret denied: ${VAULT_NAME}`) });
    hygiene.errors.push((denied as { error: string }).error);
    expect(ctx.mcp.authorizations().filter((value) => value !== undefined)).toHaveLength(0);

    await ctx.servers.attach("local", "outsider");
    expect(await ctx.oauth.headers("local", "outsider")).toEqual({
      Authorization: `Bearer ${(await storedTokens(ctx)).accessToken}`,
    });
    expect([...((await ctx.vault.list())[0]!.agents as string[])].sort()).toEqual(["dana", "outsider"]);

    await ctx.servers.detach("local", "outsider");
    expect(await caught(ctx.oauth.headers("local", "outsider"))).toBeInstanceOf(VaultDenied);
    expect((await ctx.vault.list())[0]!.agents).toEqual(["dana"]);
    await snapshot(ctx);
  });

  test("O13 disconnect revokes when advertised (and not otherwise), drops the vault entry and pending rows, status needs_auth; remove cleans up too", async () => {
    const ctx = await setup(h);
    await signIn(ctx);
    const { refreshToken } = await storedTokens(ctx);
    await ctx.oauth.start("local", { redirectUri: REDIRECT }); // a pending row
    expect(await pendingRows(ctx.store)).toBe(1);

    await ctx.oauth.disconnect("local");
    const revocations = ctx.auth.log().filter((entry) => entry.path === "/revoke");
    expect(revocations).toHaveLength(1);
    expect(revocations[0]!.params.token).toBe(refreshToken);
    expect(await ctx.vault.list()).toEqual([]);
    expect(await pendingRows(ctx.store)).toBe(0);
    expect(await ctx.servers.get("local")).toMatchObject({ status: "needs_auth" });

    const quiet = await setup(h, { auth: { revocation: false }, name: "quiet" });
    await signIn(quiet, "quiet");
    await quiet.oauth.disconnect("quiet");
    expect(quiet.auth.count("/revoke")).toBe(0);
    expect(await quiet.vault.list()).toEqual([]);
    expect(await quiet.servers.get("quiet")).toMatchObject({ status: "needs_auth" });

    // remove (M4) leaves the vault to M5: the hook revokes and deletes.
    const removed = await setup(h, { name: "gone" });
    await signIn(removed, "gone");
    await removed.servers.remove("gone");
    expect(await removed.vault.list()).toEqual([]);
    expect(removed.auth.count("/revoke")).toBe(1);
    await snapshot(ctx);
    await snapshot(quiet);
    await snapshot(removed);
  });

  test("O14 hygiene: no token, client secret or verifier appears in any error, vault.list() output or status row from O1–O13", async () => {
    // afterEach has folded every earlier case's issued values in.
    expect(hygiene.issued.size).toBeGreaterThan(20);
    expect(hygiene.errors.length).toBeGreaterThan(10);
    expect(hygiene.listings.length).toBeGreaterThan(10);
    const haystack = [...hygiene.errors, ...hygiene.listings];
    for (const value of hygiene.issued) {
      for (const text of haystack) expect(text.includes(value), `leaked ${value.slice(0, 3)}…`).toBe(false);
    }
  });
});
