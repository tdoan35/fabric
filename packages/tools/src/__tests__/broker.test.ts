// ANY-70 T5 — the credential broker (ANY-44 D3): named endpoints, checks in
// order, fail-closed forwarding, audit without values. A local fake upstream
// on 127.0.0.1 records exactly what reaches it; the broker under test also
// binds 127.0.0.1. No external network.
import { createHash, randomBytes } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { createServer } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import type { AddressInfo } from "node:net";
import { memoryVault } from "../vault";
import {
  createTokenStore,
  startBroker,
  type BrokerServer,
  type BrokerUseRecord,
  type CredentialRule,
  type TokenStore,
} from "../broker";

const WORKSPACE = "ws-broker";
const SECRET = "ghp_secret_value_123456789";
const HEADER_SECRET = "sk_header_secret_987654321";
const BASIC_SECRET = "sk_basic_secret_543210987";

/** What the fake upstream received, in order. */
type UpstreamRecord = {
  method: string;
  url: string;
  host: string | undefined;
  headers: IncomingHttpHeaders;
  body: Buffer;
};

const received: UpstreamRecord[] = [];
/** What the upstream answers this request: a redirect or a plain body. */
let answer:
  | { kind: "ok"; body?: string }
  | { kind: "redirect"; location: string } = { kind: "ok" };

const upstream = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    received.push({
      method: req.method ?? "",
      url: req.url ?? "",
      host: req.headers.host,
      headers: req.headers,
      body: Buffer.concat(chunks),
    });
    if (answer.kind === "redirect") {
      res.writeHead(302, { location: answer.location });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(answer.body ?? `upstream auth=<${req.headers.authorization ?? "none"}>`);
  });
});

let upstreamUrl = "";
let upstreamHost = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address() as AddressInfo;
  upstreamUrl = `http://127.0.0.1:${address.port}`;
  upstreamHost = new URL(upstreamUrl).host;
});

