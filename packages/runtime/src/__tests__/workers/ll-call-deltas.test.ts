// ANY-94 R16 — the `llm.call` worker accumulates the port's INCREMENTS (D2, D7):
// the sink `onDelta(delta, call)` receives the CUMULATIVE text of the current
// attempt — the worker concatenates the increments per call attempt, and a new
// attempt of the same key (a retry) starts from empty. Calls never bleed into
// each other. Both drivers, the R15 harness.
import { AssertionError } from "node:assert";
import { expect, test } from "vitest";
import { append, type EventInput } from "../../index";
import { MemoryQueue } from "../../queue/memory";
import type { Queue, QueueLease } from "../../queue/types";
import type { RuntimeStore } from "../../store/types";
import { describeDrivers } from "../../testing/drivers";
import { handleLlmCallJob } from "../../workers/ll-call";

const WORKSPACE = "ws-r16";
const STREAM = "run:r16";
const KEY = `${STREAM}:1:llm:1`;

const RESULT = (text: string) => ({
  text,
  toolCalls: [] as Record<string, unknown>[],
  usage: { inputTokens: 12, outputTokens: 3, costUsd: 0.5 },
  finishReason: "stop",
});

const runCreated = (definition: Record<string, unknown>): EventInput => ({
  type: "run.created",
  actor: "api",
  payload: { definition, engineVersion: "v1", brief: "", grants: [], budgets: {}, parent: null },
});

const messageReceived = (text: string, id: string): EventInput => ({
  type: "message.received",
  actor: "user",
  payload: { text, attachments: [], surface: "app", sender: "tester", platformMessageId: id },
});

const requested = (turn: number, callNo: number): EventInput => ({
  type: "llm.requested",
  actor: "decide",
  payload: { turn, callNo, model: "m1", params: {}, snapshotId: null },
});

/** One scripted `call`: optional increments, then a result or a raised error. */
interface Attempt {
  increments?: string[];
  result?: ReturnType<typeof RESULT>;
  error?: { message: string; status?: number; retryable: boolean };
}

/** The port the tests control: one scripted attempt per `call`, each emitting
 * raw text INCREMENTS through `onDelta` before resolving (or raising). */
class IncrementModel {
  readonly calls: { system: unknown; messages: unknown[]; tools: unknown[] }[] = [];
  #index = 0;
  #attempts: Attempt[];

  constructor(attempts: Attempt[]) {
    this.#attempts = attempts;
  }

  async call(request: {
    system: string;
    messages: readonly unknown[];
    tools: readonly unknown[];
    onDelta?: (delta: { text: string }) => void;
  }): Promise<ReturnType<typeof RESULT>> {
    this.calls.push({ system: request.system, messages: [...request.messages], tools: [...request.tools] });
    const attempt = this.#attempts[this.#index];
    this.#index += 1;
    if (attempt === undefined) throw new Error("IncrementModel: no scripted attempt left");
    for (const increment of attempt.increments ?? []) request.onDelta?.({ text: increment });
    if (attempt.error !== undefined) {
      const error = new Error(attempt.error.message);
      Object.assign(error, attempt.error);
      throw error;
    }
    return attempt.result ?? RESULT("");
  }
}

async function seed(store: RuntimeStore, streamId: string, events: readonly EventInput[]) {
  await store.transaction((tx) => append(tx, WORKSPACE, [{ streamId, events }]));
}

async function claimedCall(store: RuntimeStore, queue: Queue, key = KEY, now = 0) {
  await store.transaction((tx) =>
    queue.enqueue(tx, { type: "llm.call", key, streamId: STREAM, workspaceId: WORKSPACE }),
  );
  const lease = await queue.claim("worker-1", ["llm.call"], now);
  if (lease === null) throw new Error(`expected a claimable ${key} job in the test setup`);
  return lease;
}

/** Settles like `promise`, or fails as an assertion on a hang. */
async function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new AssertionError({ message: `deadlocked: ${what} did not settle within 2s` })),
      2_000,
    );
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

