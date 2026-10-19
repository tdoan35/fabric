// The daemon-backed egress cases E1–E9 (T18). They run against the real
// Docker daemon with the sandbox image, which the vitest globalSetup builds
// from sandbox/Dockerfile when it is missing. The whole suite is skipped, with
// a printed reason, only when `docker info` fails and CI is unset; in CI a
// missing daemon fails the suite — the same rule as the D-suite (T8).
//
// A local HTTP server stands in for the LAN (E4) and a fake broker listens on
// brokerBindHost() (E6); the gateway is reached through its per-provider
// network alias so parallel suites never race the shared `egress` name.
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { dockerSandboxes, type Sandbox, type SandboxProvider } from "../sandbox";

const run = promisify(execFile);

const daemonOk = await run("docker", ["info", "--format", "ok"]).then(
  () => true,
  (error: unknown) => {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    console.log(`[sandbox-egress] docker daemon unreachable (${reason})`);
    return false;
  }
);

// Skip only when the daemon is gone AND CI is unset; in CI the cases run and
// a missing daemon fails them.
const withoutDaemon = !daemonOk && process.env.CI === undefined;
if (withoutDaemon) {
  console.log(
    "[sandbox-egress] skipping E1-E9: `docker info` failed and CI is unset; run them on a machine with the daemon"
  );
}

const docker = test.skipIf(withoutDaemon);

let provider: SandboxProvider | undefined;

/** One provider per case, its gateway pinned to a per-case instance id (and
 * network alias `egress-<instance>`) so cases never share gateway state. */
const acquireWith = async (
  instance: string,
  egress?: { brokerPort?: number; extraHosts?: Record<string, string> }
): Promise<Sandbox> => {
  provider = dockerSandboxes({ egress: { instance, ...egress } });
  return provider.acquire({ workspaceId: "ws1", agentId: instance });
};

afterEach(async () => {
  await provider?.stopAll().catch(() => {});
  provider = undefined;
});

const dockerOut = async (...args: string[]): Promise<string> =>
  (await run("docker", args)).stdout;

const containerRunning = async (nameOrId: string): Promise<boolean> => {
  try {
    return (await run("docker", ["inspect", "-f", "{{.State.Running}}", nameOrId])).stdout.trim() === "true";
  } catch {
    return false;
  }
};

const containerId = async (name: string): Promise<string | null> => {
  try {
    return (await run("docker", ["inspect", "-f", "{{.Id}}", name])).stdout.trim();
  } catch {
    return null;
  }
};

/** The first non-internal IPv4 of this host — the LAN the proxy must refuse. */
const lanIPv4 = (): string => {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  throw new Error("no non-internal IPv4 on the test host for the E4 LAN case");
};

/** An HTTP server bound on `host` that counts the requests it served. */
const httpOn = (host: string): Promise<{ server: Server; port: number; hits: () => number; close: () => void }> => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    res.end("lan");
  });
  return new Promise((resolve) => {
    server.listen(0, host, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        server,
        port,
        hits: () => hits,
        close: () => server.closeAllConnections(),
      });
    });
  });
};

/** curl through this case's gateway alias; stdout is the body / code. */
const proxyGet = async (sandbox: Sandbox, gateway: string, url: string): Promise<string> => {
  const result = await sandbox.exec(`curl -sS --max-time 20 -x http://${gateway}:3128 ${url}`, {
    timeoutMs: 25_000,
  });
  expect(result.exitCode).toBe(0);
  return (result.tail.at(-1) ?? "").trim();
};

const E2_CURL = "curl -sS -o /dev/null -w '%{http_code}' --max-time 25 https://example.com";

