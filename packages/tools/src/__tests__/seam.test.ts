// ANY-67 R11 — the seam with the runtime: a registry port passed as `tools`
// to handleToolExecJob on the PGlite driver. The `tool.call` payload carries
// no effect, so the handler falls back to describe's — observable because a
// "once" tool crashed-after-run must not run again on the retry — and the
// first run appends `tool.completed` with the tool's result.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import {
  append,
  handleToolExecJob,
  MemoryQueue,
  openStore,
  type EventInput,
  type StoredEvent,
} from "@fabric/runtime";
import { createRegistry, defineTool } from "../index";

const WORKSPACE = "ws-t1";
const SCOPE = { workspaceId: WORKSPACE, streamId: "run:t1", agentId: "agent-1" };
const CRASH = "simulated crash after the tool ran";

const runCreated: EventInput = {
  type: "run.created",
  actor: "api",
  payload: {
    definition: { systemPrompt: "SYS", tools: ["charge_card"] },
    engineVersion: "v1",
    brief: "",
    grants: ["charge_card"],
    budgets: {},
    parent: null,
  },
};

/** No `effect` in the payload — the seam check is that describe supplies it. */
const toolCalled = (callId: string, args: Record<string, unknown>): EventInput => ({
  type: "tool.call",
  actor: "decide",
  payload: { tool: "charge_card", summary: "charge it", callId, args },
});

async function seed(store: RuntimeStore, streamId: string, events: readonly EventInput[]) {
  await store.transaction((tx) => append(tx, WORKSPACE, [{ streamId, events }]));
}

async function claimToolExec(
  store: RuntimeStore,
  queue: MemoryQueue,
  streamId: string,
  callId: string
) {
  await store.transaction((tx) =>
    queue.enqueue(tx, {
      type: "tool.exec",
      key: `${streamId}:${callId}`,
      streamId,
      workspaceId: WORKSPACE,
    })
  );
  const lease = await queue.claim("worker-1", ["tool.exec"], 0);
  if (lease === null) throw new Error("expected a claimable tool.exec job in the seam setup");
  return lease;
}

/** The store, crashing after the transaction's work ran: side effects done, nothing recorded. */
const crashingAfterRun = (store: RuntimeStore): RuntimeStore => ({
  transaction: (fn) =>
    store.transaction(async (tx) => {
      await fn(tx);
      throw new Error(CRASH);
    }),
  readStream: (streamId, options) => store.readStream(streamId, options),
  close: () => store.close(),
});

const of = (events: readonly StoredEvent[], type: string) =>
  events.filter((event) => event.type === type);

test("R11 a registry port behind handleToolExecJob (PGlite): the effect falls back to describe and tool.completed carries the result", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "tools-pglite-"));
  const store = await openStore({ driver: "pglite", dataDir: dir });
  try {
    let runs = 0;
    const charge = defineTool({
      name: "charge_card",
      description: "Charge a card once",
      parameters: z.object({ amount: z.number() }),
      effect: "once",
      gate: "always",
      kind: "external",
      step: 0,
      execute: async (args) => {
        runs += 1;
        return { charged: args.amount };
      },
    });
    const tools = createRegistry([charge]).toolPort(SCOPE);
    const queue = new MemoryQueue();

    // Completion: the run appends tool.completed with the tool's result.
    await seed(store, "run:one", [runCreated, toolCalled("c1", { amount: 7 })]);
    await handleToolExecJob(
      await claimToolExec(store, queue, "run:one", "c1"),
      { store, queue, tools, now: () => 0 }
    );
    const completed = of(await store.readStream("run:one", { workspaceId: WORKSPACE }), "tool.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]!.payload).toMatchObject({ callId: "c1", ok: true, result: { charged: 7 } });

    // The fallback decides recovery: describe's "once" means a retry after a
    // crash records the interruption instead of a second run. Had the
    // fallback broken (default "read"), the tool would re-run and complete.
    await seed(store, "run:two", [runCreated, toolCalled("c2", { amount: 5 })]);
    await expect(
      handleToolExecJob(await claimToolExec(store, queue, "run:two", "c2"), {
        store: crashingAfterRun(store),
        queue,
        tools,
        now: () => 0,
      })
    ).rejects.toThrow(CRASH);
    expect(runs).toBe(2);

    const retry = await queue.claim("worker-2", ["tool.exec"], 30_000);
    expect(retry?.attempt).toBe(2);
    await handleToolExecJob(retry!, { store, queue, tools, now: () => 30_000 });

    expect(runs).toBe(2); // describe said "once": no second run
    const interrupted = of(await store.readStream("run:two", { workspaceId: WORKSPACE }), "tool.interrupted");
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]!.payload).toMatchObject({ callId: "c2", effect: "once" });
    expect(of(await store.readStream("run:two", { workspaceId: WORKSPACE }), "tool.completed")).toHaveLength(0);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
