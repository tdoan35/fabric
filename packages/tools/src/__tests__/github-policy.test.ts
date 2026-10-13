// ANY-44 T11 — repo attachment and the API policy (GH9–GH11), plus the
// secret-leak scan. One fake git upstream and one fake GitHub API on
// 127.0.0.1; two rules (git + api) share one GitHub App auth. No network.
import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createServer, type IncomingMessage } from "node:http";
import { afterAll, beforeAll, afterEach, beforeEach, expect, test } from "vitest";
import { createTokenStore, startBroker, type BrokerServer, type BrokerUseRecord } from "../broker";
import { buildPushBody, fakePack, sha, ZERO_SHA } from "./fixtures/github/pktline";

const KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const INSTALLATION_TOKEN = "ghs_policy_test_token";

type Received = { method: string; url: string; authorization: string };
let gitReceived: Received[] = [];
let apiReceived: Received[] = [];

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const gitUpstream = createServer(async (req, res) => {
  gitReceived.push({ method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization ?? "" });
  await readBody(req);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
});

const api = createServer(async (req, res) => {
  apiReceived.push({ method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization ?? "" });
  if (req.method === "POST" && req.url === "/app/installations/77/access_tokens") {
    await readBody(req);
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ token: INSTALLATION_TOKEN, expires_at: new Date(Date.now() + 3600_000).toISOString() }));
    return;
  }
  if (req.url?.startsWith("/repos/o/r/compare/")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ahead" }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ api: true }));
});

let broker: BrokerServer;
const tokens = createTokenStore();
const uses: BrokerUseRecord[] = [];

beforeEach(async () => {
  gitReceived = [];
  apiReceived = [];
  uses.length = 0;
  const vault = memoryVault();
  await vault.put("gh_app_key", KEY.privateKey, { agents: "all" });
  const auth = {
    type: "github-app",
    appId: 1,
    installationId: 77,
    privateKeySecret: "gh_app_key",
    repos: ["o/r"],
    apiUrl: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
  } as const;
  broker = await startBroker({
    vault,
    tokens,
    rules: [
      {
        name: "git",
        upstream: `http://127.0.0.1:${(gitUpstream.address() as AddressInfo).port}`,
        auth,
        methods: ["GET", "POST"],
        paths: ["/o/r.git/**", "/o/other.git/**"],
        agents: "all",
      },
      {
        name: "api",
        upstream: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
        auth,
        methods: ["GET", "POST", "PUT", "DELETE"],
        paths: ["/repos/**", "/graphql"],
        agents: "all",
      },
    ],
    onUse: (record) => uses.push(record),
  });
});
afterEach(async () => {
  await broker.close();
});

beforeAll(async () => {
  await Promise.all([
    new Promise<void>((resolve) => gitUpstream.listen(0, "127.0.0.1", resolve)),
    new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve)),
  ]);
});
afterAll(async () => {
  for (const server of [gitUpstream, api]) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function egressToken(): string {
  return tokens.issue({ workspaceId: "ws", agentId: "dana", ttlMs: 300_000 });
}

function egress(rule: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${broker.url}/egress/${rule}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${egressToken()}`, ...(init.headers ?? {}) },
  });
}

test("GH9 a repo outside `repos` is refused for info/refs, upload-pack and the API alike", async () => {
  const infoRefs = await egress("git", "/o/other.git/info/refs?service=git-upload-pack");
  expect(infoRefs.status).toBe(403);

  const upload = await egress("git", "/o/other.git/git-upload-pack", {
    method: "POST",
    headers: { "content-type": "application/x-git-upload-pack-request" },
    body: fakePack(),
  });
  expect(upload.status).toBe(403);

  const apiCall = await egress("api", "/repos/o/other/pulls");
  expect(apiCall.status).toBe(403);

  expect(gitReceived).toHaveLength(0);
  expect(apiReceived.length).toBe(1); // only the token mint; no data call forwarded
});

test("GH10 the API policy opens PRs and comments, refuses merges, deletes and graphql", async () => {
  const pulls = await egress("api", "/repos/o/r/pulls", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "fix", head: "fabric/fix-1" }),
  });
  expect(pulls.status).toBe(200);

  const comment = await egress("api", "/repos/o/r/issues/7/comments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: "done" }),
  });
  expect(comment.status).toBe(200);

  const merge = await egress("api", "/repos/o/r/pulls/3/merge", { method: "PUT" });
  expect(merge.status).toBe(403);
  expect(((await merge.json()) as { error: string }).error).toContain("merge");

  const remove = await egress("api", "/repos/o/r/git/refs/heads/fabric/x", { method: "DELETE" });
  expect(remove.status).toBe(403);

  const graphql = await egress("api", "/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "{ viewer { login } }" }),
  });
  expect(graphql.status).toBe(403);

  // exactly the two allowed calls were forwarded (the token mint aside)
  const forwarded = apiReceived.filter(
    (request) => !request.url.startsWith("/app/installations") && !request.url.startsWith("/repos/o/r/compare/")
  );
  expect(forwarded.map((request) => `${request.method} ${request.url}`).sort()).toEqual([
    "POST /repos/o/r/issues/7/comments",
    "POST /repos/o/r/pulls",
  ]);
  // the API credential is the installation token, as a Bearer
  expect(forwarded.every((request) => request.authorization === `Bearer ${INSTALLATION_TOKEN}`)).toBe(true);
});

test("GH11 the private key never appears in an audit record, a refusal body or an error", async () => {
  const refusals: string[] = [];

  const pushMain = await egress("git", "/o/r.git/git-receive-pack", {
    method: "POST",
    headers: { "content-type": "application/x-git-receive-pack-request" },
    body: buildPushBody([{ old: ZERO_SHA, new: sha("x"), ref: "refs/heads/main" }], "report-status", fakePack()),
  });
  refusals.push(await pushMain.text());

  const merge = await egress("api", "/repos/o/r/pulls/3/merge", { method: "PUT" });
  refusals.push(await merge.text());

  const detached = await egress("git", "/o/other.git/info/refs?service=git-upload-pack");
  refusals.push(await detached.text());

  await egress("api", "/repos/o/r/pulls", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "t" }),
  });

  const haystacks = [...refusals, ...uses.map((record) => JSON.stringify(record))];
  // the PEM, and its base64 payload with the header/footer lines stripped
  const pemPayload = KEY.privateKey.replace(/-----[A-Z ]+-----|\s+/g, "");
  for (const needle of [KEY.privateKey, pemPayload]) {
    for (const haystack of haystacks) {
      expect(haystack).not.toContain(needle);
    }
  }
});
