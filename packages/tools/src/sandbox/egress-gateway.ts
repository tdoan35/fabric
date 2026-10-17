// The egress gateway (ANY-44 T18): one container from the sandbox image
// running `node /opt/fabric/egress.mjs` (see sandbox/egress.mjs). It sits on
// the internal `fabric-sbx` network — alias `egress`, plus a per-instance
// alias so concurrent providers never share gateway state — and on the
// default bridge for its own route to the broker. On Linux it also gets
// host.docker.internal via host-gateway. It listens on 80 and 3128, runs
// with no capabilities but NET_BIND_SERVICE, is started by the provider on
// first acquire, replaced when found dead, and removed by stopAll.
import { randomBytes } from "node:crypto";
import { SANDBOX_IMAGE } from "./image";
import { SANDBOX_NETWORK, dockerRun } from "./network";

export interface EgressGatewayOptions {
  /** The image to run; default SANDBOX_IMAGE (FABRIC_SANDBOX_IMAGE). */
  image?: string;
  /** The docker CLI; default `docker` on PATH. */
  docker?: string;
  /** Broker port for the :80 forwarder; without it the route answers 502. */
  brokerPort?: number;
  /** Test-only extra hosts for the gateway container (name → ip). */
  extraHosts?: Record<string, string>;
  /** Stable instance id; defaults to a random one per provider. */
  instance?: string;
}

/** The gateway's container name for `instance`. */
export const egressName = (instance: string): string => `fabric-egress-${instance}`;

const sanitize = (instance: string): string => instance.replaceAll(/[^a-zA-Z0-9_.-]/g, "-");

const runningId = async (run: (args: string[]) => Promise<string>, name: string): Promise<string | null> => {
  try {
    return (await run(["inspect", "-f", "{{.Id}}", name])).trim();
  } catch {
    return null;
  }
};

const running = async (run: (args: string[]) => Promise<string>, name: string): Promise<boolean> => {
  try {
    return (await run(["inspect", "-f", "{{.State.Running}}", name])).trim() === "true";
  } catch {
    return false;
  }
};

/** Wait until the container is fully gone: a `rm -f` returned while the
 * engine still tears down network aliases makes the immediate re-`run` with
 * the same name race (the alias briefly serving a dead endpoint resets the
 * first proxied connection — the CI E8 curl 56). Bounded; the run's own
 * error paths are the fallback. */
const awaitGone = async (run: (args: string[]) => Promise<string>, name: string): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await run(["inspect", "-f", "{{.Id}}", name]);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

/** Wait until the gateway prints its listening line (the bind is fast; the
 * poll only covers the container start), so the first request connects. */
const awaitListening = async (run: (args: string[]) => Promise<string>, name: string): Promise<void> => {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      if (/listening proxy=/.test(await run(["logs", name]))) return;
    } catch {
      return; // no logs yet, or `logs` unsupported by a shim
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

/**
 * Ensure this instance's gateway is up: reuse the healthy one, replace a dead
 * or stale one, create it on first acquire. Returns the container id.
 */
export async function ensureEgressGateway(options: EgressGatewayOptions = {}): Promise<string> {
  const docker = options.docker ?? "docker";
  const run = (args: string[]): Promise<string> => dockerRun(docker, args);
  const image = options.image ?? SANDBOX_IMAGE;
  const instance = sanitize(options.instance ?? randomBytes(6).toString("hex"));
  const name = egressName(instance);

  const live = await runningId(run, name);
  if (live !== null && (await running(run, name))) return live;
  if (live !== null) {
    await run(["rm", "-f", name]).catch(() => {});
    await awaitGone(run, name);
  }

  const argv = [
    "run", "-d", "--name", name,
    "--label", "fabric.egress=1",
    "--label", `fabric.egress.instance=${instance}`,
    "--network", SANDBOX_NETWORK,
    "--network-alias", "egress",
    "--network-alias", `egress-${instance}`,
    "--cap-drop", "ALL", "--cap-add", "NET_BIND_SERVICE",
  ];
  if (process.platform === "linux") argv.push("--add-host", "host.docker.internal:host-gateway");
  for (const [host, ip] of Object.entries(options.extraHosts ?? {})) {
    argv.push("--add-host", `${host}:${ip}`);
  }
  if (options.brokerPort !== undefined) argv.push("-e", `FABRIC_BROKER_PORT=${options.brokerPort}`);
  argv.push(image, "node", "/opt/fabric/egress.mjs");

  const id = (await run(argv).catch(async (error: unknown) => {
    // One bounded retry: a same-name recreate can still lose the race against
    // the engine's endpoint cleanup under load.
    await awaitGone(run, name);
    return run(argv).catch(() => {
      throw error;
    });
  })).trim();
  // Second leg: the default bridge, for the gateway → broker route.
  await run(["network", "connect", "bridge", id]).catch(() => {});
  await awaitListening(run, name);
  return id;
}

/** Remove this instance's gateway (stopAll). */
export async function stopEgressGateway(instance: string, docker = "docker"): Promise<void> {
  await dockerRun(docker, ["rm", "-f", egressName(sanitize(instance))]).catch(() => {});
}
