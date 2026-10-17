// ANY-119 — the path scope check and the forwarded path must be the same
// path. A raw path carrying a literal backslash sneaks `..` past the glob
// (WHATWG resolves `..\\admin` to `/admin`) while `normalizePath` sees the
// segment `..\\admin`, not `..`. The broker refuses backslash paths and
// authorizes against the canonical URL it actually forwards.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { normalizePath } from "../broker";
import {
  createTokenStore,
  startBroker,
  type BrokerServer,
  type BrokerUseRecord,
  type CredentialRule,
  type TokenStore,
} from "../broker";
import { memoryVault } from "../vault";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const WORKSPACE = "ws-119";
const SECRET = "ghp_119_secret_value";

type UpstreamRecord = { method: string; url: string };

const received: UpstreamRecord[] = [];

const upstream = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    received.push({ method: req.method ?? "", url: req.url ?? "" });
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
});

let upstreamUrl = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address() as AddressInfo;
  upstreamUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

beforeEach(() => {
  received.length = 0;
});

const rule = (): CredentialRule => ({
  name: "scope",
  upstream: upstreamUrl,
  auth: { type: "bearer" },
  secret: "scope_key",
  methods: ["GET"],
  paths: ["/allowed/**"],
  agents: "all",
});

let broker: BrokerServer;
let tokens: TokenStore;
const uses: BrokerUseRecord[] = [];

beforeEach(async () => {
  uses.length = 0;
  const vault = memoryVault();
  await vault.put("scope_key", SECRET, { agents: "all" });
  tokens = createTokenStore(() => 1_000_000);
  broker = await startBroker({
    vault,
    rules: [rule()],
    tokens,
    onUse: (record) => uses.push(record),
  });
});

afterEach(async () => {
  await broker.close();
});

const token = () => tokens.issue({ workspaceId: WORKSPACE, agentId: "dana", ttlMs: 60_000 });

const egress = (pathAndQuery: string) =>
  fetch(`${broker.url}/egress/${pathAndQuery}`, { headers: { authorization: `Bearer ${token()}` } });

test("R10 a raw path with ..\\admin is refused 403 path not allowed and the upstream sees nothing", async () => {
  const response = await egress("scope/allowed/..\\admin");
  expect(response.status).toBe(403);
  expect(((await response.json()) as { error?: string }).error).toBe("path not allowed");
  expect(received).toHaveLength(0);
});

test("R11 a raw path with a literal backslash anywhere is refused 403 path not allowed, 0 upstream hits", async () => {
  const response = await egress("scope/a\\b");
  expect(response.status).toBe(403);
  expect(((await response.json()) as { error?: string }).error).toBe("path not allowed");
  expect(received).toHaveLength(0);
});

test("R12 the upstream observes the canonical URL the broker authorized", async () => {
  const response = await egress("scope/allowed/x?keep=1");
  expect(response.status).toBe(200);

  const target = new URL(`${upstreamUrl.replace(/\/+$/, "")}/allowed/x?keep=1`);
  expect(received[0]?.url).toBe(`${target.pathname}${target.search}`);
  expect(received[0]?.url).toBe(new URL(target).pathname + new URL(target).search);
});

test("R13 existing behaviour: %2F refusal, .. segment refusal, normal pass", async () => {
  const encoded = await egress("scope/allowed%2Fx");
  expect(encoded.status).toBe(403);

  const dotdot = await egress("scope/allowed/../admin");
  expect(dotdot.status).toBe(403);

  const pass = await egress("scope/allowed/x");
  expect(pass.status).toBe(200);
  expect(received).toHaveLength(1);
  expect(received[0]?.url).toBe("/allowed/x");
});