afterAll(async () => {
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

beforeEach(() => {
  received.length = 0;
  answer = { kind: "ok" };
});

const rules = (): readonly CredentialRule[] => [
  {
    name: "github",
    upstream: upstreamUrl,
    auth: { type: "bearer" },
    secret: "github_pat",
    methods: ["GET", "POST"],
    paths: ["/repos/**"],
    agents: "all",
  },
  {
    name: "exa",
    upstream: upstreamUrl,
    auth: { type: "header", header: "x-api-key" },
    secret: "exa_key",
    methods: ["GET"],
    paths: ["/search"],
    agents: "all",
  },
  {
    name: "mail",
    upstream: upstreamUrl,
    auth: { type: "basic", user: "fabric" },
    secret: "mail_key",
    methods: ["GET"],
    paths: ["/send"],
    agents: ["dana"],
  },
];

const SECRET_BY_NAME: Record<string, string> = {
  github_pat: SECRET,
  exa_key: HEADER_SECRET,
  mail_key: BASIC_SECRET,
};

let clock = 1_000_000;
let broker: BrokerServer;
let tokens: TokenStore;
const uses: BrokerUseRecord[] = [];

beforeEach(async () => {
  clock = 1_000_000;
  uses.length = 0;
  const vault = memoryVault();
  for (const [name, value] of Object.entries(SECRET_BY_NAME)) {
    await vault.put(name, value, { agents: "all" });
  }
  tokens = createTokenStore(() => clock);
  broker = await startBroker({
    vault,
    rules: rules(),
    tokens,
    onUse: (record) => uses.push(record),
  });
});

afterEach(async () => {
  await broker.close();
});

const tokenFor = (agentId = "dana") =>
  tokens.issue({ workspaceId: WORKSPACE, agentId, ttlMs: 60_000 });

const egress = (pathAndQuery: string, init?: RequestInit) =>
  fetch(`${broker.url}/egress/${pathAndQuery}`, init);

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const jsonBody = async (response: Response) =>
  (await response.json()) as { error?: string };

test("B1 an allowed GET forwards the bearer secret, path, query and upstream Host, and returns the upstream response", async () => {
  const response = await egress("github/repos/fabric?per_page=2", {
    headers: bearer(tokenFor()),
  });

  expect(response.status).toBe(200);
  expect(await response.text()).toContain(SECRET);

  expect(received).toHaveLength(1);
  expect(received[0]?.method).toBe("GET");
  expect(received[0]?.url).toBe("/repos/fabric?per_page=2");
  expect(received[0]?.headers.authorization).toBe(`Bearer ${SECRET}`);
  expect(received[0]?.host).toBe(upstreamHost);
});

test("B2 header auth sets the named header, and basic auth sets Basic base64(user:secret)", async () => {
  const headerResponse = await egress("exa/search", { headers: bearer(tokenFor()) });
  expect(headerResponse.status).toBe(200);
  expect(received[0]?.headers["x-api-key"]).toBe(HEADER_SECRET);
  expect(received[0]?.headers.authorization).toBeUndefined();

  const basicResponse = await egress("mail/send", { headers: bearer(tokenFor()) });
  expect(basicResponse.status).toBe(200);
  expect(received[1]?.headers.authorization).toBe(
    `Basic ${Buffer.from(`fabric:${BASIC_SECRET}`).toString("base64")}`
  );
});

test("B3 a missing, garbage, expired or revoked token is a 403 and the upstream sees nothing", async () => {
  const noToken = await egress("github/repos/fabric");
  expect(noToken.status).toBe(403);
  expect(typeof (await jsonBody(noToken)).error).toBe("string");

  const garbage = await egress("github/repos/fabric", { headers: bearer("garbage-token") });
  expect(garbage.status).toBe(403);

  const expiring = tokens.issue({ workspaceId: WORKSPACE, agentId: "dana", ttlMs: 5_000 });
  clock += 6_000; // past the ttl
  const expired = await egress("github/repos/fabric", { headers: bearer(expiring) });
  expect(expired.status).toBe(403);

  const revoked = tokenFor();
  tokens.revoke(revoked);
  const afterRevoke = await egress("github/repos/fabric", { headers: bearer(revoked) });
  expect(afterRevoke.status).toBe(403);

  expect(received).toHaveLength(0);
});

test("B4 an unknown rule or a disallowed agent is a 403 without an upstream request", async () => {
  const unknown = await egress("nope/repos", { headers: bearer(tokenFor()) });
  expect(unknown.status).toBe(403);

  const outsider = await egress("mail/send", {
    headers: bearer(tokenFor("researcher")),
  });
  expect(outsider.status).toBe(403);
  expect((await jsonBody(outsider)).error).toContain("agent");

  expect(received).toHaveLength(0);
});

test("B5 a method outside the rule's methods is a 403", async () => {
  const response = await egress("github/repos/fabric", {
    method: "DELETE",
    headers: bearer(tokenFor()),
  });
  expect(response.status).toBe(403);
  expect((await jsonBody(response)).error).toContain("method");
  expect(received).toHaveLength(0);
});

test("B6 a path outside the globs, a .. segment, or a %2F-smuggled path is a 403", async () => {
  for (const path of ["github/admin", "github/repos/../admin", "github/repos%2Fadmin"]) {
    const response = await egress(path, { headers: bearer(tokenFor()) });
    expect(response.status, path).toBe(403);
  }
  expect(received).toHaveLength(0);
});

test("B7 a missing secret is a 403 `credential unavailable` and nothing is sent (fail-closed)", async () => {
  const emptyTokens = createTokenStore(() => clock);
  const empty = await startBroker({
    vault: memoryVault(),
    rules: rules(),
    tokens: emptyTokens,
    onUse: () => {},
  });
  try {
    const response = await fetch(`${empty.url}/egress/github/repos/fabric`, {
      headers: bearer(emptyTokens.issue({ workspaceId: WORKSPACE, agentId: "dana", ttlMs: 60_000 })),
    });
    expect(response.status).toBe(403);
    expect((await jsonBody(response)).error).toBe("credential unavailable");
    expect(received).toHaveLength(0);
  } finally {
    await empty.close();
  }
});

test("B8 the caller's Authorization, Cookie and X-Fabric-* headers never reach the upstream", async () => {
  const response = await egress("github/repos/fabric", {
    headers: {
      ...bearer(tokenFor()),
      cookie: "session=caller-session",
      "x-fabric-egress": "caller-meta",
      "x-custom": "kept",
    },
  });
  expect(response.status).toBe(200);

  const headers = received[0]?.headers ?? {};
  expect(headers.cookie).toBeUndefined();
  expect(headers["x-fabric-egress"]).toBeUndefined();
  expect(headers.authorization).toBe(`Bearer ${SECRET}`); // the credential, not the caller's token
  expect(headers["x-custom"]).toBe("kept");
});

test("B9 a 302 is returned unfollowed: cross-host Location is stripped, same-host Location is kept", async () => {
  answer = { kind: "redirect", location: "http://example.invalid/elsewhere" };
  const crossHost = await egress("github/repos/fabric", {
    headers: bearer(tokenFor()),
    redirect: "manual", // the caller, like the broker, does not follow
  });
  expect(crossHost.status).toBe(302);
  expect(crossHost.headers.get("location")).toBeNull();
  expect(received).toHaveLength(1);

  answer = { kind: "redirect", location: `${upstreamUrl}/next` };
  const sameHost = await egress("github/repos/fabric", {
    headers: bearer(tokenFor()),
    redirect: "manual",
  });
  expect(sameHost.status).toBe(302);
  expect(sameHost.headers.get("location")).toBe(`${upstreamUrl}/next`);
  expect(received).toHaveLength(2);
});

test("B10 a POST body is streamed through byte-identical", async () => {
  const body = randomBytes(1024 * 1024);
  const response = await egress("github/repos/fabric/upload", {
    method: "POST",
    headers: { ...bearer(tokenFor()), "content-type": "application/octet-stream" },
    body,
  });
  expect(response.status).toBe(200);
  expect(received).toHaveLength(1);
  const sent = createHash("sha256").update(body).digest("hex");
  const forwarded = createHash("sha256").update(received[0]?.body ?? Buffer.alloc(0)).digest("hex");
  expect(forwarded).toBe(sent);
  expect(received[0]?.headers["content-type"]).toBe("application/octet-stream");
});

test("B11 onUse fires once per request with allowed, status and reason, and no record carries the secret", async () => {
  await egress("github/repos/fabric", { headers: bearer(tokenFor()) });
  await egress("github/admin", { headers: bearer(tokenFor()) });

  expect(uses).toHaveLength(2);
  expect(uses[0]).toMatchObject({
    workspaceId: WORKSPACE,
    agentId: "dana",
    rule: "github",
    method: "GET",
    host: upstreamHost,
    path: "/repos/fabric",
    status: 200,
    allowed: true,
  });
  expect(uses[0]?.reason).toBeUndefined();
  expect(uses[1]).toMatchObject({ status: 403, allowed: false });
  expect(typeof uses[1]?.reason).toBe("string");

  expect(JSON.stringify(uses)).not.toContain(SECRET);
});

test("B14 a basic-auth password token (base64 of \"x:<token>\") is accepted like a bearer token", async () => {
  const token = tokenFor();
  const response = await egress("github/repos/fabric", {
    headers: { authorization: `Basic ${Buffer.from(`x:${token}`).toString("base64")}` },
  });
  expect(response.status).toBe(200);
  expect(received[0]?.headers.authorization).toBe(`Bearer ${SECRET}`);
});
