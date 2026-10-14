// ANY-44 T11 — the push policy (GH4–GH8, GH13, GH14). A fake git upstream
// on 127.0.0.1 records what reaches it; a fake GitHub API serves the
// installation token and counts compare calls (the broker must make none:
// fast-forward is GitHub's ruleset to enforce). The push bodies come from
// the pkt-line fixtures. No network.
import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { memoryVault } from "../vault";
import { createTokenStore, startBroker, type BrokerServer, type BrokerUseRecord } from "../broker";
import { buildPushBody, fakePack, FLUSH_PKT, pktLine, reportStatusLines, sha, ZERO_SHA } from "./fixtures/github/pktline";

const KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const INSTALLATION_TOKEN = "ghs_push_test_token";

type Received = { method: string; url: string; authorization: string; body: Buffer };
let received: Received[] = [];
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
    res.end(JSON.stringify({ status: "diverged" }));
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
  uses.length = 0;
  const vault = memoryVault();
  await vault.put("gh_app_key", KEY.privateKey, { agents: "all" });
  broker = await startBroker({
    vault,
    tokens,
    rules: [
      {
        name: "git",
        surface: "git",
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

type Ref = { old: string; new: string; ref: string };

function push(commands: readonly Ref[], caps = "report-status"): Promise<Response> {
  return pushBody(buildPushBody(commands, caps, fakePack()));
}

function pushBody(body: Buffer): Promise<Response> {
  return fetch(`${broker.url}/egress/git/o/r.git/git-receive-pack`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${egressToken()}`,
      "content-type": "application/x-git-receive-pack-request",
    },
    body,
  });
}

/** A refused push: 200 with a receive-pack report rejecting every ref. */
async function rejection(response: Response, sideBand = false): Promise<string[]> {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/x-git-receive-pack-result");
  return reportStatusLines(Buffer.from(await response.arrayBuffer()), sideBand);
}

test("GH4 a push to refs/heads/fabric/* is forwarded byte-identical with x-access-token basic auth", async () => {
  const commands = [{ old: ZERO_SHA, new: sha("ff-new"), ref: "refs/heads/fabric/fix-1" }];
  const response = await push(commands);

  expect(response.status).toBe(200);
  expect(received).toHaveLength(1);

  const request = received[0];
  expect(request.method).toBe("POST");
  expect(request.url).toBe("/o/r.git/git-receive-pack");
  const expected = Buffer.from(`x-access-token:${INSTALLATION_TOKEN}`, "utf8").toString("base64");
  expect(request.authorization).toBe(`Basic ${expected}`);
  // the pushed body reaches the upstream byte-identical
  expect(request.body.equals(buildPushBody(commands, "report-status", fakePack()))).toBe(true);
  expect(uses.at(-1)).toMatchObject({ allowed: true, status: 200 });
});

test("GH5 a push to refs/heads/main is rejected with its reason and nothing is forwarded", async () => {
  const lines = await rejection(await push([{ old: ZERO_SHA, new: sha("main-new"), ref: "refs/heads/main" }]));

  expect(received).toHaveLength(0);
  expect(lines[0]).toBe("unpack ok");
  expect(lines[1]).toMatch(/^ng refs\/heads\/main .*refs\/heads\/fabric\//);
  expect(uses.at(-1)).toMatchObject({ allowed: false, reason: expect.stringContaining("fabric") });
});

test("GH6 a ref deletion (new = all zeros) is rejected", async () => {
  const lines = await rejection(await push([{ old: sha("del-old"), new: ZERO_SHA, ref: "refs/heads/fabric/old" }]));

  expect(received).toHaveLength(0);
  expect(lines[1]).toMatch(/^ng refs\/heads\/fabric\/old .*delet/);
});

test("GH7 a tag push is rejected", async () => {
  const lines = await rejection(await push([{ old: ZERO_SHA, new: sha("tag-new"), ref: "refs/tags/v1" }]));

  expect(received).toHaveLength(0);
  expect(lines[1]).toMatch(/^ng refs\/tags\/v1 .*fabric/);
});

test("GH8 an update to an existing fabric/* branch is forwarded without a compare call", async () => {
  // The new commits are still in the pack, so GitHub's compare cannot see
  // them; fast-forward is enforced by the ruleset upstream (GH12 shows its
  // refusal reaching git).
  const response = await push([{ old: sha("up-old"), new: sha("up-new"), ref: "refs/heads/fabric/fix-1" }]);

  expect(response.status).toBe(200);
  expect(received).toHaveLength(1);
  expect(compareCalls).toHaveLength(0);
});

test("GH13 the pack is never buffered: commands decide, the pack streams, oversize and truncated sections refuse", async () => {
  // a refused push is answered while the client is still sending its pack
  const commands = pktLine(`${ZERO_SHA} ${sha("x")} refs/heads/main\0report-status\n`);
  const early = await new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
    const url = new URL(`${broker.url}/egress/git/o/r.git/git-receive-pack`);
    const request = httpRequest(
      { host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { authorization: `Bearer ${egressToken()}` } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          request.destroy();
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) });
        });
      }
    );
    request.on("error", reject);
    request.write(Buffer.concat([commands, FLUSH_PKT, Buffer.from("PACK")])); // the pack never finishes
  });
  expect(early.status).toBe(200);
  expect(reportStatusLines(early.body)[1]).toMatch(/^ng refs\/heads\/main /);
  expect(received).toHaveLength(0);

  // a pack far larger than the command limit streams through intact
  const bigPack = Buffer.alloc(4 * 1024 * 1024, 9);
  const big = buildPushBody([{ old: ZERO_SHA, new: sha("big"), ref: "refs/heads/fabric/big" }], "report-status", bigPack);
  expect((await pushBody(big)).status).toBe(200);
  expect(received.at(-1)?.body.equals(big)).toBe(true);

  // git's probe before a large push is a bare flush: nothing to update, forwarded
  expect((await pushBody(FLUSH_PKT)).status).toBe(200);
  expect(received.at(-1)?.body.equals(FLUSH_PKT)).toBe(true);
  received = [];

  // a command section past the limit, and one cut off before its flush, refuse
  const many = Array.from({ length: 1000 }, (_, index) => ({ old: ZERO_SHA, new: sha(`m${index}`), ref: `refs/heads/fabric/m${index}` }));
  const oversize = await pushBody(buildPushBody(many, "report-status", fakePack()));
  expect(oversize.status).toBe(403);
  expect(await oversize.text()).toContain("too-large");
  const truncated = await pushBody(pktLine(`${ZERO_SHA} ${sha("t")} refs/heads/fabric/t\0report-status\n`));
  expect(truncated.status).toBe(403);
  expect(await truncated.text()).toContain("truncated");
  expect(received).toHaveLength(0);
});

test("GH14 a push is all or nothing, reported in the client's side band; no report-status means a plain 403", async () => {
  const mixed = [
    { old: ZERO_SHA, new: sha("ok"), ref: "refs/heads/fabric/ok" },
    { old: ZERO_SHA, new: sha("bad"), ref: "refs/heads/main" },
  ];
  const lines = await rejection(await push(mixed, "report-status side-band-64k agent=git/2.43.0"), true);
  expect(lines).toHaveLength(3);
  expect(lines[0]).toBe("unpack ok");
  expect(lines[1]).toMatch(/^ng refs\/heads\/fabric\/ok refused with the rest of the push: /);
  expect(lines[2]).toMatch(/^ng refs\/heads\/main pushes must stay under/);
  expect(received).toHaveLength(0);

  const silent = await push([{ old: ZERO_SHA, new: sha("s"), ref: "refs/heads/main" }], "agent=git/2.43.0");
  expect(silent.status).toBe(403);
  expect(silent.headers.get("content-type")).toContain("text/plain");
  expect(await silent.text()).toContain("refs/heads/fabric/");
  expect(received).toHaveLength(0);
});
