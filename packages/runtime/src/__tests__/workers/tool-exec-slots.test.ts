// ANY-92 T16 — the `tool.exec` slot gate (C5–C7, C10): a step-2 call whose
// workspace slot is taken appends `tool.queued` per transition, defers
// the job by 2 s — attempt untouched — and runs nothing; a granted call
// records `tool.dequeued` with its wait, holds the slot through the run and
// releases it on completion or failure. Host mode — no slots port, or a tool
// that needs none — is byte-identical to the R14 path. Both drivers.
import { expect, test } from "vitest";
import { fold } from "@fabric/core";
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

  test("each wait and each position change records its own tool.queued fact — 1 -> 2 -> 1 keeps all three", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const slots = sandboxSlots(store, { cap: 1 });
    expect((await slots.acquire({ workspaceId: WORKSPACE, callKey: "run:zz:hold", priority: 1, now: 0 })).granted).toBe(true);

    const streamId = "run:t16-pos";
    const tools = new SlotTools({ sh: { effect: "read", needsSlot: true, runs: [{ ok: true, result: "listing" }] } });
    await seed(store, streamId, [runCreated(streamId), toolCalled(streamId, "c1", "read")]);
    await enqueueToolExec(store, queue, streamId, "c1");

    const pass = async (worker: string, now: number) => {
      const lease = await queue.claim(worker, ["tool.exec"], now);
      if (lease === null) throw new Error("expected a claimable tool.exec job in the test setup");
      expect(lease.key).toBe(`${streamId}:c1`);
      await handleToolExecJob(lease, { store, queue, tools, slots, now: () => now });
    };

    // position 1: the slot is held elsewhere
    await pass("worker-1", 5_000);
    // a chat turn's call ranks ahead, pushing this one to position 2
    const chatTurn = await slots.acquire({ workspaceId: WORKSPACE, callKey: "session:s:cx", priority: 0, now: 5_500 });
    expect(chatTurn.granted).toBe(false);
    await pass("worker-2", 7_000);
    // the chat turn goes away: back to position 1
    await slots.release("session:s:cx");
    await pass("worker-3", 9_000);
    // Observing that same position again must still append nothing.
    await pass("worker-4", 11_000);

    const events = await store.readStream(streamId, { workspaceId: WORKSPACE });
    const queued = of(events, "tool.queued");
    // every transition is its own fact — the return to 1 is not deduplicated
    // into the first wait's fact, and no fact is a repeat of the current state
    expect(queued.map((fact) => fact.payload)).toEqual([
      { callId: "c1", reason: "sandbox_slot", position: 1 },
      { callId: "c1", reason: "sandbox_slot", position: 2 },
      { callId: "c1", reason: "sandbox_slot", position: 1 },
    ]);
    expect(queued.map((fact) => fact.causation)).toEqual([
      `${streamId}:c1:tool.queued:1`,
      `${streamId}:c1:tool.queued:2`,
      `${streamId}:c1:tool.queued:3`,
    ]);
    // the fold still reports the call as waiting — the watchdog stands down
    expect(fold(events).queuedCalls).toEqual(["c1"]);
    expect(tools.count("sh")).toBe(0);
  });

  test("a position change after a legacy queued fact gets a distinct transition identity", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const slots = sandboxSlots(store, { cap: 1 });
    await slots.acquire({ workspaceId: WORKSPACE, callKey: "run:zz:hold", priority: 1, now: 0 });
    const streamId = "run:t16-legacy";
    const key = `${streamId}:c1`;
    // Before the fix, causation's numeric suffix was the position. One fact
    // at position 2 must not collide with the next transition's ordinal 2.
    await seed(store, streamId, [runCreated(streamId), toolCalled(streamId, "c1", "read"), {
      type: "tool.queued",
      actor: "tool.exec",
      payload: { callId: "c1", reason: "sandbox_slot", position: 2 },
      causation: `${key}:tool.queued:2`,
    }]);
    await enqueueToolExec(store, queue, streamId, "c1");
    const tools = new SlotTools({ sh: { effect: "read", needsSlot: true, runs: [{ ok: true }] } });
    const lease = await claimToolExec(queue, streamId, "c1", 5_000);
    await handleToolExecJob(lease, { store, queue, tools, slots, now: () => 5_000 });

    const queued = of(await store.readStream(streamId, { workspaceId: WORKSPACE }), "tool.queued");
    expect(queued.map((event) => event.payload)).toEqual([
      { callId: "c1", reason: "sandbox_slot", position: 2 },
      { callId: "c1", reason: "sandbox_slot", position: 1 },
    ]);
    expect(new Set(queued.map((event) => event.causation)).size).toBe(2);
    expect(tools.count("sh")).toBe(0);
    expect((await queue.get(lease.jobId))?.status).toBe("pending");
  });

  test("a call that dequeues, fails retryably and waits again records its second wait", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const slots = sandboxSlots(store, { cap: 1 });
    expect((await slots.acquire({ workspaceId: WORKSPACE, callKey: "run:zz:hold", priority: 1, now: 0 })).granted).toBe(true);

    const streamId = "run:t16-again";
    const tools = new SlotTools({ sh: { effect: "read", needsSlot: true, throws: new Error("transient tool failure") } });
    await seed(store, streamId, [runCreated(streamId), toolCalled(streamId, "c1", "read")]);
    await enqueueToolExec(store, queue, streamId, "c1");

    // first pass: refused, the wait is a fact, the job defers
    const lease1 = await claimToolExec(queue, streamId, "c1", 5_000);
    await handleToolExecJob(lease1, { store, queue, tools, slots, now: () => 5_000 });
    expect(tools.count("sh")).toBe(0);

    // the holder finishes; the retry dequeues with its wait, then the tool
    // fails — a job-level failure, so the lease fails retryably
    await slots.release("run:zz:hold");
    const lease2 = await queue.claim("worker-2", ["tool.exec"], 7_000);
    expect(lease2?.key).toBe(`${streamId}:c1`);
    await expect(
      handleToolExecJob(lease2!, { store, queue, tools, slots, now: () => 7_000 })
    ).rejects.toThrow("transient tool failure");
    expect((await queue.get(lease2!.jobId))?.lastError).toBe("transient tool failure");

    // another call takes the freed slot, so the retry (attempt 2) waits again
    expect(
      (await slots.acquire({ workspaceId: WORKSPACE, callKey: "run:zz:hold2", priority: 1, now: 36_000 })).granted
    ).toBe(true);
    const lease3 = await queue.claim("worker-3", ["tool.exec"], 37_000);
    expect(lease3?.attempt).toBe(2);
    await handleToolExecJob(lease3!, { store, queue, tools, slots, now: () => 37_000 });

    const events = await store.readStream(streamId, { workspaceId: WORKSPACE });
    // the second waiting period is a fact of its own, not a deduplicate of
    // the first — the fold reports the call waiting, matching its slot row
    const queued = of(events, "tool.queued");
    expect(queued.map((fact) => fact.payload)).toEqual([
      { callId: "c1", reason: "sandbox_slot", position: 1 },
      { callId: "c1", reason: "sandbox_slot", position: 1 },
    ]);
    expect(queued.map((fact) => fact.causation)).toEqual([
      `${streamId}:c1:tool.queued:1`,
      `${streamId}:c1:tool.queued:2`,
    ]);
    const dequeued = of(events, "tool.dequeued");
    expect(dequeued).toHaveLength(1);
    expect(dequeued[0]!.payload).toEqual({ callId: "c1", waitedMs: 2_000 });
    expect(fold(events).queuedCalls).toEqual(["c1"]);
    expect(tools.count("sh")).toBe(1); // it ran once, on the granted pass

    // Repeated observations during this second wait append nothing too.
    const lease4 = await claimToolExec(queue, streamId, "c1", 39_000);
    await handleToolExecJob(lease4, { store, queue, tools, slots, now: () => 39_000 });
    expect(of(await store.readStream(streamId, { workspaceId: WORKSPACE }), "tool.queued")).toHaveLength(2);

    // A second grant must record a second dequeue, or the fold will keep
    // reporting a live wait after the retry's tool failure.
    await slots.release("run:zz:hold2");
    const lease5 = await claimToolExec(queue, streamId, "c1", 41_000);
    await expect(
      handleToolExecJob(lease5, { store, queue, tools, slots, now: () => 41_000 })
    ).rejects.toThrow("transient tool failure");
    const afterRetry = await store.readStream(streamId, { workspaceId: WORKSPACE });
    const dequeues = of(afterRetry, "tool.dequeued");
    expect(dequeues.map((event) => event.payload)).toEqual([
      { callId: "c1", waitedMs: 2_000 },
      { callId: "c1", waitedMs: 4_000 },
    ]);
    expect(new Set(dequeues.map((event) => event.causation)).size).toBe(2);
    expect(fold(afterRetry).queuedCalls).toEqual([]);
    expect(tools.count("sh")).toBe(2);
    expect((await slots.acquire({ workspaceId: WORKSPACE, callKey: "run:zz:probe", priority: 1, now: 41_100 })).granted).toBe(true);
  });

  test("a failure recording the dequeue releases the granted slot and fails the job", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const slots = sandboxSlots(store, { cap: 1 });
    expect((await slots.acquire({ workspaceId: WORKSPACE, callKey: "run:zz:hold", priority: 1, now: 0 })).granted).toBe(true);

    const streamId = "run:t16-gate";
    const tools = new SlotTools({ sh: { effect: "read", needsSlot: true, runs: [{ ok: true, result: "listing" }] } });
    await seed(store, streamId, [runCreated(streamId), toolCalled(streamId, "c1", "read")]);
    await enqueueToolExec(store, queue, streamId, "c1");

    // first pass: refused, the job defers past the wait
    const lease1 = await claimToolExec(queue, streamId, "c1", 5_000);
    await handleToolExecJob(lease1, { store, queue, tools, slots, now: () => 5_000 });
    await slots.release("run:zz:hold");

    // second pass: the slot is granted, but the store drops the dequeue fact —
    // the grant must not outlive the failure, and the job must fail retryably
    const lease2 = await queue.claim("worker-2", ["tool.exec"], 7_000);
    expect(lease2?.key).toBe(`${streamId}:c1`);
    const failingDequeueStore: RuntimeStore = {
      ...store,
      transaction: (run) =>
        store.transaction((tx) =>
          run({
            onCommit: tx.onCommit.bind(tx),
            query: (sql: string, params: readonly unknown[] = []) => {
              if (sql.includes("insert into events") && params[4] === "tool.dequeued") {
                throw new Error("dequeue append unavailable");
              }
              return tx.query(sql, params);
            },
          })
        ),
    };
    await expect(
      handleToolExecJob(lease2!, { store: failingDequeueStore, queue, tools, slots, now: () => 7_000 })
    ).rejects.toThrow("dequeue append unavailable");

    // the acquired slot went back: a fresh call walks straight in
    expect(
      (await slots.acquire({ workspaceId: WORKSPACE, callKey: "run:zz:probe", priority: 1, now: 7_100 })).granted
    ).toBe(true);
    // and the job followed the normal failure path, not a stuck lease
    const job = await queue.get(lease2!.jobId);
    expect(job?.status).toBe("pending");
    expect(job?.runAt).toBe(37_000); // tool.exec's 30 s backoff from the 7 s clock
    expect(job?.lastError).toBe("dequeue append unavailable");
    // nothing ran and nothing recorded
    expect(tools.count("sh")).toBe(0);
    const events = await store.readStream(streamId, { workspaceId: WORKSPACE });
    expect(of(events, "tool.dequeued")).toHaveLength(0);
    expect(of(events, "tool.completed")).toHaveLength(0);
    expect(fold(events).queuedCalls).toEqual(["c1"]);

    // After the transient append fault clears, the same call can finish.
    await slots.release("run:zz:probe");
    const retry = await claimToolExec(queue, streamId, "c1", 37_000);
    await handleToolExecJob(retry, { store, queue, tools, slots, now: () => 37_000 });
    const recovered = await store.readStream(streamId, { workspaceId: WORKSPACE });
    expect(of(recovered, "tool.dequeued")).toHaveLength(1);
    expect(of(recovered, "tool.completed")).toHaveLength(1);
    expect(fold(recovered).queuedCalls).toEqual([]);
    expect((await queue.get(retry.jobId))?.status).toBe("completed");
    expect(tools.count("sh")).toBe(1);
  });

  test("a queued rerunnable call that finishes through recovery releases its slot registration", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const slots = sandboxSlots(store, { cap: 1 });
    // the slot is held elsewhere: the call queues
    expect((await slots.acquire({ workspaceId: WORKSPACE, callKey: "run:zz:hold", priority: 1, now: 0 })).granted).toBe(
      true
    );

    const streamId = "run:t16-rec";
    const tools = new SlotTools({
      sh: { effect: "rerunnable", needsSlot: true, runs: [{ ok: true, result: "ran" }] },
    });
    await seed(store, streamId, [runCreated(streamId), toolCalled(streamId, "c1", "rerunnable")]);
    await enqueueToolExec(store, queue, streamId, "c1");

    // attempt 1: refused — the wait is a fact, the job defers, nothing runs
    const lease1 = await claimToolExec(queue, streamId, "c1", 0);
    await handleToolExecJob(lease1, { store, queue, tools, slots, now: () => 1_000 });
    expect(of(await store.readStream(streamId, { workspaceId: WORKSPACE }), "tool.queued")).toHaveLength(1);
    expect(tools.count("sh")).toBe(0);

    // the job comes back and fails retryably once: the next claim is attempt 2
    const lease2 = await queue.claim("worker-2", ["tool.exec"], 3_000);
    expect(lease2?.attempt).toBe(1);
    await queue.fail(lease2!, new Error("store hiccup"), { retryable: true }, 3_000);
    const lease3 = await queue.claim("worker-3", ["tool.exec"], 33_000);
    expect(lease3?.attempt).toBe(2);

    // attempt 2 of a rerunnable call recovers instead of running: the
    // interruption is the call's terminal fact, the lease completes
    await handleToolExecJob(lease3!, { store, queue, tools, slots, now: () => 33_500 });
    expect(tools.count("sh")).toBe(0);
    const events = await store.readStream(streamId, { workspaceId: WORKSPACE });
    expect(of(events, "tool.interrupted")).toHaveLength(1);
    expect((await queue.get(lease3!.jobId))?.status).toBe("completed");

    // the recovery took the call's registration with it: with the holder gone,
    // a fresh call walks straight in — no phantom waiter ranks ahead of it
    await slots.release("run:zz:hold");
    expect(
      (await slots.acquire({ workspaceId: WORKSPACE, callKey: "run:zz:probe", priority: 1, now: 34_000 })).granted
    ).toBe(true);
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
