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
// socket hands the broker the exact bytes an attacker sends.
//
// The red commit cf13880 could not show the red state for exactly that
// reason: its fetch-based helper canonicalised the attack paths before
// they were sent, so R10-R13 were all green against the unfixed broker.
// The red state therefore lives here, in the tests themselves: the
// `red state` describe below reconstructs the cf13880 pipeline verbatim
// (test-only code) and runs the exact R10-R13 assertion bodies against
// it — R10, R11 and R12 must FAIL there, R13 must PASS (it was green at
// the red commit).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { normalizePath, pathAllowed } from "../broker";
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

type UpstreamRecord = { method: string; url: string; authorization: string | undefined };

const received: UpstreamRecord[] = [];

const upstream = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    received.push({ method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization });
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
function rawGet(path: string, port: number = brokerPort()): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
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

const errorOf = (response: RawResponse): string | undefined => {
  const parsed: unknown = JSON.parse(response.body);
  if (typeof parsed === "object" && parsed !== null && "error" in parsed && typeof parsed.error === "string") {
    return parsed.error;
  }
  return undefined;
};

// -- the case assertion bodies ---------------------------------------------------
// One body per listed case, shared by the cases below and by the red-state
// proof: the exact same assertions run against the fixed broker (where they
// must pass) and against the reconstructed unfixed pipeline (where R10-R12
// must fail on an assertion, and R13 must still pass).

async function r10Case(port: number): Promise<void> {
  const response = await rawGet("/egress/scope/allowed/..\\admin", port);
  expect(response.status).toBe(403);
  expect(errorOf(response)).toBe("path not allowed");
  expect(received).toHaveLength(0);
}

async function r11Case(port: number): Promise<void> {
  const underGlob = await rawGet("/egress/scope/allowed/a\\b", port);
  expect(underGlob.status).toBe(403);
  expect(errorOf(underGlob)).toBe("path not allowed");

  const elsewhere = await rawGet("/egress/scope/a\\b", port);
  expect(elsewhere.status).toBe(403);
  expect(errorOf(elsewhere)).toBe("path not allowed");
  expect(received).toHaveLength(0);
}

async function r12Case(port: number): Promise<void> {
  // a passing path: the upstream observes exactly the canonical URL — the
  // one path the rule authorized, as the forwarded target parses it.
  const response = await httpGet("/egress/scope/allowed/x?keep=1", port);
  expect(response.status).toBe(200);

  const authorized = new URL(`${upstreamUrl.replace(/\/+$/, "")}/allowed/x?keep=1`);
  expect(received).toHaveLength(1);
  expect(received[0]?.url).toBe(`${authorized.pathname}${authorized.search}`);
  expect(received[0]?.url).toBe(new URL(authorized).pathname + new URL(authorized).search);

  // and nothing else may reach the wire: a raw path whose canonical
  // (on-the-wire) form differs from the path the rule matched is refused.
  // The URL parser drops `.` segments and strips fragments, so the
  // unfixed broker authorized `/allowed/./x` (or `/allowed/x#frag`) while
  // fetch put `/allowed/x` on the wire — the check ran on a different
  // path than the request, the divergence this case exists to forbid.
  const divergent = ["/egress/scope/allowed/./x", "/egress/scope/allowed/x#frag"];
  for (const target of divergent) {
    const refused = await rawGet(target, port);
    expect(refused.status, target).toBe(403);
    expect(errorOf(refused), target).toBe("path not allowed");
  }
  expect(received).toHaveLength(1);
}

async function r13Case(port: number): Promise<void> {
  const encoded = await rawGet("/egress/scope/allowed%2Fx", port);
  expect(encoded.status).toBe(403);

  const dotdot = await rawGet("/egress/scope/allowed/../admin", port);
  expect(dotdot.status).toBe(403);
  expect(received).toHaveLength(0);

  const pass = await httpGet("/egress/scope/allowed/x", port);
  expect(pass.status).toBe(200);
  expect(received).toHaveLength(1);
  expect(received[0]?.url).toBe("/allowed/x");
}

test("R10 a raw path with ..\\admin is refused 403 path not allowed and the upstream sees nothing", () =>
  r10Case(brokerPort()));

test("R11 a raw path with a literal backslash anywhere is refused 403 path not allowed, 0 upstream hits", () =>
  r11Case(brokerPort()));

test("R12 the upstream observes the canonical URL the broker authorized", () => r12Case(brokerPort()));

test("R13 existing behaviour: %2F refusal, .. segment refusal, normal pass", () => r13Case(brokerPort()));

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

// -- the unfixed pipeline, verbatim from the red commit cf13880 ------------------
// rules.ts@cf13880: `normalizePath` refused `%2F` and `..` segments but let
// backslashes through (the segment `..\admin` decodes to itself, not `..`).
function normalizePathUnfixed(rawPath: string): string | null {
  if (/%2f/i.test(rawPath)) return null;
  for (const segment of rawPath.split("/")) {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (decoded === "..") return null;
  }
  try {
    return decodeURIComponent(rawPath);
  } catch {
    return null;
  }
}

