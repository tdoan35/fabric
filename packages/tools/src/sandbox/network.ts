// The sandbox network shape (ANY-44 T18): `fabric-sbx` is a Docker network
// created with --internal, so containers on it have no route out — the open
// web arrives only through the egress gateway, and the LAN is unreachable.
// Setup is idempotent: an existing internal network is left alone, a
// non-internal one is replaced. The default bridge needs no setup; the
// gateway attaches to it for its own route to the broker.
import { spawn } from "node:child_process";

export const SANDBOX_NETWORK = "fabric-sbx";

/** One `docker` invocation: stdout when it exits 0, the stderr otherwise. */
export const dockerRun = (docker: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(docker, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let failure = "";
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => (failure += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
      else reject(new Error(`docker ${args.join(" ")} failed: ${failure.trim()}`));
    });
  });

/** The internal sandbox network, present exactly once. */
export async function ensureSandboxNetwork(docker = "docker"): Promise<void> {
  const run = (args: string[]): Promise<string> => dockerRun(docker, args);
  let internal: string | null = null;
  try {
    internal = (await run(["network", "inspect", "-f", "{{.Internal}}", SANDBOX_NETWORK])).trim();
  } catch {
    internal = null; // absent, or no daemon yet — create and let docker say.
  }
  if (internal === "true") return;
  if (internal !== null) {
    // Exists but wide: replace it so the no-route invariant holds.
    await run(["network", "rm", "-f", SANDBOX_NETWORK]).catch(() => {});
  }
  try {
    await run(["network", "create", "--internal", SANDBOX_NETWORK]);
  } catch {
    // Raced creation, or the inspect above lied about existence: verify.
    const now = await run(["network", "inspect", "-f", "{{.Internal}}", SANDBOX_NETWORK]).catch(() => "missing");
    if (now.trim() !== "true") throw new Error(`could not ensure the ${SANDBOX_NETWORK} internal network`);
  }
}

/**
 * The address the broker must listen on so the egress gateway can reach it —
 * and nothing wider. On Linux that is the default bridge's gateway IP (the
 * gateway forwards to host.docker.internal, which maps there); on Docker
 * Desktop (macOS/Windows) the desktop forwards host.docker.internal to the
 * host loopback, so 127.0.0.1. T19 starts the broker with this host.
 */
export async function brokerBindHost(docker = "docker"): Promise<string> {
  if (process.platform !== "linux") return "127.0.0.1";
  const gateway = (
    await dockerRun(docker, ["network", "inspect", "-f", "{{(index .IPAM.Config 0).Gateway}}", "bridge"])
  ).trim();
  if (gateway === "") throw new Error("the default bridge has no gateway address; is the docker daemon up?");
  return gateway;
}
