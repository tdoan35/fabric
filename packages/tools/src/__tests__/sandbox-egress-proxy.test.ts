// The gateway's proxy and broker-forwarder behavior, without Docker (T18).
// `sandbox/egress.mjs` is spawned as the real entrypoint on ephemeral ports —
// the same file the image runs at /opt/fabric/egress.mjs — so the refusal
// rules, the CONNECT/absolute-URI paths and the broker route are exercisable
// on any machine. The one public-destination case (P1) uses the network, like
// E2; every refusal case is fully local.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";

const EGRESS_MJS = join(dirname(fileURLToPath(import.meta.url)), "../../sandbox/egress.mjs");

let gateway: ChildProcess | undefined;
let proxyPort = 0;
let httpPort = 0;

/** A trivial origin server: counts the requests it actually served. */
const originOn = (): Promise<{ server: Server; port: number; hits: () => number; close: () => void }> => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    res.end("origin");
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        server,
        port,
        hits: () => hits,
        close: () => {
          server.closeAllConnections();
          server.close();
        },
      });
    })
  );
};

const broker: {
  server: Server;
  port: number;
  hits: { method?: string; url?: string; token?: string }[];
  bodies: { url?: string; body: string; token?: string }[];
} = { server: undefined as unknown as Server, port: 0, hits: [], bodies: [] };

/** The egress token header, as the node client keys it. */
const tokenOf = (headers: Record<string, unknown>): string | undefined =>
  headers["fabric_egress_token"] as string | undefined;

/** GET (or POST) against the gateway's proxy port by absolute URI. */
const viaProxy = (
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ status?: number; body: string }> =>
  new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port: proxyPort,
      path,
      method: options.method,
      headers: options.headers,
    });
    req.on("error", reject);
    req.end(options.body);
    req.on("response", (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      res.on("end", () => resolve({ status: res.statusCode, body: body.trim() }));
    });
  });

/** GET (or POST) the gateway's broker route by origin-form path. */
const viaGateway = (
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ status?: number; body: string }> =>
  new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port: httpPort,
      path,
      method: options.method,
      headers: options.headers,
    });
    req.on("error", reject);
    req.end(options.body);
    req.on("response", (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      res.on("end", () => resolve({ status: res.statusCode, body: body.trim() }));
    });
  });

/** CONNECT through the proxy; resolves once the response head is complete. */
const viaConnect = (host: string, port: number): Promise<{ head: string; socket: Socket }> =>
  new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: proxyPort }, () => {
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    });
    let buffer = "";
    socket.on("data", function onData(chunk: Buffer): void {
      buffer += chunk.toString("utf8");
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) return;
      socket.off("data", onData);
      resolve({ head: buffer.slice(0, end), socket });
    });
    socket.on("error", reject);
    socket.on("close", () => resolve({ head: buffer, socket }));
  });

beforeAll(async () => {
  // The broker the gateway forwards to. Loopback is fine for the gateway's own
  // outbound connection: the private-address rule governs proxied destinations.
  broker.server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      const token = tokenOf(req.headers as Record<string, unknown>);
      broker.hits.push({ method: req.method, url: req.url, token });
      broker.bodies.push({ url: req.url, body, token });
      res.end("broker-pong");
    });
  });
  await new Promise<void>((resolve) => broker.server.listen(0, "127.0.0.1", resolve));
  broker.port = (broker.server.address() as { port: number }).port;

  gateway = spawn("node", [EGRESS_MJS], {
    env: {
      ...process.env,
      FABRIC_EGRESS_PROXY_PORT: "0",
      FABRIC_EGRESS_HTTP_PORT: "0",
      FABRIC_BROKER_HOST: "127.0.0.1",
      FABRIC_BROKER_PORT: String(broker.port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ports: Promise<{ proxy: number; http: number }> = new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`egress.mjs never announced its ports: ${out}`)), 10_000);
    gateway!.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      const match = /proxy=:(\d+) http=:(\d+)/.exec(out);
      if (match !== null) {
        clearTimeout(timer);
        resolve({ proxy: Number(match[1]), http: Number(match[2]) });
      }
    });
    gateway!.stderr!.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    gateway!.on("exit", (code) => reject(new Error(`egress.mjs exited ${code}: ${out}`)));
  });
  const bound = await ports;
  proxyPort = bound.proxy;
  httpPort = bound.http;
});

afterAll(async () => {
  gateway?.kill();
  broker.server?.closeAllConnections();
  await broker.server?.close();
});

test("P1 an absolute-URI GET to a public host is forwarded and the response returns", async () => {
  const result = await viaProxy("http://example.com/?marker=1");
  expect(result.status).toBe(200);
  expect(result.body.length).toBeGreaterThan(0);
});

