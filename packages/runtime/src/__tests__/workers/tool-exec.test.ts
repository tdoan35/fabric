// ANY-39 R9b — W8..W11b: the `tool.exec` job. One run of the tool the
// `tool.call` names, its terminal lines on the log as `tool.result`
// telemetry, the completion — plus `artifact.created` / `memory.written`
// when the result carries them — and the effect-class recovery: a retried
// job that finds no recorded result runs `read`/`idempotent` again, records
// `tool.interrupted` on `rerunnable`, and escalates to a human on `once`.
// Every fact lands with `causation = <stream>:<callId>`, so a re-run after
// the result was recorded appends nothing twice. Both drivers.
//
// The "retried with no result" state is staged by crashing the handler's
// transaction after the tool ran (`crashAfterRun`): the attempt's appends
// and lease completion roll back, the queue re-delivers, the retry finds
// the `tool.call` with nothing recorded.
import { expect, test } from "vitest";
import { append, type EventInput } from "../../index";
import { MemoryQueue } from "../../queue/memory";
import type { Queue, QueueJobInput, QueueLease, QueueTx } from "../../queue/types";
import type { RuntimeStore } from "../../store/types";
import { describeDrivers } from "../../testing/drivers";
import { FakeTools, type FakeToolSpec } from "../../testing/fake-tools";
import { handleToolExecJob } from "../../workers/tool-exec";

const WORKSPACE = "ws-r9b";
const STREAM = "run:r9b";
const CALL_ID = "c1";
const CALL_KEY = `${STREAM}:${CALL_ID}`;

const INTERRUPTED_NOTE = "interrupted by a restart; effects may be partial";
const HUMAN_PROMPT = "check whether this happened";
const CRASH = "simulated crash after the tool ran";

// -- stream fixtures -----------------------------------------------------------

const runCreated: EventInput = {
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
};

const toolCalled = (effect: string, args: Record<string, unknown> = {}): EventInput => ({
  type: "tool.call",
  actor: "decide",
  payload: { tool: "sh", summary: "run it", callId: CALL_ID, args, effect },
});

async function seed(store: RuntimeStore, events: readonly EventInput[]) {
  await store.transaction((tx) => append(tx, WORKSPACE, [{ streamId: STREAM, events }]));
}

async function claimedToolExec(store: RuntimeStore, queue: Queue, now = 0) {
  await store.transaction((tx) =>
    queue.enqueue(tx, { type: "tool.exec", key: CALL_KEY, streamId: STREAM, workspaceId: WORKSPACE })
  );
  const lease = await queue.claim("worker-1", ["tool.exec"], now);
  if (lease === null) throw new Error("expected a claimable tool.exec job in the test setup");
  return lease;
}

async function streamEvents(store: RuntimeStore) {
  return store.readStream(STREAM, { workspaceId: WORKSPACE });
}

const of = (events: Awaited<ReturnType<typeof streamEvents>>, type: string) =>
  events.filter((event) => event.type === type);

/** The store, with every transaction crashing after its work ran — the
 * at-least-once state: side effects happened, nothing was recorded. */
const crashAfterRun = (store: RuntimeStore): RuntimeStore => ({
  transaction: (fn) =>
    store.transaction(async (tx) => {
      await fn(tx);
      throw new Error(CRASH); // the appends and the lease completion roll back
    }),
  readStream: (streamId, options) => store.readStream(streamId, options),
  close: () => store.close(),
});

/** A queue that remembers every enqueue, so tests count the re-decides. */
class RecordingQueue {
  readonly enqueued: QueueJobInput[] = [];

  constructor(private readonly inner: Queue) {}

  enqueue(tx: QueueTx, job: QueueJobInput) {
    this.enqueued.push(job);
    return this.inner.enqueue(tx, job);
  }

  claim(workerId: string, types: readonly string[], now: number) {
    return this.inner.claim(workerId, types, now);
  }

  heartbeat(lease: QueueLease, now: number) {
    return this.inner.heartbeat(lease, now);
  }

  complete(tx: QueueTx, lease: QueueLease) {
    return this.inner.complete(tx, lease);
  }

