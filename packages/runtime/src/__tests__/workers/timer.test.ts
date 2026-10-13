// ANY-36 R10 — the `run.timer` handler, end to end (RUNTIME §4, §7). A timer
// job is a decide scheduled with `run_at`: the handler folds the stream, asks
// the pure core what the firing means, appends the decision and queues its
// jobs — the stall watchdog's second check, the re-queued lost work — in one
// transaction, then completes the lease. The re-arm itself is the decide path:
// every handleDecideJob on a running stream arms `<stream>:timer:watchdog:h<head>`
// anew, so each fact moves the live watchdog's runAt forward and a stale
// timer's firing is a no-op.
import { expect, test } from "vitest";
import { append, type EventInput, type RuntimeStore } from "../../index";
import { MemoryQueue } from "../../queue/memory";
import { FakeTools } from "../../testing/fake-tools";
import { describeDrivers } from "../../testing/drivers";
import { handleDecideJob } from "../../workers/decide";
import { handleToolExecJob } from "../../workers/tool-exec";
import { handleTimerJob } from "../../workers/timer";

const WORKSPACE = "ws-r10-timer";
const STALL = 30_000;

// -- fixtures -------------------------------------------------------------------

const runCreated = (definition: Record<string, unknown>): EventInput => ({
  type: "run.created",
  actor: "api",
  payload: { definition, engineVersion: "v1", brief: "", grants: [], budgets: {}, parent: null },
});

const runStarted: EventInput = { type: "run.started", actor: "api", payload: { objective: "x" } };

const llmRequested = (callNo: number): EventInput => ({
  type: "llm.requested",
  actor: "decide",
  payload: { turn: 1, callNo, model: "m1", params: {}, snapshotId: null },
});

const llmCompleted = (callNo: number, toolCalls: readonly Record<string, unknown>[]): EventInput => ({
  type: "llm.completed",
  actor: "llm.call",
  payload: {
    turn: 1,
    callNo,
    text: "",
    toolCalls,
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.1 },
    finishReason: toolCalls.length > 0 ? "tool-calls" : "stop",
    model: "m1",
  },
});

const toolCall = (callId: string): EventInput => ({
  type: "tool.call",
  actor: "decide",
  payload: { tool: "shell", summary: "", callId, args: {}, effect: "read" },
});

async function seed(store: RuntimeStore, streamId: string, events: readonly EventInput[]) {
  await store.transaction((tx) => append(tx, WORKSPACE, [{ streamId, events }]));
}

async function enqueue(
  store: RuntimeStore,
  queue: MemoryQueue,
  job: { type: string; key: string; streamId: string; runAt?: number }
) {
  await store.transaction((tx) => queue.enqueue(tx, { ...job, workspaceId: WORKSPACE }));
}

/** One decide pass at the given instant; the handler's clock is injected. */
async function runDecide(store: RuntimeStore, queue: MemoryQueue, streamId: string, now: number) {
  await enqueue(store, queue, {
    type: "decide",
    key: `decide:${streamId}:x${now}:${Math.random().toString(36).slice(2, 6)}`,
    streamId,
  });
  const lease = await queue.claim("worker-decide", ["decide"], now);
  expect(lease?.type).toBe("decide");
  await handleDecideJob(lease!, { store, queue, now: () => now });
}

const eventsOn = (store: RuntimeStore, streamId: string) =>
  store.readStream(streamId, { workspaceId: WORKSPACE });

const of = async (store: RuntimeStore, streamId: string, type: string) =>
  (await eventsOn(store, streamId)).filter((event) => event.type === type);

const head = async (store: RuntimeStore, streamId: string) => (await eventsOn(store, streamId)).length;