describeDrivers("runtime ll.call delta accumulation (ANY-94 R16)", (h) => {
  test("D2: the sink receives the attempt's cumulative text — a,b,c as a,ab,abc — and a retried attempt starts from empty", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    // attempt 1: emits, then a 429 the queue must retry; attempt 2: the same key, fresh.
    const model = new IncrementModel([
      { increments: ["x", "y"], error: { message: "rate limited", status: 429, retryable: true } },
      { increments: ["a", "b", "c"], result: RESULT("abc") },
    ]);
    await seed(store, STREAM, [
      runCreated({ systemPrompt: "SYS", tools: [], model: "m1" }),
      messageReceived("say it", "pm-1"),
      requested(1, 1),
    ]);
    const seen: { text: string; call: unknown }[] = [];
    const onDelta = (delta: { text: string }, call: { streamId: string; turn: number; callNo: number }) => {
      seen.push({ text: delta.text, call });
    };

    const lease1 = await claimedCall(store, queue);
    await within(handleLlmCallJob(lease1, { store, queue, model, onDelta, now: () => 1_000 }), "the 429 attempt");
    // the queue owns the retry: re-claim the same key and run it again
    const lease2 = await queue.claim("worker-2", ["llm.call"], 1_000_000);
    expect(lease2, "the retried job is claimable again").not.toBeNull();
    await within(handleLlmCallJob(lease2 as QueueLease, { store, queue, model, onDelta }), "the retry attempt");

    // the sink saw the increments ACCUMULATED, per attempt, with the call's identity
    expect(seen.map((entry) => entry.text)).toEqual(["x", "xy", "a", "ab", "abc"]);
    for (const entry of seen) {
      expect(entry.call).toEqual({ streamId: STREAM, turn: 1, callNo: 1 });
    }
    // the retry's first sink text is its own first increment — not the failed attempt's tail
    expect(seen[2]!.text).toBe("a");
    expect((await eventsOf(store)).some((event) => event.type === "llm.failed")).toBe(false);
  });

  test("D7: successive calls on one stream never bleed — call 2's texts are its own, callNo 2", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const model = new IncrementModel([
      { increments: ["x", "y"], result: RESULT("xy") },
      { increments: ["p", "q"], result: RESULT("pq") },
    ]);
    await seed(store, STREAM, [
      runCreated({ systemPrompt: "SYS", tools: [], model: "m1" }),
      messageReceived("one", "pm-1"),
      requested(1, 1),
    ]);
    const seen: { text: string; call: unknown }[] = [];
    const onDelta = (delta: { text: string }, call: { streamId: string; turn: number; callNo: number }) => {
      seen.push({ text: delta.text, call });
    };

    const lease1 = await claimedCall(store, queue);
    await handleLlmCallJob(lease1, { store, queue, model, onDelta });

    // a second call in the same turn, its own job
    await seed(store, STREAM, [requested(1, 2)]);
    const lease2 = await claimedCall(store, queue, `${STREAM}:1:llm:2`);
    await handleLlmCallJob(lease2, { store, queue, model, onDelta });

    const first = seen.filter((entry) => (entry.call as { callNo: number }).callNo === 1);
    const second = seen.filter((entry) => (entry.call as { callNo: number }).callNo === 2);
    expect(first.map((entry) => entry.text)).toEqual(["x", "xy"]);
    // the second call's texts are its own accumulation — never prefixed by call 1's
    expect(second.map((entry) => entry.text)).toEqual(["p", "pq"]);
    expect(second.every((entry) => (entry.call as { callNo: number }).callNo === 2)).toBe(true);
    expect(second.map((entry) => entry.call)).toEqual([
      { streamId: STREAM, turn: 1, callNo: 2 },
      { streamId: STREAM, turn: 1, callNo: 2 },
    ]);
  });
});

async function eventsOf(store: RuntimeStore) {
  return store.readStream(STREAM, { workspaceId: WORKSPACE });
}
