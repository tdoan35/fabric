// ANY-92 T16 — C11, the server end-to-end: FABRIC_EXECUTION=docker (fake
// provider, no daemon) with FABRIC_SANDBOX_SLOTS=1 and two sessions calling
// `shell` at once. One call runs; the other's stream shows `tool.queued`
// while it waits, then `tool.dequeued`, and both complete. The runtime is
// booted with worker: false and the test drives its own two worker loops so
// both tool.exec jobs are in flight together.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { Hono } from "hono";
import { runWorker } from "@fabric/runtime";
import type { ModelCallRequest, ModelResult } from "@fabric/runtime";
import type { Sandbox, SandboxAvailability, SandboxProvider } from "@fabric/tools/sandbox";
import type { SpecialistAgent } from "@fabric/agents/session";
import { afterEach, expect, test } from "vitest";
import {
  RUNTIME_WORKSPACE,
  setSessionAgents,
  setRuntime,
  startRuntime,
  workerPorts,
  type FabricRuntime,
} from "../runtime/bootstrap";
import { sessions } from "../routes/sessions";

const MAKER: SpecialistAgent = {
  id: "maker",
  name: "Maker",
  role: "Build",
  tools: [{ name: "sprite.exec", policy: "allowed" }],
};

/** A sandbox provider whose exec calls park on a gate: the first call holds
 * the workspace's one slot until the test opens it. */
const gatedProvider = () => {
  const state = {
    execs: [] as string[],
    availability: { ok: true } as SandboxAvailability,
    stopped: false,
  };
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => (openGate = resolve));
  const sandbox = (agentId: string): Sandbox => ({
    id: `${agentId}-1`,
    async exec(command) {
      state.execs.push(command);
      await gate;
      return { exitCode: 0, timedOut: false, tail: ["done"] };
    },
    async putArchive() {},
    getArchive: () => new PassThrough() as never,
  });
  const provider: SandboxProvider = {
    async acquire(request) {
      return sandbox(request.agentId);
    },
    async reap() {},
    async stopAll() {
      state.stopped = true;
    },
    async available() {
      return state.availability;
    },
  };
  return { provider, state, open: openGate };
};

/** The scripted model: a turn's first call shells `echo done`; every
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
          toolCalls: [{ id: `c${n}`, name: "shell", args: { command: "echo done" } }],
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
          finishReason: "tool_calls",
        };
      }
      return {
        text: "done",
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
        finishReason: "stop",
      };
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

async function until(run: () => Promise<boolean>, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await run()) return;
    if (Date.now() > deadline) throw new Error("condition not reached within the window");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

let dataDir: string | undefined;
let rt: FabricRuntime | undefined;
let workerSignal: AbortController | undefined;
let workers: Promise<void>[] = [];

afterEach(async () => {
  workerSignal?.abort();
  workerSignal = undefined;
  // the loops exit after their pass; settle them before the store closes
  await Promise.allSettled(workers);
  workers = [];
  setRuntime(undefined);
  if (rt !== undefined) await rt.stop();
  rt = undefined;
  if (dataDir !== undefined) {
    await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  }
});

test(
  "C11 docker (fake provider) with one slot: one shell runs, the other queues, both complete",
  { timeout: 60_000 },
  async () => {
    setSessionAgents([MAKER]);
    const fake = gatedProvider();
    dataDir = await mkdtemp(path.join(tmpdir(), "fabric-t16-slots-"));
    rt = await startRuntime(
      {
        RUNTIME_PGLITE_DIR: dataDir,
        MODEL_PORT: "test",
        FABRIC_MASTER_KEY_FILE: path.join(dataDir, "master.key"),
        FABRIC_WORK_DIR: path.join(dataDir, "work"),
        FABRIC_EXECUTION: "docker",
        FABRIC_SANDBOX_SLOTS: 1,
      },
      { worker: false, provider: fake.provider, brokerHost: "127.0.0.1" },
    );

    const sessionIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const sessionId = ((await (
        await call("POST", "/api/sessions", { agentId: "maker" })
      ).json()) as { sessionId: string }).sessionId;
      sessionIds.push(sessionId);
      const mode = await call("PUT", `/api/sessions/${sessionId}/approval-mode`, { mode: "full_auto" });
      expect(mode.status).toBe(200);
      const posted = await call("POST", `/api/sessions/${sessionId}/messages`, {
        clientMessageId: randomUUID(),
        text: `run it ${i}`,
      });
      expect(posted.status).toBe(200);
    }
    const streamIds = sessionIds.map((sessionId) => `session:${sessionId}`);
    const read = (streamId: string) => rt!.store.readStream(streamId, { workspaceId: RUNTIME_WORKSPACE });

    // two workers so both tool.exec jobs are in flight together; the ports
    // carry the sandbox execution and the one-slot cap
    workerSignal = new AbortController();
    const ports = {
      ...workerPorts(
        {
          MODEL_PORT: "test",
          FABRIC_WORK_DIR: path.join(dataDir, "work"),
          FABRIC_EXECUTION: "docker",
          FABRIC_SANDBOX_SLOTS: 1,
        },
        rt.live,
        undefined,
        rt.store,
        rt.vault,
      ),
      model: scriptedModel(),
    };
    for (const index of [0, 1]) {
      workers.push(
        runWorker({
          store: rt.store,
          queue: rt.queue,
          ports,
          workerId: `t16-c11-${index}`,
          signal: workerSignal.signal,
          pollIntervalMs: 50,
        }),
      );
    }

    // the divider: either a call is queued for a slot (the cap held), or both
    // calls ran at once (no cap — the red state). Then let the holder finish.
    await until(async () => {
      for (const streamId of streamIds) {
        if ((await read(streamId)).some((event) => event.type === "tool.queued")) return true;
      }
      return fake.state.execs.length >= 2;
    });
    fake.open();
    await until(async () => {
      for (const streamId of streamIds) {
        if (!(await read(streamId)).some((event) => event.type === "tool.completed")) return false;
      }
      return true;
    });

    // exactly one call waited for the slot, at position 1, as a sandbox_slot
    const queuedBatches = await Promise.all(streamIds.map((streamId) => read(streamId)));
    const queued = queuedBatches.flat().filter((event) => event.type === "tool.queued");
    expect(queued).toHaveLength(1);
    expect(queued[0]!.payload).toMatchObject({ reason: "sandbox_slot", position: 1 });
    const queuedStream = queuedBatches.find((events) => events.some((event) => event.type === "tool.queued"))!;
    const dequeued = queuedStream.filter((event) => event.type === "tool.dequeued");
    expect(dequeued).toHaveLength(1);
    const waitedMs = (dequeued[0]!.payload as { waitedMs: number }).waitedMs;
    expect(typeof waitedMs).toBe("number");
    expect(waitedMs).toBeGreaterThanOrEqual(0);

    // and both calls ran, one after the other, completing normally
    expect(fake.state.execs).toHaveLength(2);
    for (const events of queuedBatches) {
      const completed = events.filter((event) => event.type === "tool.completed");
      expect(completed).toHaveLength(1);
      expect((completed[0]!.payload as { ok: boolean }).ok).toBe(true);
    }
  },
);
