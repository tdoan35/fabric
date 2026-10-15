// vitest globalSetup (T8): make sure the sandbox image exists before the
// daemon-backed cases run, building it from sandbox/Dockerfile when missing —
// docker's layer cache makes every later run fast. A machine without a daemon
// (and without CI) skips the sandbox cases by their own printed rule, so a
// daemon failure here is reported, not fatal; in CI a broken daemon fails the
// run either way through those cases.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

export default async function globalSetup(): Promise<void> {
  const image = process.env.FABRIC_SANDBOX_IMAGE ?? "fabric-sandbox:1";
  // The context of this file: sandbox/Dockerfile sits next to it.
  const context = fileURLToPath(new URL(".", import.meta.url));

  try {
    await run("docker", ["info", "--format", "ok"]);
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    console.log(`[sandbox] docker daemon unreachable (${reason}); not building ${image}`);
    return;
  }

  try {
    await run("docker", ["image", "inspect", image]);
    return; // cached from an earlier run
  } catch {
    console.log(`[sandbox] image ${image} missing; building from sandbox/Dockerfile ...`);
  }

  try {
    await run("docker", ["build", "-t", image, context], { maxBuffer: 16 * 1024 * 1024 });
    console.log(`[sandbox] built ${image}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n").slice(-4).join("\n") : String(error);
    throw new Error(`[sandbox] failed to build ${image}: ${reason}`);
  }
}
