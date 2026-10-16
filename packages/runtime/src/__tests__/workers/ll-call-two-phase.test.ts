// ANY-95 R15 — `llm.call` runs the model OUTSIDE the store transaction. The
// single-transaction attempt (R9a) holds PGlite's serialized chain — and on
// Postgres a pooled client plus the stream's row locks — for the whole model
// call, starving every other transaction (other sessions' message POSTs, other
// decides, the queue's own claims and heartbeats); a call longer than the
// heartbeat window can even lose its own lease. The attempt splits around the
// call, R14's shape: read (the done-guard, the rebuild, the compaction rule,
// the assembled request — nothing appended), call bare, record (the guard
// again, then `context.compacted` / `context.snapshot` / `llm.completed` in
// one batch, the re-decide and the lease, exactly today's payloads). The
// worker hands the delta attribution to `onDelta` itself — no enclosing
// transaction's scan survives to a call outside one.
//
// C1 proves the free chain on PGlite, C2 the free row on Postgres, C6 and C8
// the phase-three guard and the lease across a parked call; C3, C4, C5 and C7
// pin the recorded shape, the request and the failure paths. Both drivers
// except where a case names one.
import { AssertionError } from "node:assert";
import { AsyncLocalStorage } from "node:async_hooks";
import { expect, test } from "vitest";
import { append, type EventInput } from "../../index";
import { MemoryQueue } from "../../queue/memory";
import { PgQueue } from "../../queue/pg";
import { DEFAULT_TYPE_CONFIGS, type Queue, type QueueLease } from "../../queue/types";
import type { RuntimeStore, RuntimeTx } from "../../store/types";
import { describeDrivers } from "../../testing/drivers";
import { FakeModel } from "../../testing/fake-model";
import { handleLlmCallJob } from "../../workers/ll-call";

const WORKSPACE = "ws-r15";
const STREAM = "run:r15";
const OTHER = "run:r15-other";
const KEY = `${STREAM}:1:llm:1`;
const DEADLINE_MS = 2_000;
/** C8's shortened `llm.call` heartbeat window; the production one is 60 s. */
const HEARTBEAT_MS = 100;

// -- fixtures -------------------------------------------------------------------

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

const completedFact = (
  turn: number,
  callNo: number,
  text: string,
  toolCalls: Record<string, unknown>[],
  causation?: string,
): EventInput => ({
  type: "llm.completed",
  actor: "llm.call",
  ...(causation !== undefined ? { causation } : {}),
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

const compacted = (upToSeq: number, summary: string): EventInput => ({
  type: "context.compacted",
  actor: "llm.call",
  payload: { upToSeq, summary },
});

const RESULT = {
  text: "X is Y.",
  toolCalls: [] as Record<string, unknown>[],
  usage: { inputTokens: 12, outputTokens: 3, costUsd: 0.5 },
  finishReason: "stop",
};

async function seed(store: RuntimeStore, streamId: string, events: readonly EventInput[]) {
  await store.transaction((tx) => append(tx, WORKSPACE, [{ streamId, events }]));
}

async function enqueueCall(store: RuntimeStore, queue: Queue, key: string, streamId: string) {
  await store.transaction((tx) =>
    queue.enqueue(tx, { type: "llm.call", key, streamId, workspaceId: WORKSPACE }),
  );
}

async function claimedCall(store: RuntimeStore, queue: Queue, key = KEY, streamId = STREAM, now = 0) {
  await enqueueCall(store, queue, key, streamId);
  const lease = await queue.claim("worker-1", ["llm.call"], now);
  if (lease === null) throw new Error(`expected a claimable ${key} job in the test setup`);
  return lease;
}

const eventsOf = async (store: RuntimeStore, streamId: string) =>
  store.readStream(streamId, { workspaceId: WORKSPACE });

const withType = (events: Awaited<ReturnType<typeof eventsOf>>, type: string) =>
  events.filter((event) => event.type === type);

/** Settles like `promise`, or fails as an assertion when it hangs past the
 * deadline — the R13/R14 convention: deadlocks surface as assertions. */
async function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new AssertionError({ message: `deadlocked: ${what} did not settle within ${DEADLINE_MS} ms` })),
      DEADLINE_MS,
    );
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** The model port the test controls: scripted results, every request recorded,
 * and — while armed — the call parks on a gate the test holds across
 * store-level probes. No network, no timers but the test's own. */
class GatedModel {
  readonly calls: { system: unknown; messages: unknown[]; tools: unknown[] }[] = [];

