// ANY-35 R9a — W2..W7: the `ll.call` job. The conversation is rebuilt from
// facts (the definition snapshot's system prompt, the latest compaction
// summary, then each later input, completion and result), the model is called
// once with execute-less tools, the result lands as `llm.completed` next to a
// `context.snapshot`, compaction precedes the call, 429s retry through the
// queue without a `llm.failed`, non-retryable errors record `llm.failed`, and a
// retry after the result was recorded appends nothing twice. Both drivers.
import { expect, test } from "vitest";
import { append, type EventInput } from "../../index";
import { MemoryQueue } from "../../queue/memory";
import type { RuntimeStore } from "../../store/types";
import { describeDrivers } from "../../testing/drivers";
import { FakeModel } from "../../testing/fake-model";
import { handleLlmCallJob } from "../../workers/ll-call";

const WORKSPACE = "ws-r9a";
const STREAM = "run:r2";
const CALL_KEY = "run:r2:1:llm:1";

// -- stream fixtures -----------------------------------------------------------

const runCreated = (definition: Record<string, unknown>): EventInput => ({
  type: "run.created",
  actor: "api",
  payload: { definition, engineVersion: "v1", brief: "", grants: [], budgets: {}, parent: null },
});

const requested = (turn: number, callNo: number): EventInput => ({
  type: "llm.requested",
  actor: "decide",
  payload: { turn, callNo, model: "m1", params: {}, snapshotId: null },
});

const assistantCompleted = (
  turn: number,
  callNo: number,
  text: string,
  toolCalls: record[]
): EventInput => ({
  type: "llm.completed",
  actor: "llm.call",
  causation: `run:r2:${turn}:llm:${callNo}`,
  payload: {
    turn,
    callNo,
    text,
    toolCalls,
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
    finishReason: "stop",
    model: "m1",
  },
});

const toolCompleted = (callId: string, result: string): EventInput => ({
  type: "tool.completed",
  actor: "tool.exec",
  payload: { callId, ok: true, result },
});

type record = Record<string, unknown>; // local alias, used by the fixtures below

const messageReceived = (text: string, id: string): EventInput => ({
  type: "message.received",
  actor: "user",
  payload: { text, attachments: [], surface: "app", sender: "tester", platformMessageId: id },
});

const compacted = (upToSeq: number, summary: string): EventInput => ({
  type: "context.compacted",
  actor: "llm.call",
  payload: { upToSeq, summary },
});

/** W2's stream: a run told to speak, one tool in the allowlist. */
const W2_EVENTS = [
  runCreated({ systemPrompt: "SYS", tools: ["lookup"], model: "m1", maxSteps: 4 }),
  messageReceived("what is X?", "pm-1"),
  requested(1, 1),
];

const W2_RESULT = {
  text: "X is Y.",
  toolCalls: [] as record[],
  usage: { inputTokens: 12, outputTokens: 3, costUsd: 0.5 },
  finishReason: "stop",
};

async function seed(store: RuntimeStore, events: readonly EventInput[]) {
  await store.transaction((tx) => append(tx, WORKSPACE, [{ streamId: STREAM, events }]));
}

async function claimedLlmCall(store: RuntimeStore, queue: MemoryQueue, now = 0) {
  await store.transaction((tx) =>
    queue.enqueue(tx, { type: "llm.call", key: CALL_KEY, streamId: STREAM, workspaceId: WORKSPACE })
  );
  const lease = await queue.claim("worker-1", ["llm.call"], now);
  if (lease === null) throw new Error("expected a claimable ll.call job in the test setup");
  return lease;
}

async function streamEvents(store: RuntimeStore) {
  return store.readStream(STREAM, { workspaceId: WORKSPACE });
}

const of = (events: Awaited<ReturnType<typeof streamEvents>>, type: string) =>
  events.filter((event) => event.type === type);

