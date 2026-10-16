// ANY-91 T19 — V10, the docker end-to-end: FABRIC_EXECUTION=docker, a session
// for an agent whose row maps sprite.exec, approval mode full_auto
// (session.approval_mode_set), and a scripted model calling
// shell { command: "echo hi > out.txt && cat out.txt" } — tool.completed shows
// `hi`, and <work>/agents/<agent>/out.txt exists on the host through the bind
// mount. Real docker daemon, real provider, real broker; skipped outside CI
// when the daemon is gone (T8's rule). The sandbox image is built from the
// tools package's Dockerfile when missing, as T8's globalSetup does.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { runWorker } from "@fabric/runtime";
import type { ModelCallRequest, ModelResult } from "@fabric/runtime";
import type { SpecialistAgent } from "@fabric/agents/session";
import { afterEach, expect, test } from "vitest";
import {
  RUNTIME_WORKSPACE,
  setSessionAgents,
  setSessionToolRegistry,
  setRuntime,
  startRuntime,
  workerPorts,
  type FabricRuntime,
} from "../runtime/bootstrap";
import { sessions } from "../routes/sessions";
import { SANDBOX_IMAGE } from "@fabric/tools/sandbox";

const run = promisify(execFile);

const daemonOk = await run("docker", ["info", "--format", "ok"]).then(
  () => true,
  (error: unknown) => {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    console.log(`[t19] docker daemon unreachable (${reason})`);
    return false;
  },
);

// Skip only when the daemon is gone AND CI is unset; in CI the case runs and
// a missing daemon fails it.
const withoutDaemon = !daemonOk && process.env.CI === undefined;
const dockerIt = test.skipIf(withoutDaemon);

if (daemonOk) {
  // the image, as T8's globalSetup builds it: only when missing
  try {
    await run("docker", ["image", "inspect", SANDBOX_IMAGE]);
  } catch {
    const context = path.join(
      fileURLToPath(new URL(".", import.meta.url)),
      "..",
      "..",
      "..",
      "..",
      "packages",
      "tools",
      "sandbox",
    );
    console.log(`[t19] image ${SANDBOX_IMAGE} missing; building from packages/tools/sandbox ...`);
    await run("docker", ["build", "-t", SANDBOX_IMAGE, context], { maxBuffer: 1 << 24 });
  }
}

const MAKER: SpecialistAgent = {
  id: "maker",
  name: "Maker",
  role: "Build",
  tools: [{ name: "sprite.exec", policy: "allowed" }],
};

/** The scripted model: the first call of the turn shells the echo; every
 * continuation answers with text and ends the turn. */
const scriptedModel = () => {
  let n = 0;
  return {
    call: async (request: ModelCallRequest): Promise<ModelResult> => {
      const last = request.messages[request.messages.length - 1];
      n += 1;
      if (last?.role === "user") {
        return {
          text: "",
          toolCalls: [
            { id: `c${n}`, name: "shell", args: { command: "echo hi > out.txt && cat out.txt" } },
          ],
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
          finishReason: "tool_calls",
        };
      }
      return { text: "done", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, finishReason: "stop" };
    },
  };
};

const app = (): Hono => new Hono().route("/api", sessions);

const call = (method: string, url: string, body?: unknown) =>
  app().request(url, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { "content-type": "application/json" },
  });

async function until<T>(runCondition: () => Promise<T | undefined>, ms = 120_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await runCondition();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("condition not reached within the window");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

let dataDir: string | undefined;
let workDir: string | undefined;
let rt: FabricRuntime | undefined;
let workerSignal: AbortController | undefined;

afterEach(async () => {
  workerSignal?.abort();
  workerSignal = undefined;
  setRuntime(undefined);
  setSessionToolRegistry(undefined);
  if (rt !== undefined) await rt.stop();
  rt = undefined;
  if (dataDir !== undefined) {
    await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
    workDir = undefined;
  }
});

dockerIt(
  "V10 docker end to end: the scripted shell runs in the sandbox and the file lands on the host",
  { timeout: 300_000 },
  async () => {
    setSessionAgents([MAKER]);
    dataDir = await mkdtemp(path.join(tmpdir(), "fabric-t19-docker-"));
    workDir = path.join(dataDir, "work");
    rt = await startRuntime(
      {
        RUNTIME_PGLITE_DIR: dataDir,
        MODEL_PORT: "test",
        FABRIC_MASTER_KEY_FILE: path.join(dataDir, "master.key"),
        FABRIC_WORK_DIR: workDir,
        FABRIC_EXECUTION: "docker",
      },
      // the loop is ours: the model is scripted
      { worker: false },
    );

    const sessionId = ((await (
      await call("POST", "/api/sessions", { agentId: "maker" })
    ).json()) as { sessionId: string }).sessionId;

    // full_auto: the shell's `mode` gate passes without a wait
    const mode = await call("PUT", `/api/sessions/${sessionId}/approval-mode`, { mode: "full_auto" });
    expect(mode.status).toBe(200);
    const events = await rt.store.readStream(`session:${sessionId}`, { workspaceId: RUNTIME_WORKSPACE });
    expect(events.some((event) => event.type === "session.approval_mode_set")).toBe(true);

    const posted = await call("POST", `/api/sessions/${sessionId}/messages`, {
      clientMessageId: randomUUID(),
      text: "write the file",
    });
    expect(posted.status).toBe(200);

    // the loop, over the real ports, the model scripted
    workerSignal = new AbortController();
    const ports = {
      ...workerPorts(
        { MODEL_PORT: "test", FABRIC_WORK_DIR: workDir },
        rt.live,
        undefined,
        rt.store,
        rt.vault,
      ),
      model: scriptedModel(),
    };
    void runWorker({
      store: rt.store,
      queue: rt.queue,
      ports,
      workerId: "t19-v10",
      signal: workerSignal.signal,
      pollIntervalMs: 100,
    });

    const completed = await until(async () =>
      (await rt!.store.readStream(`session:${sessionId}`, { workspaceId: RUNTIME_WORKSPACE })).find(
        (event) => event.type === "tool.completed",
      ),
    );
    const payload = completed!.payload as { callId: string; ok: boolean; result?: { tail?: string[] } };
    expect(payload.ok).toBe(true);
    expect(payload.result?.tail).toContain("hi");

    // the file, on the host, through the agent-folder bind mount
    expect(
      await readFile(path.join(workDir!, "agents", "maker", "out.txt"), "utf8"),
    ).toBe("hi\n");
  },
);