/** broker.ts@cf13880's path stage and forward, reconstructed test-only so
 * the red state is demonstrable without rewriting the red commit: it
 * authorized `normalizePath(rawPath)` and then handed
 * `${upstream}${rawPath}${query}` to `fetch`, which re-canonicalises what
 * it is handed — so the check ran on a different path than the request
 * that hit the wire. Token, agent and credential-lookup stages are
 * unchanged since cf13880 and out of scope here; the rule's credential is
 * attached statically. */
async function startUnfixedBroker(rules: CredentialRule[]): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "/";
      if (!url.startsWith("/egress/")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      const rest = url.slice("/egress/".length);
      const queryAt = rest.indexOf("?");
      const pathQuery = queryAt === -1 ? rest : rest.slice(0, queryAt);
      const query = queryAt === -1 ? "" : `?${rest.slice(queryAt + 1)}`;
      const slashAt = pathQuery.indexOf("/");
      const ruleName = slashAt === -1 ? pathQuery : pathQuery.slice(0, slashAt);
      const rawPath = slashAt === -1 ? "/" : pathQuery.slice(slashAt);
      const method = (req.method ?? "GET").toUpperCase();
      const rule = rules.find((candidate) => candidate.name === ruleName);
      const refuse = (reason: string) => {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: reason }));
      };
      if (rule === undefined) return refuse("unknown rule");
      if (!rule.methods.includes(method)) return refuse("method not allowed");
      const decodedPath = normalizePathUnfixed(rawPath);
      if (decodedPath === null || !pathAllowed(rule.paths, decodedPath)) return refuse("path not allowed");
      try {
        const response = await fetch(`${rule.upstream.replace(/\/+$/, "")}${rawPath}${query}`, {
          method,
          headers: { authorization: `Bearer ${SECRET}` },
          redirect: "manual",
        });
        res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "text/plain" });
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "upstream unreachable" }));
      }
    })().catch(() => {
      try {
        res.writeHead(500);
        res.end();
      } catch {
        // the client is gone; nothing to answer
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Run a case's assertions and capture the failure instead of failing the
 * test — the red-state proof needs the failure itself as evidence. */
async function failureOf(run: () => Promise<void>): Promise<Error | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return error as Error;
  }
}

describe("red state — the unfixed (cf13880) pipeline", () => {
  // The red commit's tests were green against the unfixed broker because
  // its fetch-based helper canonicalised the attack paths before they were
  // sent. This runs the exact R10-R13 assertion bodies against a verbatim
  // reconstruction of that broker: R10, R11 and R12 must FAIL here on an
  // assertion (not a crash), R13 must pass — it was green at the red
  // commit. If this reconstruction ever refuses like the fixed broker,
  // the assertions below fail: the proof checks itself.

  let unfixed: { url: string; close(): Promise<void> };

  beforeEach(async () => {
    unfixed = await startUnfixedBroker([rule()]);
  });

  afterEach(async () => {
    await unfixed.close();
  });

  const unfixedPort = () => Number(new URL(unfixed.url).port);

  test("R10 fails there: the attack is forwarded and the upstream receives /admin with the rule's credential", async () => {
    const failure = await failureOf(() => r10Case(unfixedPort()));
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toContain("expected");
    // the exploit observed on the wire: authorized /allowed/..\admin,
    // delivered /admin — with the rule's bearer credential attached.
    expect(received).toHaveLength(1);
    expect(received[0]?.url).toBe("/admin");
    expect(received[0]?.authorization).toBe(`Bearer ${SECRET}`);
  });

  test("R11 fails there: the backslash path is forwarded as /allowed/a/b", async () => {
    const failure = await failureOf(() => r11Case(unfixedPort()));
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toContain("expected");
    expect(received).toHaveLength(1);
    expect(received[0]?.url).toBe("/allowed/a/b");
  });

  test("R12 fails there: the upstream observes a path the broker never authorized", async () => {
    const failure = await failureOf(() => r12Case(unfixedPort()));
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toContain("expected");
    // leg one passed — the old R12 was green here, which is why it needed
    // strengthening — and then the `.`-segment path was forwarded:
    // authorized /allowed/./x, delivered /allowed/x.
    expect(received).toHaveLength(2);
    expect(received[0]?.url).toBe("/allowed/x?keep=1");
    expect(received[1]?.url).toBe("/allowed/x");
  });

  test("R13 passes there: %2F and .. are refused, the normal path passes", async () => {
    const failure = await failureOf(() => r13Case(unfixedPort()));
    expect(failure).toBeNull();
    expect(received).toHaveLength(1);
    expect(received[0]?.url).toBe("/allowed/x");
  });
});