describeDrivers("runtime run.timer worker (ANY-36 R10)", (h) => {
  test("T10: each new fact moves the watchdog's runAt forward; the earlier firing is a no-op", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const stream = "session:wd1";

    await seed(store, stream, [
      runCreated({ tools: [], stallAfterMs: STALL }),
      runStarted,
      llmRequested(1),
    ]);
    await runDecide(store, queue, stream, 1_000);

    // the arm: one watchdog on the head the decide saw (3 events), one window out
    const first = await queue.claim("probe-a", ["run.timer"], 1_000 + STALL);
    expect(first?.key).toBe(`${stream}:timer:watchdog:h3`);
    expect((await queue.get(first!.jobId))?.runAt).toBe(1_000 + STALL);

    // a new fact: the next decide arms a later watchdog
    await seed(store, stream, [toolCall("c1")]);
    await runDecide(store, queue, stream, 2_000);
    const second = await queue.claim("probe-b", ["run.timer"], 2_000 + STALL);
    expect(second?.key).toBe(`${stream}:timer:watchdog:h4`);
    expect((await queue.get(second!.jobId))?.runAt).toBe(2_000 + STALL);

    // the earlier timer fires: progress happened since its head, so nothing
    const before = await head(store, stream);
    await handleTimerJob(first!, { store, queue, now: () => 1_000 + STALL });
    expect(await head(store, stream)).toBe(before);
    // and no second check was armed behind it: past h4's runAt only h4 remains
    expect(await queue.claim("probe-c", ["run.timer"], 5 * STALL)).toBeNull();
  });

  test("T11: the first stalled firing re-queues the lost job; progress clears the stall", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const stream = "session:wd2";
    const tools = new FakeTools({ shell: { effect: "read", runs: [{ ok: true, result: "pong" }] } });

    await seed(store, stream, [
      runCreated({ tools: ["shell"], stallAfterMs: STALL }),
      runStarted,
      llmRequested(1),
      llmCompleted(1, [{ id: "c1", name: "shell", args: {} }]),
      // the call is open and its tool.exec job is lost: the worker died before claiming
      toolCall("c1"),
    ]);

    // the watchdog armed at head 5 fires with no progress
    await enqueue(store, queue, { type: "run.timer", key: `${stream}:timer:watchdog:h5`, streamId: stream });
    const lease = await queue.claim("worker-timer", ["run.timer"], 100_000);
    expect(lease?.key).toBe(`${stream}:timer:watchdog:h5`);
    await handleTimerJob(lease!, { store, queue, now: () => 100_000 });

    // the lost job is back under its ordinary key, and the second check is armed
    const retry = await queue.claim("worker-tools", ["tool.exec"], 100_000);
    expect(retry?.key).toBe(`${stream}:c1`);
    const second = await queue.claim("probe", ["run.timer"], 100_000 + STALL);
    expect(second?.key).toBe(`${stream}:timer:watchdog:h5:s2`);
    expect((await queue.get(second!.jobId))?.runAt).toBe(100_000 + STALL);

    // the requeued work runs and the stream moves: the stall is cleared
    await handleToolExecJob(retry!, { store, queue, tools });
    expect(await of(store, stream, "tool.completed")).toHaveLength(1);
    const progressed = await head(store, stream);

    // the second check fires against the moved head: no blocking, no new jobs
    await handleTimerJob(second!, { store, queue, now: () => 100_000 + STALL });
    expect(await of(store, stream, "run.blocked")).toHaveLength(0);
    expect(await head(store, stream)).toBe(progressed);
  });

  test("T12: still stuck at the second firing, the run blocks with reason stall", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const stream = "session:wd3";

    await seed(store, stream, [
      runCreated({ tools: ["shell"], stallAfterMs: STALL }),
      runStarted,
      llmRequested(1),
      llmCompleted(1, [{ id: "c1", name: "shell", args: {} }]),
      toolCall("c1"),
    ]);
    await enqueue(store, queue, { type: "run.timer", key: `${stream}:timer:watchdog:h5`, streamId: stream });

    const first = await queue.claim("worker-timer", ["run.timer"], 100_000);
    await handleTimerJob(first!, { store, queue, now: () => 100_000 });

    // nothing runs the requeued job; the second check finds the same head
    const second = await queue.claim("worker-timer", ["run.timer"], 100_000 + STALL);
    expect(second?.key).toBe(`${stream}:timer:watchdog:h5:s2`);
    await handleTimerJob(second!, { store, queue, now: () => 100_000 + STALL });

    const blocked = await of(store, stream, "run.blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.payload).toEqual({ reason: "stall" });
    expect(blocked[0]!.causation).toBe(`${stream}:timer:watchdog:h5:s2:run.blocked:0`);
  });

  test("T13: the time budget blocks a still-running run at +timeS and spares a finished one", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const running = "run:b1";
    const finished = "run:b2";

    await seed(store, running, [
      runCreated({ tools: [], budget: { timeS: 60 } }),
      runStarted,
      llmRequested(1),
    ]);
    await seed(store, finished, [
      runCreated({ tools: [], budget: { timeS: 60 } }),
      runStarted,
      llmRequested(1),
    ]);

    // one decide per run arms the budget timer at now + timeS
    await runDecide(store, queue, running, 1_000);
    await runDecide(store, queue, finished, 1_000);
    // the second run finishes at +50 s, inside its budget
    await seed(store, finished, [
      llmCompleted(1, []),
      { type: "run.finished", actor: "decide", payload: { result: "done", costUsd: 0.1 } },
    ]);
    const budget = await queue.claim("probe-a", ["run.timer"], 61_000);
    expect(budget?.key).toBe(`${running}:timer:budget`);
    expect((await queue.get(budget!.jobId))?.runAt).toBe(61_000);

    // the running run blocks
    await handleTimerJob(budget!, { store, queue, now: () => 61_000 });
    const blocked = await of(store, running, "run.blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.payload).toEqual({ reason: "budget_time" });

    // the finished run's timer fires at +60 s and does nothing
    const finishedTimer = await queue.claim("probe-b", ["run.timer"], 61_000);
    expect(finishedTimer?.key).toBe(`${finished}:timer:budget`);
    await handleTimerJob(finishedTimer!, { store, queue, now: () => 61_000 });
    expect(await of(store, finished, "run.blocked")).toHaveLength(0);
    expect(await head(store, finished)).toBe(5);
  });
});