test("P2 loopback, RFC1918, CGNAT, link-local, ULA and unspecified destinations answer 403", async () => {
  const origin = await originOn();
  try {
    const destinations = [
      `http://127.0.0.1:${origin.port}/x`,
      "http://10.1.2.3:9/x",
      "http://172.16.0.1:9/x",
      "http://192.168.5.5:9/x",
      "http://100.64.0.1:9/x",
      "http://169.254.169.254/latest/meta-data/",
      "http://0.0.0.1:9/x",
      "http://[::1]:9/x",
      "http://[fc00::1]:9/x",
      "http://[fe80::1]:9/x",
    ];
    for (const destination of destinations) {
      const result = await viaProxy(destination);
      expect(result.status, destination).toBe(403);
      expect(JSON.parse(result.body)).toEqual({ error: "egress: private address" });
    }
    // Refusals never dial: the loopback origin was not touched on the way.
    expect(origin.hits()).toBe(0);
  } finally {
    origin.close();
  }
});

test("P3 CONNECT to a private destination answers 403 with the refusal body", async () => {
  const tunnel = await viaConnect("127.0.0.1", 54321);
  expect(tunnel.head).toContain(" 403 ");
  expect(tunnel.head).toContain("application/json");
  tunnel.socket.destroy();
});

test("P4 the broker route forwards method, path and headers, and the response returns", async () => {
  const result = await viaGateway("/ping", {
    headers: { FABRIC_EGRESS_TOKEN: "tok-xyz" },
  });
  expect(result.body).toBe("broker-pong");
  // The gateway forwards headers untouched; node keys them lower-cased.
  expect(broker.hits[0]).toEqual({ method: "GET", url: "/ping", token: "tok-xyz" });
});

test("P5 a request body travels through the gateway intact", async () => {
  const result = await viaGateway("/submit", {
    method: "POST",
    headers: { "content-type": "text/plain", FABRIC_EGRESS_TOKEN: "tok-body" },
    body: "payload-123",
  });
  expect(result.body).toBe("broker-pong");
  const submitted = broker.bodies.find((entry) => entry.url === "/submit");
  expect(submitted?.body).toBe("payload-123");
  expect(submitted?.token).toBe("tok-body");
});

test("P6 an IPv4-mapped IPv6 loopback literal in the absolute URI answers 403 with no origin hit", async () => {
  const origin = await originOn();
  try {
    const result = await viaProxy(`http://[::ffff:127.0.0.1]:${origin.port}/x`);
    expect(result.status).toBe(403);
    expect(JSON.parse(result.body)).toEqual({ error: "egress: private address" });
    expect(origin.hits()).toBe(0);
  } finally {
    origin.close();
  }
});

test("P7 the hex-mapped and IPv4-compatible loopback literals answer 403 with no origin hit", async () => {
  const origin = await originOn();
  try {
    for (const host of ["::ffff:7f00:1", "::7f00:1"]) {
      const result = await viaProxy(`http://[${host}]:${origin.port}/x`);
      expect(result.status, host).toBe(403);
      expect(JSON.parse(result.body)).toEqual({ error: "egress: private address" });
    }
    expect(origin.hits()).toBe(0);
  } finally {
    origin.close();
  }
});

test("P8 CONNECT to an IPv4-mapped IPv6 loopback literal answers 403 and dials nothing", async () => {
  const origin = await originOn();
  try {
    const tunnel = await viaConnect("[::ffff:127.0.0.1]", origin.port);
    expect(tunnel.head).toContain(" 403 ");
    expect(tunnel.head).toContain("application/json");
    expect(JSON.parse(tunnel.head.split("\r\n\r\n")[1] ?? "{}")).toEqual({ error: "egress: private address" });
    tunnel.socket.destroy();
    expect(origin.hits()).toBe(0);
  } finally {
    origin.close();
  }
});

test("P9 isPrivateAddress classifies mapped, compatible and NAT64 IPv4-embedded forms per T18", async () => {
  const { isPrivateAddress } = await import("../../sandbox/egress.mjs");
  const privateCases = [
    "::ffff:10.0.0.1",
    "::ffff:a00:1",
    "::ffff:c0a8:101",
    "::ffff:a9fe:a9fe",
    "::ffff:6440:1",
    "::ffff:0:0",
    "::a00:1",
    "64:ff9b::a00:1",
    "::",
    "::1",
    "fd00::1",
    "fe80::1",
  ];
  for (const address of privateCases) expect(isPrivateAddress(address), address).toBe(true);
  const publicCases = ["8.8.8.8", "::ffff:808:808", "2606:4700::1111"];
  for (const address of publicCases) expect(isPrivateAddress(address), address).toBe(false);
  expect(isPrivateAddress("not-an-ip")).toBe(true);
});
