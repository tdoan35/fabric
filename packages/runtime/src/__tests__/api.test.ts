// ANY-36 R10 — the wait/cancel API (RUNTIME §7). `respond` answers an open
// wait: the open-wait check and the `human.responded` append are ONE
// transaction on the locked stream head, so exactly one of N concurrent
// answers is accepted; the refusals are expired, already_answered, cancelled
// and gated. `cancel` appends `run.cancel_requested`; past it the append guard
// refuses late results for the stream. Both drivers, per the house
// describeDrivers seam.
import { expect, test } from "vitest";
import { append, type EventInput, type RuntimeStore } from "../index";
import { MemoryQueue } from "../queue/memory";
import { describeDrivers } from "../testing/drivers";
import { appendGuarded, cancel } from "../api/cancel";
import { respond } from "../api/respond";
import { handleTimerJob } from "../workers/timer";

const WORKSPACE = "ws-r10-api";
const NOW = 1_000_000;
const DEADLINE = NOW + 60_000;

// -- fixtures -------------------------------------------------------------------

const runCreated: EventInput = {
  type: "run.created",
  actor: "api",
  payload: {
    definition: { tools: ["ask_user"] },
    engineVersion: "v1",
    brief: "",
    grants: [],
    budgets: {},
    parent: null,
  },
};

const llmRequested: EventInput = {
  type: "llm.requested",
  actor: "decide",
  payload: { turn: 1, callNo: 1, model: "m1", params: {}, snapshotId: null },
};

const humanRequested = (over: Record<string, unknown> = {}): EventInput => ({
  type: "human.requested",
  actor: "decide",
  payload: { waitId: "w1", kind: "answer", gated: false, prompt: "Book it?", deadline: DEADLINE, ...over },
});

const toolCompleted: EventInput = {
  type: "tool.completed",
  actor: "tool.exec",
  payload: { callId: "c9", ok: true, result: "late" },
};

async function seed(store: RuntimeStore, streamId: string, events: readonly EventInput[]) {
  await store.transaction((tx) => append(tx, WORKSPACE, [{ streamId, events }]));
}

/** The waiting stream: asked and open, deadline a minute out. */
const waitingStream = (store: RuntimeStore, stream = "session:a1", over: Record<string, unknown> = {}) =>
  seed(store, stream, [runCreated, llmRequested, humanRequested(over)]);

const eventsOn = (store: RuntimeStore, streamId: string) =>
  store.readStream(streamId, { workspaceId: WORKSPACE });

const of = async (store: RuntimeStore, streamId: string, type: string) =>
  (await eventsOn(store, streamId)).filter((event) => event.type === type);