  #result: typeof RESULT;
  #armed = false;
  #started: (() => void) | undefined;
  #startedWait: Promise<void> = Promise.resolve();
  #release: (() => void) | undefined;
  #releaseWait: Promise<void> = Promise.resolve();

  constructor(result: typeof RESULT) {
    this.#result = result;
  }

  /** Park the next call on the gate. */
  arm() {
    this.#armed = true;
    this.#startedWait = new Promise((resolve) => (this.#started = resolve));
    this.#releaseWait = new Promise((resolve) => (this.#release = resolve));
  }

  /** Resolves once a call is inside the port (and parked, when armed). */
  started(): Promise<void> {
    return this.#startedWait;
  }

  /** Lets the parked call finish. */
  release() {
    this.#release?.();
  }

  async call(request: {
    system: string;
    messages: readonly unknown[];
    tools: readonly unknown[];
    onDelta?: (delta: { text: string }) => void;
  }): Promise<typeof RESULT> {
    this.calls.push({ system: request.system, messages: [...request.messages], tools: [...request.tools] });
    request.onDelta?.({ text: "half" });
    if (this.#armed) {
      this.#started?.();
      await this.#releaseWait;
    }
    return { ...this.#result, toolCalls: [...this.#result.toolCalls] };
  }
}

/** The bootstrap's `pgliteQueueBackend` shape (RUNTIME §8 local): the queue's
 * standalone statements ride the store's one serialized chain as single-
 * statement transactions; a queue call from inside a store transaction joins
 * it. C8's heartbeats and claims are only honest on a queue wired like the
 * server's. */
function pgliteShapedQueue(store: RuntimeStore, heartbeatMs: number): PgQueue {
  const innermost = new AsyncLocalStorage<{ tx: RuntimeTx }>();
  const wrapped = store as unknown as { transaction: (run: never) => Promise<unknown> };
  const original = store.transaction.bind(store);
  wrapped.transaction = (run: (tx: RuntimeTx) => Promise<unknown>) =>
    original((tx) => innermost.run({ tx }, () => run(tx)));

  const single = async (text: string, values: unknown[] = []) => {
    // The macrotask yield the server's backend carries: without it the
    // worker's back-to-back ready promises starve the timers.
    await new Promise((resolve) => setImmediate(resolve));
    return { rows: await store.transaction((tx) => tx.query(text, values)) };
  };
  const backend = {
    query: async (text: string, values: unknown[] = []) => {
      const enclosing = innermost.getStore();
      return enclosing === undefined
        ? single(text, values)
        : { rows: await enclosing.tx.query(text, values) };
    },
  };
  return new PgQueue({
    connection: { kind: "pglite", pglite: backend },
    typeConfigs: { "llm.call": { ...DEFAULT_TYPE_CONFIGS["llm.call"]!, heartbeatMs } },
  });
}

/** The bootstrap's warm-up (RUNTIME §8 local): the queue's one-time schema
 * init rides the same serialized chain, and a store transaction that awaits it
 * mid-transaction deadlocks the chain — settle it before anything else. */
async function warm(pgliteQueue: PgQueue) {
  await pgliteQueue.claim("fabric-test-warm", [], 0);
}

describeDrivers("runtime ll.call two-phase (ANY-95 R15)", (h) => {
  test("C1 a bystander transaction commits within 250 ms while the model call runs (PGlite)", async () => {
    if (h.driver !== "pglite") return;
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const model = new GatedModel(RESULT);
    await seed(store, STREAM, [runCreated({ systemPrompt: "SYS", tools: [], model: "m1" }), messageReceived("what is X?", "pm-1"), requested(1, 1)]);
    const lease = await claimedCall(store, queue);

    model.arm();
    const run = handleLlmCallJob(lease, { store, queue, model });
    await within(model.started(), "the model call to start");

    // A bystander transaction — another session's message landing — must
    // commit while the call is still parked. On the single-transaction
    // handler it queues behind the open attempt and cannot.
    let bystanderSettled = false;
    const bystander = store
      .transaction((tx) => append(tx, WORKSPACE, [{ streamId: OTHER, events: [messageReceived("elsewhere", "pm-2")] }]))
      .then(() => {
        bystanderSettled = true;
      });

    try {
      await expect.poll(() => bystanderSettled, { timeout: 250, interval: 10 }).toBe(true);
    } finally {
      model.release();
      await within(bystander, "the bystander transaction");
      await within(run, "the ll.call run");
    }

    const rows = await eventsOf(store, OTHER);
    expect(rows.map((event) => event.type)).toEqual(["message.received"]);
  });

  test("C2 the call's stream row is lockable nowait while the model call runs (Postgres)", async () => {
    if (h.driver !== "postgres") return;
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const model = new GatedModel(RESULT);
    await seed(store, STREAM, [runCreated({ systemPrompt: "SYS", tools: [], model: "m1" }), messageReceived("what is X?", "pm-1"), requested(1, 1)]);
    const lease = await claimedCall(store, queue);

    model.arm();
    const run = handleLlmCallJob(lease, { store, queue, model });
    await within(model.started(), "the model call to start");

    try {
      // A second connection locks the call's stream row without waiting: the
      // parked attempt holds no open transaction, so no row lock either.
      const locked = await within(
        store
          .transaction((tx) =>
            tx.query("select id from streams where id = $1 and workspace_id = $2 for update nowait", [
              STREAM,
              WORKSPACE,
            ]),
          )
          .then((rows) => rows.length)
          .catch(() => 0),
        "the nowait lock probe",
      );
      expect(locked).toBe(1);
    } finally {
      model.release();
      await within(run, "the ll.call run");
    }
  });

  test("C3 a normal call records exactly the single-transaction facts; with compaction, compacted then snapshot then completed", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const model = new GatedModel(RESULT);
    await seed(store, STREAM, [
      runCreated({ systemPrompt: "SYS", tools: [], model: "m1" }),
      messageReceived("what is X?", "pm-1"),
      requested(1, 1),
    ]);
    const lease = await claimedCall(store, queue);

    await handleLlmCallJob(lease, { store, queue, model });

    const events = await eventsOf(store, STREAM);
    expect(events.map((event) => [event.type, event.actor, event.causation])).toEqual([
      ["run.created", "api", null],
      ["message.received", "user", null],
      ["llm.requested", "decide", null],
      ["context.snapshot", "llm.call", `${KEY}:context.snapshot`],
      ["llm.completed", "llm.call", KEY],
    ]);
    expect(events[3]!.payload).toEqual({ snapshotId: "snap:run:r15:1:1" });
    expect(events[4]!.payload).toEqual({
      turn: 1,
      callNo: 1,
      text: "X is Y.",
      toolCalls: [],
      usage: { inputTokens: 12, outputTokens: 3, costUsd: 0.5 },
      finishReason: "stop",
      model: "m1",
    });
    expect((await queue.get(lease.jobId))?.status).toBe("completed");

    // The compaction variant: one batch, `context.compacted` first.
    const streamC = `${STREAM}-c`;
    const keyC = `${streamC}:1:llm:1`;
    const modelC = new GatedModel(RESULT);
    const longText = "the quick brown fox jumps over the lazy dog ".repeat(3);
    await seed(store, streamC, [
      runCreated({ systemPrompt: "SYS", tools: [], model: "m1" }),
      messageReceived(longText, "pm-2"),
      requested(1, 1),
    ]);
    const leaseC = await claimedCall(store, queue, keyC, streamC);

    await handleLlmCallJob(leaseC, {
      store,
      queue,
      model: modelC,
      compaction: { tokenLimit: 60, countTokens: (text: string) => text.length },
    });

    const eventsC = await eventsOf(store, streamC);
    const seqOf = (type: string) => eventsC.find((event) => event.type === type)!.seq;
    expect(seqOf("context.compacted")).toBeLessThan(seqOf("context.snapshot"));
    expect(seqOf("context.snapshot")).toBeLessThan(seqOf("llm.completed"));
    const compactedEvent = withType(eventsC, "context.compacted")[0]!;
    expect(compactedEvent.causation).toBe(`${keyC}:context.compacted`);
    expect(compactedEvent.payload).toMatchObject({ upToSeq: 2 });
    expect(modelC.calls[0]!.messages).toHaveLength(1); // the summary stands alone
    expect((await queue.get(leaseC.jobId))?.status).toBe("completed");
  });

  test("C4 the request the model receives deep-equals the single-transaction shape: system, messages, tools, thinking", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const calls: Record<string, unknown>[] = [];
    const model = {
      async call(request: Record<string, unknown>) {
        calls.push({ ...request });
        return RESULT;
      },
    };
    await seed(store, STREAM, [
      runCreated({
        system: "SYS",
        systemPrompt: "LEGACY SYS",
        toolSchemas: [
          {
            name: "lookup",
            description: "Look a thing up.",
            parameters: { type: "object", properties: { q: { type: "string" } } },
          },
        ],
        thinking: "low",
        model: "m1",
      }),
      // an earlier round, folded into the compaction summary
      messageReceived("older context", "pm-1"), // 2
      requested(1, 1), // 3
      completedFact(1, 1, "Earlier round.", [{ id: "c0", name: "lookup", args: { q: "old" } }]), // 4
      compacted(5, "Earlier: older context and an earlier round."), // 5
      // the live round: a tool pair and a decided proposal, then the call
      messageReceived("what is X?", "pm-2"), // 6
      requested(1, 2), // 7
      completedFact(1, 2, "Let me look.", [{ id: "c1", name: "lookup", args: { q: "X" } }], `${STREAM}:1:llm:2`), // 8
      toolCompleted("c1", "X is Y"), // 9
      { type: "proposal.decided", actor: "decide", payload: { kind: "approval", decision: "approved", by: "ty" } }, // 10
      requested(1, 3), // 11: the call this job runs
    ]);
    const lease = await claimedCall(store, queue, `${STREAM}:1:llm:3`);

    await handleLlmCallJob(lease, { store, queue, model } as never);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      system: "SYS",
      messages: [
        { role: "user", text: "Earlier: older context and an earlier round." },
        { role: "user", text: "what is X?" },
        { role: "assistant", text: "Let me look.", toolCalls: [{ id: "c1", name: "lookup", args: { q: "X" } }] },
        { role: "tool", toolCallId: "c1", text: "X is Y" },
        { role: "user", text: "proposal approval approved (by ty)" },
      ],
      tools: [
        {
          name: "lookup",
          description: "Look a thing up.",
          parameters: { type: "object", properties: { q: { type: "string" } } },
        },
      ],
      thinking: "low",
    });
  });

  test("C5 the phase-one done-guard: a recorded key completes without calling the model", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const model = new GatedModel(RESULT);
    await seed(store, STREAM, [
      runCreated({ systemPrompt: "SYS", tools: [], model: "m1" }),
      messageReceived("what is X?", "pm-1"),
      requested(1, 1),
      completedFact(1, 1, "X is Y.", [], KEY),
    ]);
    const before = await eventsOf(store, STREAM);
    const lease = await claimedCall(store, queue);

    await handleLlmCallJob(lease, { store, queue, model });

    expect(model.calls).toHaveLength(0); // never called
    expect(await eventsOf(store, STREAM)).toHaveLength(before.length); // nothing appended either
    expect((await queue.get(lease.jobId))?.status).toBe("completed");
  });

  test("C6 the phase-three done-guard: a completion recorded under the parked run's key discards this run's", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const model = new GatedModel(RESULT);
    await seed(store, STREAM, [
      runCreated({ systemPrompt: "SYS", tools: [], model: "m1" }),
      messageReceived("what is X?", "pm-1"),
      requested(1, 1),
    ]);
    const lease = await claimedCall(store, queue);

    model.arm();
    const run = handleLlmCallJob(lease, { store, queue, model });
    await within(model.started(), "the model call to start");

    // A second runner records the completion for the same key while the first
    // still runs — the state the phase-three guard exists for.
    const secondRunner = store
      .transaction((tx) =>
        append(tx, WORKSPACE, [
          { streamId: STREAM, events: [completedFact(1, 1, "second-runner", [], KEY)] },
        ]),
      )
      .then(() => undefined);

    try {
      await within(secondRunner, "the second runner's append");
    } finally {
      model.release();
      await within(run, "the ll.call run");
    }

    const events = await eventsOf(store, STREAM);
    expect(withType(events, "llm.completed")).toHaveLength(1);
    expect(withType(events, "llm.completed")[0]!.payload).toMatchObject({ text: "second-runner" });
    expect(withType(events, "context.snapshot")).toHaveLength(0); // no snapshot of the discarded run either
    expect(withType(events, "context.compacted")).toHaveLength(0);
    expect((await queue.get(lease.jobId))?.status).toBe("completed");
  });

  test("C7 failures: a non-retryable error records one llm.failed and no snapshot; a 429 fails retryably with nothing appended", async () => {
    // (a) non-retryable: recorded, once, without a snapshot
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const model = new FakeModel([{ message: "context too long", retryable: false }]);
    await seed(store, STREAM, [
      runCreated({ systemPrompt: "SYS", tools: [], model: "m1" }),
      messageReceived("what is X?", "pm-1"),
      requested(1, 1),
    ]);
    const lease = await claimedCall(store, queue);

    await handleLlmCallJob(lease, { store, queue, model });

    const events = await eventsOf(store, STREAM);
    const failed = withType(events, "llm.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({ turn: 1, callNo: 1, error: "context too long", retryable: false });
    expect(failed[0]!.causation).toBe(KEY);
    expect(withType(events, "context.snapshot")).toHaveLength(0);
    expect((await queue.get(lease.jobId))?.status).toBe("completed");

    // (b) 429: the queue owns the retry; nothing lands on the log
    const streamB = `${STREAM}-b`;
    const keyB = `${streamB}:1:llm:1`;
    const modelB = new FakeModel([{ message: "rate limited", status: 429, retryAfter: 30, retryable: true }]);
    await seed(store, streamB, [
      runCreated({ systemPrompt: "SYS", tools: [], model: "m1" }),
      messageReceived("what is X?", "pm-2"),
      requested(1, 1),
    ]);
    const before = (await eventsOf(store, streamB)).length;
    const leaseB = await claimedCall(store, queue, keyB, streamB, 1_000);

    await handleLlmCallJob(leaseB, { store, queue, model: modelB, now: () => 1_000 });

    expect(await eventsOf(store, streamB)).toHaveLength(before);
    const jobB = await queue.get(leaseB.jobId);
    expect(jobB?.status).toBe("pending");
    expect(jobB!.runAt).toBeGreaterThanOrEqual(1_000 + 30_000);
  });

  test("C8 the lease survives a call three windows long: heartbeats land during the call and no second claim (PGlite, the server's queue shape)", async () => {
    if (h.driver !== "pglite") return;
    const store = await h.openStore();
    // The bootstrap wiring: the queue's statements ride the store's chain, and
    // `llm.call`'s heartbeat window is shortened for the test.
    const pgliteQueue = pgliteShapedQueue(store, HEARTBEAT_MS);
    await warm(pgliteQueue);
    const queue = pgliteQueue;
    const model = new GatedModel(RESULT);
    await seed(store, STREAM, [
      runCreated({ systemPrompt: "SYS", tools: [], model: "m1" }),
      messageReceived("what is X?", "pm-1"),
      requested(1, 1),
    ]);
    const lease = await claimedCall(store, queue);

    model.arm();
    // The loop's heartbeat is exactly this call, at the window; the handler
    // parks through three of them.
    const run = handleLlmCallJob(lease, { store, queue, model });
    await within(model.started(), "the model call to start");

    try {
      await within(queue.heartbeat(lease as QueueLease, HEARTBEAT_MS), "the first heartbeat during the call");
      await within(queue.heartbeat(lease as QueueLease, 2 * HEARTBEAT_MS), "the second heartbeat during the call");
      await within(queue.heartbeat(lease as QueueLease, 3 * HEARTBEAT_MS), "the third heartbeat during the call");
      // Three windows in, the call still holds its lease: no second claim.
      const claim2 = await within(queue.claim("worker-2", ["llm.call"], 3 * HEARTBEAT_MS + HEARTBEAT_MS / 2), "the second claim");
      expect(claim2).toBeNull();
    } finally {
      model.release();
      await within(run, "the ll.call run");
    }
    expect((await queue.get(lease.jobId))?.status).toBe("completed");
  });

  test("C9 onDelta carries the call: the stream, turn and callNo of the call the worker runs", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const model = new FakeModel([RESULT, RESULT]);
    await seed(store, STREAM, [
      runCreated({ systemPrompt: "SYS", tools: [], model: "m1" }),
      messageReceived("what is X?", "pm-1"),
      requested(1, 1),
    ]);
    const seen: { delta: unknown; call: unknown }[] = [];
    const onDelta = (delta: { text: string }, call: { streamId: string; turn: number; callNo: number }) => {
      seen.push({ delta, call });
    };

    const lease1 = await claimedCall(store, queue);
    await handleLlmCallJob(lease1, { store, queue, model, onDelta });

    // a second call in the same turn
    await seed(store, STREAM, [requested(1, 2)]);
    const lease2 = await claimedCall(store, queue, `${STREAM}:1:llm:2`);
    await handleLlmCallJob(lease2, { store, queue, model, onDelta });

    expect(seen.length).toBeGreaterThanOrEqual(4); // two deltas per call
    expect(seen[0]!.call).toEqual({ streamId: STREAM, turn: 1, callNo: 1 });
    expect(seen[0]!.delta).toEqual({ text: "X is" });
    expect(seen[seen.length - 1]!.call).toEqual({ streamId: STREAM, turn: 1, callNo: 2 });
  });
});
