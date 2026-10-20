// ANY-119 — the path scope check and the forwarded path must be the same
// path. A raw path carrying a literal backslash sneaks `..` past the glob
// (WHATWG resolves `..\admin` to `/admin`) while `normalizePath` sees the
// segment `..\admin`, not `..`. The broker refuses backslash paths and
// authorizes against the canonical URL it actually forwards.
//
// The requests here are sent as RAW request targets over a socket, not
// through `fetch`: `fetch` re-parses a URL before transmitting and would
// already canonicalise `/allowed/..\admin` or `/allowed/../x`, so a test
// built on it could never see the divergence this card is about. A raw
// socket hands the broker the exact bytes an attacker sends, which is the
// only way R10-R12 can fail before the fix (they are red at the red
// commit: the request is forwarded, or the check and the upstream disagree).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
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
import { createServer, request } from "node:http";
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

type RawResponse = { status: number; body: string };

const brokerPort = () => Number(new URL(broker.url).port);

/** A GET whose `path` goes on the request line byte for byte, as
 * `curl --path-as-is` or a hand-rolled client would send it: node:http
 * does not parse the target as a URL, where `fetch` would first resolve
 * `..`/`\` and never put the malicious target on the wire at all. */
function rawGet(path: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: brokerPort(),
        path,
        headers: { authorization: `Bearer ${token()}`, connection: "close" },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

const httpGet = rawGet;

const errorOf = (response: RawResponse) => (JSON.parse(response.body) as { error?: string }).error;

test("R10 a raw path with ..\\admin is refused 403 path not allowed and the upstream sees nothing", async () => {
  const response = await rawGet("/egress/scope/allowed/..\\admin");
  expect(response.status).toBe(403);
  expect(errorOf(response)).toBe("path not allowed");
  expect(received).toHaveLength(0);
});

test("R11 a raw path with a literal backslash anywhere is refused 403 path not allowed, 0 upstream hits", async () => {
  const underGlob = await rawGet("/egress/scope/allowed/a\\b");
  expect(underGlob.status).toBe(403);
  expect(errorOf(underGlob)).toBe("path not allowed");

  const elsewhere = await rawGet("/egress/scope/a\\b");
  expect(elsewhere.status).toBe(403);
  expect(errorOf(elsewhere)).toBe("path not allowed");
  expect(received).toHaveLength(0);
});

test("R12 the upstream observes the canonical URL the broker authorized", async () => {
  const response = await httpGet("/egress/scope/allowed/x?keep=1");
  expect(response.status).toBe(200);

  const authorized = new URL(`${upstreamUrl.replace(/\/+$/, "")}/allowed/x?keep=1`);
  expect(received).toHaveLength(1);
  expect(received[0]?.url).toBe(`${authorized.pathname}${authorized.search}`);
  expect(received[0]?.url).toBe(new URL(authorized).pathname + new URL(authorized).search);
});

test("R13 existing behaviour: %2F refusal, .. segment refusal, normal pass", async () => {
  const encoded = await rawGet("/egress/scope/allowed%2Fx");
  expect(encoded.status).toBe(403);

  const dotdot = await rawGet("/egress/scope/allowed/../admin");
  expect(dotdot.status).toBe(403);
  expect(received).toHaveLength(0);

  const pass = await httpGet("/egress/scope/allowed/x");
  expect(pass.status).toBe(200);
  expect(received).toHaveLength(1);
  expect(received[0]?.url).toBe("/allowed/x");
});

describe("raw-path refusals the reviewer probed", () => {
  test("a backslash path, a `..` segment and a `%2F/..` path are all refused with zero upstream hits", async () => {
    const probes = [
      "/egress/scope/allowed/a\\b",
      "/egress/scope/allowed/sub/../x",
      "/egress/scope/allowed/%2F/../x",
    ];
    for (const target of probes) {
      const response = await rawGet(target);
      expect(response.status, target).toBe(403);
      expect(errorOf(response), target).toBe("path not allowed");
    }
    expect(received).toHaveLength(0);
  });
});

describe("normalizePath on a raw path", () => {
  test("refuses a backslash rather than decoding it to itself", () => {
    expect(normalizePath("/allowed/..\\admin")).toBeNull();
    expect(normalizePath("/allowed/a\\b")).toBeNull();
  });
});