docker("E1 fabric-sbx exists and is internal after the first acquire; re-running the setup is a no-op", async () => {
  await acquireWith("e1");
  expect((await dockerOut("network", "inspect", "-f", "{{.Internal}}", "fabric-sbx")).trim()).toBe("true");

  // A second acquire (and a second provider) re-runs the network setup; the
  // network is untouched and still internal.
  await provider?.acquire({ workspaceId: "ws1", agentId: "e1-again" });
  const second = dockerSandboxes();
  await second.acquire({ workspaceId: "ws1", agentId: "e1-second" });
  await second.stopAll().catch(() => {});
  expect((await dockerOut("network", "inspect", "-f", "{{.Internal}}", "fabric-sbx")).trim()).toBe("true");
});

docker("E2 https through the proxy from inside the sandbox returns 200", async () => {
  const sandbox = await acquireWith("e2");
  const result = await sandbox.exec(E2_CURL, { timeoutMs: 30_000 });
  expect(result.exitCode).toBe(0);
  expect((result.tail.at(-1) ?? "").trim()).toBe("200");
});

docker("E3 without the proxy there is no route: curl fails and raw TCP does not escape", async () => {
  const sandbox = await acquireWith("e3");

  // The sandbox sits on the internal network, not the default bridge.
  const networks = await dockerOut("inspect", "-f", "{{json .NetworkSettings.Networks}}", sandbox.id);
    expect(networks).toContain("fabric-sbx");
  expect(networks).not.toContain('"bridge"');

  const curl = await sandbox.exec("curl -sS -o /dev/null --noproxy '*' --max-time 8 https://example.com", {
    timeoutMs: 15_000,
  });
  expect(curl.exitCode).not.toBe(0);

  const raw = await sandbox.exec("timeout 5 bash -c 'exec 3<>/dev/tcp/example.com/443'", { timeoutMs: 15_000 });
  expect(raw.exitCode).not.toBe(0);
});

docker("E4 loopback, link-local and LAN destinations are refused 403; the servers see nothing", async () => {
  const lan = lanIPv4();
  const lanServer = await httpOn(lan);
  const loopbackServer = await httpOn("127.0.0.1");
  try {
    const sandbox = await acquireWith("e4");
    const destinations = [
      `http://${lan}:${lanServer.port}/ping`,
      "http://169.254.169.254/latest/meta-data/",
      `http://127.0.0.1:${loopbackServer.port}/ping`,
    ];
    for (const destination of destinations) {
      const body = await proxyGet(sandbox, "egress-e4", destination);
      expect(JSON.parse(body)).toEqual({ error: "egress: private address" });
    }
    expect(lanServer.hits()).toBe(0);
    expect(loopbackServer.hits()).toBe(0);
  } finally {
    lanServer.server.close();
    loopbackServer.close();
  }
});

docker("E10 an IPv4-mapped IPv6 form of the LAN address is refused 403; the server sees nothing", async () => {
  const lan = lanIPv4();
  const lanServer = await httpOn(lan);
  try {
    const sandbox = await acquireWith("e10");
    // The IPv4-mapped form of the LAN address, hex groups per RFC 5952 §4:
    // the last 32 bits are TWO 16-bit groups (`::ffff:a00:cb`), not one group
    // per octet — `::ffff:a:0:0:cb` is a different address with the mapped
    // prefix in the wrong place, and dials as plain IPv6 (no route in the
    // v4-only sandbox network; the CI failure this corrects).
    const octets = lan.split(".").map(Number);
    const mapped = `::ffff:${(octets[0] << 8 | octets[1]).toString(16)}:${(octets[2] << 8 | octets[3]).toString(16)}`;
    // `-w` appends the HTTP status as the final line, after the body — the
    // refusal must be a real 403, not just refusal-shaped body text.
    const result = await sandbox.exec(
      `curl -sS --max-time 20 -x http://egress-e10:3128 -w '\\n%{http_code}' http://[${mapped}]:${lanServer.port}/ping`,
      { timeoutMs: 25_000 }
    );
    expect(result.exitCode).toBe(0);
    const status = (result.tail.at(-1) ?? "").trim();
    const body = result.tail.slice(0, -1).join("").trim();
    expect(status, body).toBe("403");
    expect(JSON.parse(body)).toEqual({ error: "egress: private address" });
    expect(lanServer.hits()).toBe(0);
  } finally {
    lanServer.server.close();
  }
});

