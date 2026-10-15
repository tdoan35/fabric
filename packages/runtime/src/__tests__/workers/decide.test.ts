// ANY-35 R9a — W1: the `decide` job. The decision's events and the jobs they
// queue commit together in one transaction; when the append fails, no job is
// enqueued and the lease survives for the retry. Both drivers, per the house
// describeDrivers seam; the queue is the in-memory reference implementation
// over the real store transaction, exactly as the R8 conformance runs it.
import { expect, test } from "vitest";
import { append, type EventInput, type RuntimeStore, type RuntimeTx } from "../../index";
import { MemoryQueue } from "../../queue/memory";
import { describeDrivers } from "../../testing/drivers";
import { handleDecideJob } from "../../workers/decide";

const WORKSPACE = "ws-r9a";
const STREAM = "run:r1";

const runCreated: EventInput = {
  type: "run.created",
  actor: "api",
  payload: {
    definition: { systemPrompt: "SYS", tools: ["lookup"], model: "m1", maxSteps: 4 },
    engineVersion: "v1",
    brief: "",
    grants: [],
    budgets: {},
    parent: null,
  },
};

const messageReceived: EventInput = {
  type: "message.received",
  actor: "user",
  payload: {
    text: "what is X?",
    attachments: [],
    surface: "app",
    sender: "tester",
    platformMessageId: "pm-1",
  },
};

async function seed(store: RuntimeStore, streamId: string, events: readonly EventInput[]) {
  await store.transaction((tx) => append(tx, WORKSPACE, [{ streamId, events }]));
}

/** Enqueue through the store transaction, so the queue's staged write lands. */
async function enqueueJob(
  store: RuntimeStore,
  queue: MemoryQueue,
  job: { type: string; key: string; streamId: string }
) {
  await store.transaction((tx) => queue.enqueue(tx, { ...job, workspaceId: WORKSPACE }));
}

/** The same store, its `insert into events` failing once the tx is under way. */
function storeFailingOnEventInsert(store: RuntimeStore): RuntimeStore {
  return {
    transaction: async <T,>(fn: (tx: RuntimeTx) => Promise<T>): Promise<T> =>
      store.transaction(async (tx): Promise<T> =>
        fn({
          query: async (sql: string, params?: readonly unknown[]) => {
            if (sql.includes("insert into events")) throw new Error("append boom (simulated)");
            return tx.query(sql, params);
          },
          onCommit: (hook: () => unknown) => tx.onCommit(hook),
        })
      ),
    readStream: (streamId, options) => store.readStream(streamId, options),
    close: () => store.close(),
  };
}

describeDrivers("runtime decide worker (ANY-35 R9a)", (h) => {
  test("W1 the decision's events and jobs commit together; a failed append enqueues nothing", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    await seed(store, STREAM, [runCreated, messageReceived]);
    const seedLength = (await store.readStream(STREAM, { workspaceId: WORKSPACE })).length;

    // -- the append fails: the transaction rolls back, no job survives ----------
    await enqueueJob(store, queue, { type: "decide", key: "decide:r1:a", streamId: STREAM });
    const failingLease = await queue.claim("worker-1", ["decide"], 0);
    expect(failingLease?.type).toBe("decide");

    await expect(
      handleDecideJob(failingLease!, {
        store: storeFailingOnEventInsert(store),
        queue,
      })
    ).rejects.toThrow(/append boom/);

    const afterFailure = await store.readStream(STREAM, { workspaceId: WORKSPACE });
    expect(afterFailure.length).toBe(seedLength); // no decision events
    expect(await queue.claim("worker-1", ["llm.call"], 1)).toBeNull(); // and no job
    // the handler failed the lease: backoff-run pending, the retry the type config grants
    expect((await queue.get(failingLease!.jobId))?.status).toBe("pending");

    // -- the same decision, the append whole: events and jobs commit together ---
    await enqueueJob(store, queue, { type: "decide", key: "decide:r1:b", streamId: STREAM });
    const lease = await queue.claim("worker-2", ["decide"], 2);
    await handleDecideJob(lease!, { store, queue });

    const events = await store.readStream(STREAM, { workspaceId: WORKSPACE });
    const requested = events.filter((event) => event.type === "llm.requested");
    expect(requested).toHaveLength(1);
    expect(String(requested[0]!.causation)).toMatch(/^decide:r1:b/);

    const llCall = await queue.claim("worker-3", ["llm.call"], 3);
    expect(llCall?.key).toBe("run:r1:1:llm:1");
    expect(llCall?.streamId).toBe(STREAM);
  });

  test("W2 a telemetry-only append queues no re-decide — the class filter (ANY-98)", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const stream = "session:w2";

    // The turn is already dispositioned, so the decide reacting to the
    // completion appends only endTurn's reply — telemetry, no fact.
    await seed(store, stream, [
      {
        type: "run.created",
        actor: "api",
        payload: {
          definition: { systemPrompt: "SYS", tools: [], surfaces: ["app"], model: "m1" },
          engineVersion: "v1",
          brief: "",
          grants: [],
          budgets: {},
          parent: null,
        },
      },
      messageReceived,
      { type: "llm.requested", actor: "decide", payload: { turn: 1, callNo: 1, model: "m1", params: {}, snapshotId: null } },
      {
        type: "llm.completed",
        actor: "llm.call",
        payload: { turn: 1, callNo: 1, text: "Done.", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.1 }, finishReason: "stop", model: "m1" },
      },
      {
        type: "disposition.recorded",
        actor: "decide",
        payload: { kind: "direct", target: null, reason: "r", considered: [], source: "model", turn: 1 },
      },
    ]);
    await enqueueJob(store, queue, { type: "decide", key: "decide:w2:a", streamId: stream });
    const lease = await queue.claim("worker-1", ["decide"], 1);
    await handleDecideJob(lease!, { store, queue });

    // the reply landed, telemetry alone
    const replies = (await store.readStream(stream, { workspaceId: WORKSPACE })).filter(
      (event) => event.type === "agent.message"
    );
    expect(replies).toHaveLength(1);
    expect(replies[0]!.class).toBe("telemetry");

    // and it re-decides nothing: no decide job is claimable afterwards. With
    // the class filter gone this exact turn self-feeds — ANY-98's runaway.
    expect(await queue.claim("worker-2", ["decide"], 1)).toBeNull();
  });
});