describeDrivers("runtime ll.call worker (ANY-35 R9a)", (h) => {
  test("W2 one model call with execute-less tools; llm.completed and context.snapshot appended", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const model = new FakeModel([W2_RESULT]);
    await seed(store, W2_EVENTS);
    const lease = await claimedLlmCall(store, queue);

    await handleLlmCallJob(lease, { store, queue, model });

    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.system).toBe("SYS");
    expect(model.calls[0]!.tools).toEqual([{ name: "lookup" }]);
    for (const tool of model.calls[0]!.tools) expect("execute" in tool).toBe(false);
    // the rebuilt conversation: the user input, nothing else
    expect(model.calls[0]!.messages).toEqual([
      { role: "user", text: "what is X?" },
    ]);

    const events = await streamEvents(store);
    const completed = of(events, "llm.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]!.payload).toEqual({
      turn: 1,
      callNo: 1,
      text: "X is Y.",
      toolCalls: [],
      usage: { inputTokens: 12, outputTokens: 3, costUsd: 0.5 },
      finishReason: "stop",
      model: "m1",
    });
    expect(completed[0]!.causation).toBe(CALL_KEY); // the retried job's no-op hinge

    const snapshots = of(events, "context.snapshot");
    expect(snapshots).toHaveLength(1);
    expect(typeof (snapshots[0]!.payload as { snapshotId: string }).snapshotId).toBe("string");

    expect((await queue.get(lease.jobId))?.status).toBe("completed");
  });

  test("W3 the rebuilt conversation is [system, compaction summary, facts after the compaction]", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const model = new FakeModel([W2_RESULT]);
    await seed(store, [
      runCreated({ systemPrompt: "SYS", tools: ["lookup"], model: "m1" }),
      messageReceived("what is X?", "pm-4"), // seq 2: pre-compaction, covered by the summary
      requested(1, 1), // 3
      assistantCompleted(1, 1, "Let me look.", [{ id: "c1", name: "lookup", args: { q: "X" } }]), // 4
      toolCompleted("c1", "X is Y"), // 5
      requested(1, 2), // 6
      assistantCompleted(1, 2, "X is Y.", []), // 7
      { type: "agent.message", actor: "decide", payload: { text: "X is Y." } }, // 8, telemetry
      messageReceived("and Z?", "pm-5"), // 9
      compacted(10, "Earlier: what is X; X is Y."), // 10: the compaction
      requested(2, 1), // 11
      assistantCompleted(2, 1, "Searching Z.", [{ id: "c2", name: "lookup", args: { q: "Z" } }]), // 12
      toolCompleted("c2", "Z is W"), // 13
      assistantCompleted(2, 2, "Z is W.", []), // 14
      requested(2, 3), // 15: the call this job runs
    ]);
    const lease = await claimedLlmCallForCall(store, queue, 2, 3);

    await handleLlmCallJob(lease, { store, queue, model });

    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.system).toBe("SYS");
    expect(model.calls[0]!.messages).toEqual([
      { role: "user", text: "Earlier: what is X; X is Y." },
      { role: "assistant", text: "Searching Z.", toolCalls: [{ id: "c2", name: "lookup", args: { q: "Z" } }] },
      { role: "tool", toolCallId: "c2", text: "Z is W" },
      { role: "assistant", text: "Z is W.", toolCalls: [] },
    ]);
  });

  test("W4 over the token limit, context.compacted precedes the call and the context is shorter", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const model = new FakeModel([W2_RESULT]);
    const longText = "the quick brown fox jumps over the lazy dog ".repeat(3); // > 60 chars
    await seed(store, [
      runCreated({ systemPrompt: "SYS", tools: [], model: "m1" }),
      messageReceived(longText, "pm-6"), // seq 2
      requested(1, 1), // 3
    ]);
    const lease = await claimedLlmCall(store, queue);

    await handleLlmCallJob(lease, {
      store,
      queue,
      model,
      compaction: { tokenLimit: 60, countTokens: (text) => text.length },
    });

    const events = await streamEvents(store);
    const compactions = of(events, "context.compacted");
    expect(compactions).toHaveLength(1);
    const compaction = compactions[0]!.payload as { upToSeq: number; summary: string };
    expect(compaction.upToSeq).toBe(2); // every fact the summary replaces

    // the compacted fact precedes the completion, and the model saw the
    // summary in the conversation's front, not the pre-compaction history
    const completed = of(events, "llm.completed");
    expect(completed).toHaveLength(1);
    expect(compactions[0]!.seq).toBeLessThan(completed[0]!.seq);

    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.messages).toHaveLength(1);
    expect(model.calls[0]!.messages[0]).toEqual({ role: "user", text: compaction.summary });
    expect(model.calls[0]!.messages[0]!.text).not.toBe(longText); // shortened
  });

  test("W5 a 429 with retryAfter 30 retries no earlier than 30 s later; no llm.failed", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const clock = { now: 1_000 };
    const model = new FakeModel([
      { message: "rate limited", status: 429, retryAfter: 30, retryable: true },
    ]);
    await seed(store, W2_EVENTS);
    const lease = await claimedLlmCall(store, queue, clock.now);

    await handleLlmCallJob(lease, { store, queue, model, now: () => clock.now });

    // nothing recorded: the tx rolled back, the queue owns the retry
    const events = await streamEvents(store);
    expect(of(events, "llm.failed")).toHaveLength(0);
    expect(of(events, "llm.completed")).toHaveLength(0);
    expect(of(events, "context.snapshot")).toHaveLength(0);

    const job = await queue.get(lease.jobId);
    expect(job?.status).toBe("pending");
    expect(job!.runAt).toBeGreaterThanOrEqual(clock.now + 30_000);
    expect(await queue.claim("worker-2", ["llm.call"], clock.now + 29_999)).toBeNull();

    // and the retry does happen, once the clock passes the backoff
    const retried = await queue.claim("worker-2", ["llm.call"], clock.now + 600_000);
    expect(retried?.jobId).toBe(lease.jobId);
  });

  test("W6 a non-retryable error records llm.failed { retryable: false } and completes", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const model = new FakeModel([{ message: "context too long", retryable: false }]);
    await seed(store, W2_EVENTS);
    const lease = await claimedLlmCall(store, queue);

    await handleLlmCallJob(lease, { store, queue, model });

    const events = await streamEvents(store);
    const failed = of(events, "llm.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({ turn: 1, callNo: 1, error: "context too long", retryable: false });
    expect(failed[0]!.causation).toBe(CALL_KEY);
    expect((await queue.get(lease.jobId))?.status).toBe("completed");
  });

  test("W7 the job running twice after the result was recorded appends one llm.completed", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const model = new FakeModel([W2_RESULT, W2_RESULT]);
    await seed(store, W2_EVENTS);
    const lease = await claimedLlmCall(store, queue);

    await handleLlmCallJob(lease, { store, queue, model });
    await handleLlmCallJob(lease, { store, queue, model }); // the at-least-once re-run

    expect(of(await streamEvents(store), "llm.completed")).toHaveLength(1);
    expect(model.calls).toHaveLength(1); // the re-run saw the recorded result and skipped the call
  });
});

/** Claim the ll.call job of a later call: the key encodes turn and call. */
async function claimedLlmCallForCall(
  store: RuntimeStore,
  queue: MemoryQueue,
  turn: number,
  callNo: number
) {
  const key = `run:r2:${turn}:llm:${callNo}`;
  await store.transaction((tx) =>
    queue.enqueue(tx, { type: "llm.call", key, streamId: STREAM, workspaceId: WORKSPACE })
  );
  const lease = await queue.claim("worker-1", ["llm.call"], 0);
  if (lease === null) throw new Error(`expected a claimable ${key} job in the test setup`);
  return lease;
}