docker("E5 a host resolving to a private address via extra-hosts is refused before dialing", async () => {
  const sandbox = await acquireWith("e5", { extraHosts: { "private.test": "10.255.255.1" } });
  const body = await proxyGet(sandbox, "egress-e5", "http://private.test/ping");
  expect(JSON.parse(body)).toEqual({ error: "egress: private address" });
});

docker("E6 the broker route forwards method, path and the egress token to the broker", async () => {
  const { brokerBindHost } = await import("../sandbox/network");
  const seen: { method?: string; url?: string; token?: string }[] = [];
  const broker = createServer((req, res) => {
  seen.push({
    method: req.method,
    url: req.url,
    token: req.headers["fabric_egress_token"] as string | undefined,
  });
  res.end("broker-pong");
  });
  const brokerHost = await brokerBindHost();
  await new Promise<void>((resolve) => broker.listen(0, brokerHost, resolve));
  try {
    const sandbox = await acquireWith("e6", { brokerPort: (broker.address() as AddressInfo).port });
    // --noproxy: the env's NO_PROXY exempts the shared `egress` name only, and
    // the per-instance alias resolves to the gateway's own (private) address —
    // proxied, the request would be refused 403 like any private target. The
    // broker route is a direct :80 hit by construction.
    const body = await sandbox.exec("curl -sS --noproxy '*' --max-time 20 -H 'FABRIC_EGRESS_TOKEN: tok-123' http://egress-e6/ping", {
      timeoutMs: 25_000,
    });
    expect(body.exitCode).toBe(0);
    expect((body.tail.at(-1) ?? "").trim()).toBe("broker-pong");
    expect(seen).toEqual([{ method: "GET", url: "/ping", token: "tok-123" }]);
  } finally {
    broker.closeAllConnections();
    broker.close();
  }
});

docker("E7 brokerBindHost is the bridge gateway IP on Linux and never 0.0.0.0", async () => {
  const { brokerBindHost } = await import("../sandbox/network");
  const host = await brokerBindHost();
  expect(host).not.toBe("");
  expect(host).not.toBe("0.0.0.0");
  if (process.platform === "linux") {
    const gateway = (
      await run("docker", ["network", "inspect", "-f", "{{(index .IPAM.Config 0).Gateway}}", "bridge"])
    ).stdout.trim();
    expect(host).toBe(gateway);
  } else {
    // Docker Desktop forwards host.docker.internal to the host loopback.
    expect(host).toBe("127.0.0.1");
  }
});

docker("E8 a dead gateway is replaced on the next acquire and egress works again", async () => {
  const sandbox = await acquireWith("e8");
  const first = await containerId("fabric-egress-e8");
  expect(first).not.toBeNull();
  await run("docker", ["rm", "-f", "fabric-egress-e8"]);

  await provider?.acquire({ workspaceId: "ws1", agentId: "e8" });
  const second = await containerId("fabric-egress-e8");
  expect(second).not.toBeNull();
  expect(second).not.toBe(first);

  const result = await sandbox.exec(E2_CURL, { timeoutMs: 30_000 });
  expect(result.exitCode).toBe(0);
  expect((result.tail.at(-1) ?? "").trim()).toBe("200");
});

docker("E9 stopAll removes the sandboxes and the gateway; the network may stay", async () => {
  const sandbox = await acquireWith("e9");
  expect(await containerRunning("fabric-egress-e9")).toBe(true);

  await provider?.stopAll();

  expect(await containerRunning("fabric-egress-e9")).toBe(false);
  expect(await containerRunning(sandbox.id)).toBe(false);
  expect((await dockerOut("network", "inspect", "-f", "{{.Name}}", "fabric-sbx")).trim()).toBe("fabric-sbx");
});
