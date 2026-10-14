// ANY-44 T11 — the push policy (GH4–GH8). A fake git upstream on 127.0.0.1
// records what reaches it; a fake GitHub API serves the installation token
// and the compare endpoint the non-fast-forward check consults. The push
// bodies come from the pkt-line fixtures. No network.
import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createServer, type IncomingMessage } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { memoryVault } from "../vault";
import { createTokenStore, startBroker, type BrokerServer, type BrokerUseRecord } from "../broker";
import { buildPushBody, fakePack, sha, ZERO_SHA } from "./fixtures/github/pktline";

const KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const INSTALLATION_TOKEN = "ghs_push_test_token";

type Received = { method: string; url: string; authorization: string; body: Buffer };
let received: Received[] = [];
let compareStatus = "ahead";
let compareCalls: { url: string; authorization: string }[] = [];

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const gitUpstream = createServer(async (req, res) => {
  received.push({
    method: req.method ?? "",
    url: req.url ?? "",
    authorization: req.headers.authorization ?? "",
    body: await readBody(req),
  });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
});

const api = createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/app/installations/77/access_tokens") {
    await readBody(req);
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ token: INSTALLATION_TOKEN, expires_at: new Date(Date.now() + 3600_000).toISOString() }));
    return;
  }
  const compare = req.url?.match(/^\/repos\/o\/r\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/);
  if (req.method === "GET" && compare) {
    compareCalls.push({ url: req.url ?? "", authorization: req.headers.authorization ?? "" });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: compareStatus }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

let broker: BrokerServer;
const tokens = createTokenStore();
const uses: BrokerUseRecord[] = [];

beforeEach(async () => {
  received = [];
  compareCalls = [];
  compareStatus = "ahead";
  uses.length = 0;
  const vault = memoryVault();
  await vault.put("gh_app_key", KEY.privateKey, { agents: "all" });
  broker = await startBroker({
    vault,
    tokens,
    rules: [
      {
        name: "git",
        upstream: `http://127.0.0.1:${(gitUpstream.address() as AddressInfo).port}`,
        auth: {
          type: "github-app",
          appId: 1,
          installationId: 77,
          privateKeySecret: "gh_app_key",
          repos: ["o/r"],
          apiUrl: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
        },
        methods: ["GET", "POST"],
        paths: ["/o/r.git/**"],
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

function push(commands: readonly { old: string; new: string; ref: string }[]): Promise<Response> {
  const body = buildPushBody(commands, "report-status", fakePack());
  return fetch(`${broker.url}/egress/git/o/r.git/git-receive-pack`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${egressToken()}`,
      "content-type": "application/x-git-receive-pack-request",
      "git-protocol": "version=2",
    },
    body,
  });
}

test("GH4 a fast-forward push to refs/heads/fabric/* is forwarded with x-access-token basic auth", async () => {
  const old = sha("ff-old");
  const response = await push([{ old, new: sha("ff-new"), ref: "refs/heads/fabric/fix-1" }]);

  expect(response.status).toBe(200);
  expect(received).toHaveLength(1);

  const request = received[0];
  expect(request.method).toBe("POST");
  expect(request.url).toBe("/o/r.git/git-receive-pack");
  const expected = Buffer.from(`x-access-token:${INSTALLATION_TOKEN}`, "utf8").toString("base64");
  expect(request.authorization).toBe(`Basic ${expected}`);
  // the pushed body reaches the upstream byte-identical
  const sent = buildPushBody([{ old, new: sha("ff-new"), ref: "refs/heads/fabric/fix-1" }], "report-status", fakePack());
  expect(request.body.equals(sent)).toBe(true);

  // non-zero old consulted the compare endpoint with the app token
  expect(compareCalls).toHaveLength(1);
  expect(compareCalls[0].url).toBe(`/repos/o/r/compare/${old}...${sha("ff-new")}`);
  expect(compareCalls[0].authorization).toBe(`Bearer ${INSTALLATION_TOKEN}`);
});

test("GH5 a push to refs/heads/main is a 403 and nothing is forwarded", async () => {
  const response = await push([{ old: ZERO_SHA, new: sha("main-new"), ref: "refs/heads/main" }]);

  expect(response.status).toBe(403);
  expect(received).toHaveLength(0);
  const error = (await response.json()) as { error: string };
  expect(error.error).toContain("fabric");
});

test("GH6 a ref deletion (new = all zeros) is a 403", async () => {
  const response = await push([{ old: sha("del-old"), new: ZERO_SHA, ref: "refs/heads/fabric/old" }]);

  expect(response.status).toBe(403);
  expect(received).toHaveLength(0);
  expect(((await response.json()) as { error: string }).error).toContain("delet");
});

test("GH7 a tag push is a 403", async () => {
  const response = await push([{ old: ZERO_SHA, new: sha("tag-new"), ref: "refs/tags/v1" }]);

  expect(response.status).toBe(403);
  expect(received).toHaveLength(0);
  expect(((await response.json()) as { error: string }).error).toContain("fabric");
});

test("GH8 a non-fast-forward push is a 403 for both diverged and behind", async () => {
  compareStatus = "diverged";
  const diverged = await push([{ old: sha("nf-old"), new: sha("nf-new"), ref: "refs/heads/fabric/fix-1" }]);
  expect(diverged.status).toBe(403);
  expect(received).toHaveLength(0);
  expect(compareCalls).toHaveLength(1); // the check actually ran

  compareCalls = [];
  compareStatus = "behind";
  const behind = await push([{ old: sha("nf-old"), new: sha("nf-new-2"), ref: "refs/heads/fabric/fix-2" }]);
  expect(behind.status).toBe(403);
  expect(received).toHaveLength(0);
  expect(compareCalls).toHaveLength(1);
});