  fail(lease: QueueLease, error: Error, options: { retryable: boolean }, now: number) {
    return this.inner.fail(lease, error, options, now);
  }

  get(jobId: string) {
    return this.inner.get(jobId);
  }
}

describeDrivers("runtime tool.exec worker (ANY-39 R9b)", (h) => {
  test("W8 read effect, retried with no result: the tool runs again and one completion is recorded", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const tools = new FakeTools({
      sh: { effect: "read", runs: [{ ok: true, result: "listing" }, { ok: true, result: "listing" }] },
    });
    await seed(store, [runCreated, toolCalled("read")]);

    const lease = await claimedToolExec(store, queue);
    await expect(
      handleToolExecJob(lease, { store: crashAfterRun(store), queue, tools, now: () => 0 })
    ).rejects.toThrow(CRASH);
    expect(tools.count("sh")).toBe(1); // the crashed attempt ran it; nothing was recorded

    const retried = await queue.claim("worker-2", ["tool.exec"], 30_000); // past the backoff
    expect(retried?.attempt).toBe(2);
    await handleToolExecJob(retried!, { store, queue, tools, now: () => 0 });

    expect(tools.count("sh")).toBe(2);
    const completed = of(await store.readStream(STREAM, { workspaceId: WORKSPACE }), "tool.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]!.causation).toBe(CALL_KEY);
    expect(completed[0]!.payload).toMatchObject({ callId: CALL_ID, ok: true, result: "listing" });
  });

  test("W9 rerunnable effect, retried with no result: interrupted with the partial-effects note, not run again", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const tools = new FakeTools({ sh: { effect: "rerunnable", runs: [{ ok: true, result: "ok" }] } });
    await seed(store, [runCreated, toolCalled("rerunnable")]);

    const lease = await claimedToolExec(store, queue);
    await expect(
      handleToolExecJob(lease, { store: crashAfterRun(store), queue, tools, now: () => 0 })
    ).rejects.toThrow(CRASH);
    expect(tools.count("sh")).toBe(1);

    const retried = await queue.claim("worker-2", ["tool.exec"], 30_000);
    await handleToolExecJob(retried!, { store, queue, tools, now: () => 0 });

    expect(tools.count("sh")).toBe(1); // the retry recorded the interruption instead of running
    const events = await store.readStream(STREAM, { workspaceId: WORKSPACE });
    const interrupted = of(events, "tool.interrupted");
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]!.payload).toEqual({
      callId: CALL_ID,
      effect: "rerunnable",
      note: INTERRUPTED_NOTE,
    });
    expect(interrupted[0]!.causation).toBe(CALL_KEY);
    expect(of(events, "tool.completed")).toHaveLength(0);
  });

  test("W10 once effect, retried with no result: interrupted, then a human asked to check, not run again", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const tools = new FakeTools({ sh: { effect: "once", runs: [{ ok: true, result: "sent" }] } });
    await seed(store, [runCreated, toolCalled("once")]);

    const lease = await claimedToolExec(store, queue);
    await expect(
      handleToolExecJob(lease, { store: crashAfterRun(store), queue, tools, now: () => 0 })
    ).rejects.toThrow(CRASH);
    expect(tools.count("sh")).toBe(1);

    const retried = await queue.claim("worker-2", ["tool.exec"], 30_000);
    await handleToolExecJob(retried!, { store, queue, tools, now: () => 0 });

    expect(tools.count("sh")).toBe(1);
    const events = await store.readStream(STREAM, { workspaceId: WORKSPACE });
    const interrupted = of(events, "tool.interrupted");
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]!.payload).toEqual({ callId: CALL_ID, effect: "once", note: INTERRUPTED_NOTE });
    const requested = of(events, "human.requested");
    expect(requested).toHaveLength(1);
    expect(requested[0]!.payload).toMatchObject({ prompt: HUMAN_PROMPT, gated: false });
    expect(of(events, "tool.completed")).toHaveLength(0);
  });

  test("W10a a once recovery passes the provider's idempotency key to the human", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const tools = new FakeTools({ sh: { effect: "once", runs: [{ ok: true, result: "sent" }] } });
    await seed(store, [runCreated, toolCalled("once", { idempotencyKey: "pay-1" })]);

    const lease = await claimedToolExec(store, queue);
    await expect(
      handleToolExecJob(lease, { store: crashAfterRun(store), queue, tools, now: () => 0 })
    ).rejects.toThrow(CRASH);

    const retried = await queue.claim("worker-2", ["tool.exec"], 30_000);
    await handleToolExecJob(retried!, { store, queue, tools, now: () => 0 });

    const requested = of(await store.readStream(STREAM, { workspaceId: WORKSPACE }), "human.requested");
    expect(requested[0]!.payload).toMatchObject({ prompt: `${HUMAN_PROMPT} (idempotency key: pay-1)` });
  });

  test("W11 terminal lines are tool.result telemetry in order, and the lines trigger no decide", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const spied = new RecordingQueue(queue);
    const tools = new FakeTools({
      sh: { effect: "read", runs: [{ ok: true, result: "done", lines: ["$ ls", "a.txt", "b.txt"] }] },
    });
    await seed(store, [runCreated, toolCalled("read")]);

    const lease = await claimedToolExec(store, spied as unknown as Queue);
    await handleToolExecJob(lease, { store, queue: spied as unknown as Queue, tools, now: () => 0 });

    const lines = of(await streamEvents(store), "tool.result").map(
      (event) => (event.payload as { line: string }).line
    );
    expect(lines).toEqual(["$ ls", "a.txt", "b.txt"]);
    const kinds = of(await streamEvents(store), "tool.result").map(
      (event) => (event.payload as { kind: string }).kind
    );
    expect(kinds).toEqual(["term", "term", "term"]);
    // exactly one re-decide — the completion's; the telemetry added none
    expect(spied.enqueued.map((job) => job.type)).toEqual(["tool.exec", "decide"]);
  });

  test("W11a a result carrying an artifact and a memory write records both next to the completion", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const tools = new FakeTools({
      sh: {
        effect: "idempotent",
        runs: [
          {
            ok: true,
            result: {
              artifact: { name: "report.pdf", artifactId: "a1" },
              memory: { scope: "run:r9b", itemId: "m1", op: "add", contentRef: "mem:c1" },
            },
          },
        ],
      },
    });
    await seed(store, [runCreated, toolCalled("idempotent")]);

    const lease = await claimedToolExec(store, queue);
    await handleToolExecJob(lease, { store, queue, tools, now: () => 0 });

    const events = await streamEvents(store);
    const artifact = of(events, "artifact.created");
    expect(artifact).toHaveLength(1);
    expect(artifact[0]!.payload).toEqual({ name: "report.pdf", artifactId: "a1" });
    const memory = of(events, "memory.written");
    expect(memory).toHaveLength(1);
    expect(memory[0]!.payload).toEqual({ scope: "run:r9b", itemId: "m1", op: "add", contentRef: "mem:c1" });
    expect("text" in (memory[0]!.payload as Record<string, unknown>)).toBe(false); // by reference, never inline
    const completed = of(events, "tool.completed");
    expect(completed).toHaveLength(1);
    // one transaction: the two facts and the completion are adjacent, completion last
    expect(artifact[0]!.seq).toBe(memory[0]!.seq - 1);
    expect(memory[0]!.seq).toBe(completed[0]!.seq - 1);
  });

  test("W11b idempotent effect, retried after the result was recorded: no second completion, no rerun", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const tools = new FakeTools({ sh: { effect: "idempotent", runs: [{ ok: true, result: "upserted" }] } });
    await seed(store, [runCreated, toolCalled("idempotent")]);

    const lease = await claimedToolExec(store, queue);
    await handleToolExecJob(lease, { store, queue, tools, now: () => 0 });
    await handleToolExecJob(lease, { store, queue, tools, now: () => 0 }); // the at-least-once re-run

    expect(tools.count("sh")).toBe(1);
    expect(of(await streamEvents(store), "tool.completed")).toHaveLength(1);
  });
});
