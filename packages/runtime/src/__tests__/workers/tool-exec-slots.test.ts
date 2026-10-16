// ANY-92 T16 — the `tool.exec` slot gate (C5–C7, C10): a step-2 call whose
// workspace slot is taken appends `tool.queued` (once per position), defers
// the job by 2 s — attempt untouched — and runs nothing; a granted call
// records `tool.dequeued` with its wait, holds the slot through the run and
// releases it on completion or failure. Host mode — no slots port, or a tool
// that needs none — is byte-identical to the R14 path. Both drivers.
import { expect, test } from "vitest";
import { append, sandboxSlots } from "../../index";
import type { EventInput, RuntimeStore } from "../../index";
import { MemoryQueue } from "../../queue/memory";
import type { Queue } from "../../queue/types";
import { describeDrivers } from "../../testing/drivers";
import { handleToolExecJob } from "../../workers/tool-exec";
import type { ToolDescriptor, ToolRunResult } from "../../ports";

const WORKSPACE = "ws-t16x";

// -- fixtures -------------------------------------------------------------------

const runCreated = (streamId: string): EventInput => ({
  type: "run.created",
  actor: "api",
  payload: {
    definition: { systemPrompt: "SYS", tools: ["sh"] },
    engineVersion: "v1",
    brief: "",
    grants: ["sh"],
    budgets: {},
    parent: null,
  },
});

const toolCalled = (streamId: string, callId: string, effect: string): EventInput => ({
  type: "tool.call",
  actor: "decide",
  payload: { tool: "sh", summary: "run it", callId, args: {}, effect },
});

/** A scripted ToolPort with the T16 answer: `needsSlot` per tool. */
class SlotTools {
  readonly calls: string[] = [];

  constructor(
    private readonly specs: Record<
      string,
      {
        effect: string;
        needsSlot: boolean;
        runs?: readonly { ok: boolean; result?: unknown; lines?: readonly string[] }[];
        throws?: Error;
      }
    >
  ) {}

  count(tool: string): number {
    return this.calls.filter((name) => name === tool).length;
  }

  async run(
    tool: string,
    args: Record<string, unknown>,
    io: { onLine?: (line: string) => void }
  ): Promise<ToolRunResult> {
    const spec = this.specs[tool];
    if (spec === undefined) throw new Error(`no spec for ${tool}`);
    this.calls.push(tool);
    if (spec.throws !== undefined) throw spec.throws;
    const run = spec.runs?.[0];
    if (run === undefined) throw new Error(`no scripted run for ${tool}`);
    for (const line of run.lines ?? []) io.onLine?.(line);
    return {
      ok: run.ok,
      ...(run.result !== undefined ? { result: run.result } : {}),
    };
  }

  describe(tool: string): ToolDescriptor | undefined {
    const spec = this.specs[tool];
    return spec === undefined ? undefined : { name: tool, effect: spec.effect as never };
  }

  needsSlot(tool: string): boolean {
    return this.specs[tool]?.needsSlot ?? false;
  }
}

async function seed(store: RuntimeStore, streamId: string, events: readonly EventInput[]) {
  await store.transaction((tx) => append(tx, WORKSPACE, [{ streamId, events }]));
}

async function enqueueToolExec(
  store: RuntimeStore,
  queue: Queue,
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
}

async function claimToolExec(queue: Queue, streamId: string, callId: string, now = 0) {
  const lease = await queue.claim("worker-1", ["tool.exec"], now);
  if (lease === null) throw new Error("expected a claimable tool.exec job in the test setup");
  expect(lease.key).toBe(`${streamId}:${callId}`);
  return lease;
}

const of = <T extends { type: string }>(events: readonly T[], type: string) =>
  events.filter((event) => event.type === type);

/** The fact envelope modulo the stream id — the C10 byte-identity projection. */
async function factBodies(store: RuntimeStore, streamId: string) {
  const events = await store.readStream(streamId, { workspaceId: WORKSPACE });
  return events.map((event) => ({
    type: event.type,
    class: event.class,
    actor: event.actor,
    payload: event.payload,
    causation: event.causation === null ? null : event.causation.replace(`${streamId}:`, ""),
  }));
}