describeDrivers("runtime wait/cancel API (ANY-36 R10)", (h) => {
  test("T2: an answer before the deadline is accepted once; the late deadline firing does nothing", async () => {
    const store = await h.openStore();
    const stream = "session:a1";
    const queue = new MemoryQueue();
    await waitingStream(store);

    const result = await respond(store, WORKSPACE, stream, "w1", "yes", {
      by: "ty",
      surface: "app",
      now: () => NOW + 1_000,
    });
    expect(result).toEqual({ outcome: "accepted" });

    // exactly one human.responded, carrying the answer and its provenance
    const responded = await of(store, stream, "human.responded");
    expect(responded).toHaveLength(1);
    expect(responded[0]!.payload).toEqual({ waitId: "w1", decision: "yes", by: "ty", surface: "app" });

    // the deadline timer, fired after the answer: no events, nothing to decide
    await store.transaction((tx) =>
      queue.enqueue(tx, { type: "run.timer", key: `${stream}:timer:w1`, streamId, workspaceId: WORKSPACE })
    );
    const lease = await queue.claim("worker-timer", ["run.timer"], DEADLINE);
    expect(lease?.key).toBe(`${stream}:timer:w1`);
    const before = (await eventsOn(store, stream)).length;
    await handleTimerJob(lease!, { store, queue, now: () => DEADLINE });
    expect((await eventsOn(store, stream)).length).toBe(before);
  });

  test("T3: an answer after the deadline timer fired is refused as expired", async () => {
    const store = await h.openStore();
    const stream = "session:a2";
    const queue = new MemoryQueue();
    await waitingStream(store);

    // the deadline passes unanswered: the timer fires (and observes, appending nothing)
    await store.transaction((tx) =>
      queue.enqueue(tx, { type: "run.timer", key: `${stream}:timer:w1`, streamId, workspaceId: WORKSPACE })
    );
    const lease = await queue.claim("worker-timer", ["run.timer"], DEADLINE);
    await handleTimerJob(lease!, { store, queue, now: () => DEADLINE });

    const result = await respond(store, WORKSPACE, stream, "w1", "yes", {
      by: "ty",
      surface: "app",
      now: () => DEADLINE + 1,
    });
    expect(result).toEqual({ outcome: "refused", reason: "expired" });
    expect(await of(store, stream, "human.responded")).toHaveLength(0);
  });

  test("T4: a second answer to the same wait is refused as already_answered", async () => {
    const store = await h.openStore();
    const stream = "session:a3";
    await waitingStream(store);

    const opts = { by: "ty", surface: "app" as const, now: () => NOW + 1_000 };
    expect(await respond(store, WORKSPACE, stream, "w1", "yes", opts)).toEqual({ outcome: "accepted" });
    const second = await respond(store, WORKSPACE, stream, "w1", "no", opts);
    expect(second).toEqual({ outcome: "refused", reason: "already_answered" });
    expect(await of(store, stream, "human.responded")).toHaveLength(1);
  });

  test("T5: an answer on a cancelled run is refused as cancelled", async () => {
    const store = await h.openStore();
    const stream = "session:a4";
    await waitingStream(store);
    await cancel(store, WORKSPACE, stream, "ty");

    expect((await of(store, stream, "run.cancel_requested"))[0]!.payload).toEqual({ by: "ty" });

    const result = await respond(store, WORKSPACE, stream, "w1", "yes", {
      by: "ty",
      surface: "app",
      now: () => NOW + 1_000,
    });
    expect(result).toEqual({ outcome: "refused", reason: "cancelled" });
    expect(await of(store, stream, "human.responded")).toHaveLength(0);
  });

  test("T6: a gated wait refuses channel answers and accepts the app's", async () => {
    const store = await h.openStore();
    const stream = "session:a5";
    await waitingStream(store, "session:a5", { gated: true, waitId: "w1" });

    const channel = await respond(store, WORKSPACE, stream, "w1", "yes", {
      by: "ty",
      surface: "channel",
      now: () => NOW + 1_000,
    });
    expect(channel).toEqual({ outcome: "refused", reason: "gated" });

    const app = await respond(store, WORKSPACE, stream, "w1", "yes", {
      by: "ty",
      surface: "app",
      now: () => NOW + 1_000,
    });
    expect(app).toEqual({ outcome: "accepted" });
    expect(await of(store, stream, "human.responded")).toHaveLength(1);
  });

  test("T7: ten concurrent answers from separate connections yield exactly one acceptance", async () => {
    const store = await h.openStore();
    const stream = "session:a6";
    await waitingStream(store);

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, n) =>
        respond(store, WORKSPACE, stream, "w1", `answer-${n}`, {
          by: `user-${n}`,
          surface: "app",
          now: () => NOW + 1_000,
        })
      )
    );
    expect(results.filter((r) => r.outcome === "accepted")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "refused")).toHaveLength(9);
    expect(await of(store, stream, "human.responded")).toHaveLength(1);
  });

  test("T9: cancel appends run.cancel_requested; the append guard refuses late results", async () => {
    const store = await h.openStore();
    const stream = "session:a7";
    await seed(store, stream, [
      runCreated,
      { type: "run.started", actor: "api", payload: { objective: "x" } },
      {
        type: "tool.call",
        actor: "decide",
        payload: { tool: "shell", summary: "", callId: "c9", args: {}, effect: "read" },
      },
    ]);

    // the guard passes while the run is open
    await store.transaction(async (tx) => {
      const open = await appendGuarded(tx, WORKSPACE, { streamId: stream, events: [toolCompleted] });
      expect(open).toEqual({ appended: true });
    });
    expect(await of(store, stream, "tool.completed")).toHaveLength(1);

    await cancel(store, WORKSPACE, stream, "ty");
    const afterCancel = (await eventsOn(store, stream)).length;

    // past the cancellation, the late result is refused and not recorded
    await store.transaction(async (tx) => {
      const guarded = await appendGuarded(tx, WORKSPACE, { streamId: stream, events: [toolCompleted] });
      expect(guarded).toEqual({ appended: false });
    });
    expect((await eventsOn(store, stream)).length).toBe(afterCancel);
    expect(await of(store, stream, "tool.completed")).toHaveLength(1);
  });
});
