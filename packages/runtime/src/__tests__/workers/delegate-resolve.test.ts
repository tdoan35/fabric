// ANY-40 R9c — W12/W12a: the `delegate.resolve` job. A finished child is
// reported to its parent by applying R4's `resolveDelegation`: the awaited
// call completes with `tool.completed` carrying the child's result and spend,
// a background one parks `delegation.result` as the parent's pending input —
// the reservation released and the cost folded in by the fact itself. The
// parent's next `decide` is queued with the append; a re-run of the job
// appends nothing twice. Both drivers, per the house describeDrivers seam.
import { expect, test } from "vitest";
import { append, type EventInput, type RuntimeStore } from "../../index";
import { MemoryQueue } from "../../queue/memory";
import type { Queue, QueueJobInput } from "../../queue/types";
import { describeDrivers } from "../../testing/drivers";
import { handleDecideJob } from "../../workers/decide";
import { handleDelegateResolveJob } from "../../workers/delegate-resolve";

const WORKSPACE = "ws-r9c-resolve";

// -- fixtures -------------------------------------------------------------------

const runCreated = (definition: Record<string, unknown>, parent: unknown): EventInput => ({
  type: "run.created",
  actor: "api",
  payload: { definition, engineVersion: "v1", brief: "", grants: [], budgets: {}, parent },
});

const delegateArgs = (mode: string) => ({ agentId: "sub", mode, brief: "find it", budgetUsd: 2 });

const llmCompleted = (
  turn: number,
  callNo: number,
  text: string,
  toolCalls: readonly Record<string, unknown>[],
  costUsd: number
): EventInput => ({
  type: "llm.completed",
  actor: "llm.call",
  payload: {
    turn,
    callNo,
    text,
    toolCalls,
    usage: { inputTokens: 1, outputTokens: 1, costUsd },
    finishReason: toolCalls.length > 0 ? "tool-calls" : "stop",
    model: "m1",
  },
});

async function seed(store: RuntimeStore, streamId: string, events: readonly EventInput[]) {
  await store.transaction((tx) => append(tx, WORKSPACE, [{ streamId, events }]));
}

async function enqueue(store: RuntimeStore, queue: MemoryQueue, job: QueueJobInput) {
  await store.transaction((tx) => queue.enqueue(tx, job));
}

const eventsOn = (store: RuntimeStore, streamId: string) =>
  store.readStream(streamId, { workspaceId: WORKSPACE });

const of = (events: Awaited<ReturnType<typeof eventsOn>>, type: string) =>
  events.filter((event) => event.type === type);

const delegateCall = (callId: string, args: Record<string, unknown>): EventInput => ({
  type: "tool.call",
  actor: "decide",
  payload: { tool: "delegate", summary: "", callId, args, effect: "idempotent" },
});

const childStreamOf = (childId: string) => `run:${childId}`;
const resolveKeyOf = (childId: string) => `run:${childId}:resolve`;

describeDrivers("runtime delegate.resolve worker (ANY-40 R9c)", (h) => {
  test("W12 await: the parent's tool.completed carries the child's result, its decide is queued, a re-run appends once", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const parent = "session:p1";
    const childId = "d1234567";
    const childStream = childStreamOf(childId);
    const key = resolveKeyOf(childId);
    const args = delegateArgs("await");

    await seed(store, parent, [
      runCreated({ systemPrompt: "P", tools: ["delegate"] }, null),
      llmCompleted(1, 1, "", [{ name: "delegate", id: "c1", args }], 0.1),
      delegateCall("c1", args),
    ]);
    await seed(store, childStream, [
      runCreated({ systemPrompt: "S", tools: [] }, { sessionId: "p1", callId: "c1" }),
      llmCompleted(1, 1, "child done", [], 0.5),
      { type: "run.finished", actor: "decide", payload: { result: "child done", costUsd: 0.5 } },
    ]);
    await enqueue(store, queue, { type: "delegate.resolve", key, streamId: childStream, workspaceId: WORKSPACE });

    const lease = await queue.claim("worker-1", ["delegate.resolve"], 0);
    expect(lease?.attempt).toBe(1);
    await handleDelegateResolveJob(lease!, { store, queue });

    const completed = of(await eventsOn(store, parent), "tool.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]!.causation).toBe(key);
    expect(completed[0]!.payload).toMatchObject({
      callId: "c1",
      ok: true,
      result: { result: "child done", costUsd: 0.5 },
    });

    // the parent gained a fact: its loop continues — exactly one decide queued
    const decide = await queue.claim("worker-2", ["decide"], 1);
    expect(decide?.streamId).toBe(parent);
    expect(await queue.claim("worker-3", ["decide"], 1)).toBeNull();

    // at-least-once: the same job run again appends nothing twice
    await handleDelegateResolveJob(lease!, { store, queue });
    expect(of(await eventsOn(store, parent), "tool.completed")).toHaveLength(1);
  });

  test("W12a background: delegation.result parks on the parent, whose next decide starts a turn", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const parent = "session:p2";
    const childId = "d7654321";
    const childStream = childStreamOf(childId);
    const key = resolveKeyOf(childId);
    const args = delegateArgs("background");

    // the parent delegated in the background, took the ack, and its turn ended:
    // the session is idle when the child finishes
    await seed(store, parent, [
      runCreated({ systemPrompt: "P", tools: ["delegate"] }, null),
      llmCompleted(1, 1, "", [{ name: "delegate", id: "c1", args }], 0.1),
      delegateCall("c1", args),
      {
        type: "tool.completed",
        actor: "decide",
        payload: { callId: "c1", ok: true, result: { runId: childId } },
      },
      llmCompleted(1, 2, "working on it", [], 0.05),
    ]);
    await seed(store, childStream, [
      runCreated({ systemPrompt: "S", tools: [] }, { sessionId: "p2", callId: "c1" }),
      llmCompleted(1, 1, "bg done", [], 0.4),
      { type: "run.finished", actor: "decide", payload: { result: "bg done", costUsd: 0.4 } },
    ]);
    await enqueue(store, queue, { type: "delegate.resolve", key, streamId: childStream, workspaceId: WORKSPACE });

    const lease = await queue.claim("worker-1", ["delegate.resolve"], 0);
    await handleDelegateResolveJob(lease!, { store, queue });

    const results = of(await eventsOn(store, parent), "delegation.result");
    expect(results).toHaveLength(1);
    expect(results[0]!.causation).toBe(key);
    expect(results[0]!.payload).toMatchObject({
      childRunId: childId,
      outcome: "done",
      output: "bg done",
      costUsd: 0.4,
    });

    // the parked input re-opens the idle session: the next decide starts a turn
    const decide = await queue.claim("worker-2", ["decide"], 1);
    expect(decide?.streamId).toBe(parent);
    await handleDecideJob(decide!, { store, queue });
    const requested = of(await eventsOn(store, parent), "llm.requested");
    expect(requested).toHaveLength(1);
  });
});