describeDrivers("tool.exec sandbox slots (ANY-92 T16)", (h) => {
  test("C5 with the slot held elsewhere the call queues once, the job defers by 2 s, and the tool is not called", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const slots = sandboxSlots(store, { cap: 1 });
    // the slot is held by a different call of the same workspace
    expect((await slots.acquire({ workspaceId: WORKSPACE, callKey: "run:zz:hold", priority: 1, now: 0 })).granted).toBe(true);

    const streamId = "run:t16-c5";
    const tools = new SlotTools({ sh: { effect: "read", needsSlot: true, runs: [{ ok: true, result: "listing" }] } });
    await seed(store, streamId, [runCreated(streamId), toolCalled(streamId, "c1", "read")]);
    await enqueueToolExec(store, queue, streamId, "c1");
    const lease = await claimToolExec(queue, streamId, "c1");

    await handleToolExecJob(lease, { store, queue, tools, slots, now: () => 5_000 });

    // nothing ran
    expect(tools.count("sh")).toBe(0);
    // the wait is a fact, once, at the position the queue gave
    const events = await store.readStream(streamId, { workspaceId: WORKSPACE });
    const queued = of(events, "tool.queued");
    expect(queued).toHaveLength(1);
    expect(queued[0]!.payload).toEqual({ callId: "c1", reason: "sandbox_slot", position: 1 });
    expect(queued[0]!.causation).toBe(`${streamId}:c1:tool.queued:1`);
    // the job is back to pending 2 s out, the attempt untouched by the wait
    const job = await queue.get(lease.jobId);
    expect(job?.status).toBe("pending");
    expect(job?.runAt).toBe(7_000);
    expect(job?.lastError).toBeNull();

    // a second deferral at the same position appends nothing
    const again = await queue.claim("worker-2", ["tool.exec"], 7_000);
    expect(again?.attempt).toBe(1); // the defer gave the attempt back
    await handleToolExecJob(again!, { store, queue, tools, slots, now: () => 7_000 });
    expect(of(await store.readStream(streamId, { workspaceId: WORKSPACE }), "tool.queued")).toHaveLength(1);
    expect(tools.count("sh")).toBe(0);
  });

  test("C6 when the slot frees the next run dequeues with its wait, runs, completes and releases", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const slots = sandboxSlots(store, { cap: 1 });
    expect((await slots.acquire({ workspaceId: WORKSPACE, callKey: "run:zz:hold", priority: 1, now: 0 })).granted).toBe(true);

    const streamId = "run:t16-c6";
    const tools = new SlotTools({
      sh: { effect: "read", needsSlot: true, runs: [{ ok: true, result: "listing", lines: ["$ ls"] }] },
    });
    await seed(store, streamId, [runCreated(streamId), toolCalled(streamId, "c1", "read")]);
    await enqueueToolExec(store, queue, streamId, "c1");
    const lease = await claimToolExec(queue, streamId, "c1");
    await handleToolExecJob(lease, { store, queue, tools, slots, now: () => 5_000 });
    expect(tools.count("sh")).toBe(0);

    // the holder finishes; the deferred job comes back at +2 s and gets in
    await slots.release("run:zz:hold");
    const again = await queue.claim("worker-2", ["tool.exec"], 7_000);
    await handleToolExecJob(again!, { store, queue, tools, slots, now: () => 7_000 });

    expect(tools.count("sh")).toBe(1);
    const events = await store.readStream(streamId, { workspaceId: WORKSPACE });
    const dequeued = of(events, "tool.dequeued");
    expect(dequeued).toHaveLength(1);
    // the wait: registered at 5_000, granted at 7_000
    expect(dequeued[0]!.payload).toEqual({ callId: "c1", waitedMs: 2_000 });
    const completed = of(events, "tool.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]!.payload).toMatchObject({ callId: "c1", ok: true, result: "listing" });

    // the slot went back with the completion: a fresh acquire walks straight in
    expect(
      (await slots.acquire({ workspaceId: WORKSPACE, callKey: "run:zz:probe", priority: 1, now: 8_000 })).granted
    ).toBe(true);
  });

  test("C7 a tool that throws releases the slot and follows the normal failure path", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const slots = sandboxSlots(store, { cap: 1 });

    const streamId = "run:t16-c7";
    const tools = new SlotTools({
      sh: { effect: "read", needsSlot: true, throws: new Error("sandbox gone") },
    });
    await seed(store, streamId, [runCreated(streamId), toolCalled(streamId, "c1", "read")]);
    await enqueueToolExec(store, queue, streamId, "c1");
    const lease = await claimToolExec(queue, streamId, "c1");

    await expect(
      handleToolExecJob(lease, { store, queue, tools, slots, now: () => 5_000 })
    ).rejects.toThrow("sandbox gone");

    // the slot went back even on the failure path
    expect(
      (await slots.acquire({ workspaceId: WORKSPACE, callKey: "run:zz:probe", priority: 1, now: 5_100 })).granted
    ).toBe(true);
    // and the job failed retryably like any tool.exec: pending on the backoff,
    // the error recorded, no completion fact on the stream
    const job = await queue.get(lease.jobId);
    expect(job?.status).toBe("pending");
    expect(job?.runAt).toBe(35_000); // tool.exec's 30 s backoff from the 5 s clock
    expect(job?.lastError).toBe("sandbox gone");
    const events = await store.readStream(streamId, { workspaceId: WORKSPACE });
    expect(of(events, "tool.completed")).toHaveLength(0);
    expect(of(events, "tool.queued")).toHaveLength(0); // the slot was free; the call never queued
  });

  test("C10 host mode — no slots port, or a tool that needs none — is byte-identical to the R14 run", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const slots = sandboxSlots(store, { cap: 1 });

    // the R14 baseline: no slots port at all, the tool would need a slot
    const streamA = "run:t16-a";
    const toolsA = new SlotTools({
      sh: { effect: "read", needsSlot: true, runs: [{ ok: true, result: "done", lines: ["$ ls", "out"] }] },
    });
    await seed(store, streamA, [runCreated(streamA), toolCalled(streamA, "c1", "read")]);
    await enqueueToolExec(store, queue, streamA, "c1");
    const leaseA = await claimToolExec(queue, streamA, "c1");
    await handleToolExecJob(leaseA, { store, queue, tools: toolsA, now: () => 5_000 });

    // host tool under a wired slots port: needsSlot false, the gate never opens
    const streamB = "run:t16-b";
    const toolsB = new SlotTools({
      sh: { effect: "read", needsSlot: false, runs: [{ ok: true, result: "done", lines: ["$ ls", "out"] }] },
    });
    await seed(store, streamB, [runCreated(streamB), toolCalled(streamB, "c1", "read")]);
    await enqueueToolExec(store, queue, streamB, "c1");
    const leaseB = await claimToolExec(queue, streamB, "c1");
    await handleToolExecJob(leaseB, { store, queue, tools: toolsB, slots, now: () => 5_000 });

    const factsA = await factBodies(store, streamA);
    const factsB = await factBodies(store, streamB);
    expect(factsB).toEqual(factsA);
    for (const facts of [factsA, factsB]) {
      expect(facts.some((fact) => fact.type === "tool.queued")).toBe(false);
      expect(facts.some((fact) => fact.type === "tool.dequeued")).toBe(false);
    }
  });
});
