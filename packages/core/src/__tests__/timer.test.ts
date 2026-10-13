// ANY-36 R10 — the timer and stall rules, pure (RUNTIME §7). The `run.timer`
// trigger grammar (`<stream>:timer:<id>`), the arms every decide hangs on its
// decision — wait reminders per the definition, the stall watchdog on running
// streams, the run's time budget — and the firing decisions themselves. The
// job handler that claims and runs these lives in the runtime
// (packages/runtime/src/workers/timer.ts); here only the pure core, so the
// mutation run sees every branch.
import { expect, test } from "vitest";
import {
  decideAgent,
  decideTimer,
  fold,
  parseTimerTrigger,
  type Decision,
  type TimerTrigger,
} from "../index";

const NOW = 1_000_000;
const STREAM = "session:s1";

// -- fixtures -------------------------------------------------------------------

/** One typed envelope, the R3 helper's shape; the stream id is overridable. */
const evt = (seq: number, type: string, payload: Record<string, unknown>, streamId = STREAM) => ({
  id: `e${seq}`,
  workspaceId: "ws-test",
  streamId,
  type,
  actor: "test",
  causation: null,
  ts: new Date(NOW).toISOString(),
  payload,
  seq,
});

const runCreated = (definition: Record<string, unknown>): unknown =>
  evt(1, "run.created", {
    definition,
    engineVersion: "v1",
    brief: "",
    grants: [],
    budgets: {},
    parent: null,
  });

const ASK_DEF = {
  streamId: STREAM,
  tools: ["ask_user"],
  maxSteps: 8,
  askWaitMs: 60_000,
};

/** message -> llm.requested -> llm.completed asking the human, the R3 shape. */
function askEvents(definition: Record<string, unknown>, callId = "c1"): unknown[] {
  return [
    runCreated(definition),
    evt(2, "message.received", {
      text: "hi",
      attachments: [],
      surface: "app",
      sender: "ty",
      platformMessageId: "pm-1",
    }),
    evt(3, "llm.requested", { turn: 1, callNo: 1, model: "m1", params: {}, snapshotId: null }),
    evt(4, "llm.completed", {
      turn: 1,
      callNo: 1,
      text: "",
      toolCalls: [{ id: callId, name: "ask_user", args: { prompt: "Which one?" } }],
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.1 },
      finishReason: "tool-calls",
      model: "m1",
    }),
  ];
}

/** The decision's events appended as facts/telemetry from `seq` on. */
function apply(state: readonly unknown[], decision: Decision, from: number): unknown[] {
  return [
    ...state,
    ...decision.events.map((event: Decision["events"][number], index: number) =>
      evt(from + index, event.type, event.payload, event.streamId ?? STREAM)
    ),
  ];
}

const timers = (decision: Decision) => decision.jobs.filter((job) => job.type === "run.timer");

// -- the wait timers ------------------------------------------------------------

test("T1: human.requested queues a run.timer job with runAt = the wait's deadline", () => {
  const state = fold(askEvents({ tools: ["ask_user"], askWaitMs: 60_000 }), {});
  const decision = decideAgent(state, ASK_DEF, NOW);

  const timer = decision.jobs.find((job) => job.type === "run.timer");
  expect(timer).toEqual({
    type: "run.timer",
    key: `${STREAM}:timer:wait:1:c1`,
    streamId: STREAM,
    runAt: NOW + 60_000,
  });
  // the key is the trigger: the deadline of wait:1:c1
  expect(parseTimerTrigger(STREAM, `${STREAM}:timer:wait:1:c1`)).toEqual({
    kind: "wait-deadline",
    waitId: "wait:1:c1",
  });
});

test("T8: a wait with one reminder queues two timers; the firing reminds and leaves the wait open", () => {
  const definition = { tools: ["ask_user"], askWaitMs: 60_000, askReminders: [15_000] };
  const events = askEvents(definition);
  const state = fold(events, {});
  const decision = decideAgent(state, { ...ASK_DEF }, NOW);

  // two timers: the deadline, and the reminder 15 s ahead of it (armed after the rule's own)
  expect(timers(decision).map((job) => job.key)).toEqual([
    `${STREAM}:timer:wait:1:c1`,
    `${STREAM}:timer:wait:1:c1:reminder:0`,
  ]);
  expect(timers(decision).map((job) => job.runAt)).toEqual([NOW + 60_000, NOW + 45_000]);

  // the reminder fires: one telemetry fact-shaped note, no jobs, the human not answered
  const waited = fold(
    [
      ...events,
      evt(5, "human.requested", {
        waitId: "wait:1:c1",
        kind: "answer",
        gated: false,
        prompt: "Which one?",
        deadline: NOW + 60_000,
      }),
    ],
    {}
  );
  const trigger = parseTimerTrigger(STREAM, `${STREAM}:timer:wait:1:c1:reminder:0`);
  const fired = decideTimer(waited, STREAM, trigger as TimerTrigger, NOW + 45_000);
  expect(fired.jobs).toEqual([]);
  expect(fired.events.map((event) => event.type)).toEqual(["run.progress"]);
  expect(fired.events[0]!.payload).toMatchObject({ milestone: "reminder" });

    // and the wait is exactly as open as before the reminder
  const reminded = apply(
    [
      ...events,
      evt(5, "human.requested", {
        waitId: "wait:1:c1",
        kind: "answer",
        gated: false,
        prompt: "Which one?",
        deadline: NOW + 60_000,
      }),
    ],
    fired,
    6
  );
  expect(fold(reminded, {}).status).toBe("waiting");
  expect(fold(reminded, {}).waits.has("wait:1:c1")).toBe(true);
});

// -- the stall watchdog ---------------------------------------------------------

/** A running stream mid-call: llm completed asking for `shell`, the call open. */
function runningEvents(definition: Record<string, unknown>, callId = "c1"): unknown[] {
  return [
    runCreated(definition),
    evt(2, "run.started", { objective: "Run the checks" }),
    evt(3, "llm.requested", { turn: 1, callNo: 1, model: "m1", params: {}, snapshotId: null }),
    evt(4, "llm.completed", {
      turn: 1,
      callNo: 1,
      text: "",
      toolCalls: [{ id: callId, name: "shell", args: {} }],
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.1 },
      finishReason: "tool-calls",
      model: "m1",
    }),
    evt(5, "tool.call", { tool: "shell", summary: "", callId, args: {}, effect: "read" }),
  ];
}

const STALL_DEF = { streamId: STREAM, tools: ["shell"], maxSteps: 8 };

test("watchdog strike one with no progress requeues the lost calls and arms the second check", () => {
  const state = fold(runningEvents({ tools: ["shell"], stallAfterMs: 30_000 }), {});
  expect(state.status).toBe("running");

    const fired = decideTimer(state, STREAM, { kind: "watchdog", armedHead: 5, strike: 1 }, NOW);
  expect(fired.events).toEqual([]);
  expect(fired.jobs).toEqual([
    // the open call's job, under its ordinary key: a live lease dedupes, a lost one returns
    { type: "tool.exec", key: `${STREAM}:c1`, streamId: STREAM },
    // the second check, one stall window later, on the same head
    {
      type: "run.timer",
      key: `${STREAM}:timer:watchdog:h5:s2`,
      streamId: STREAM,
      runAt: NOW + 30_000,
    },
  ]);
});

test("watchdog strike one requeues a requested-but-unanswered model call too", () => {
  const events = [
    runCreated({ tools: [], stallAfterMs: 30_000 }),
    evt(2, "run.started", { objective: "x" }),
    evt(3, "llm.requested", { turn: 1, callNo: 1, model: "m1", params: {}, snapshotId: null }),
    evt(4, "llm.completed", {
      turn: 1,
      callNo: 1,
      text: "step one",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.1 },
      finishReason: "stop",
      model: "m1",
    }),
    evt(5, "llm.requested", { turn: 1, callNo: 2, model: "m1", params: {}, snapshotId: null }),
  ];
  const state = fold(events, {});
  const fired = decideTimer(state, STREAM, { kind: "watchdog", armedHead: 5, strike: 1 }, NOW);
  expect(fired.events).toEqual([]);
  expect(fired.jobs).toEqual([
    { type: "llm.call", key: `${STREAM}:1:llm:2`, streamId: STREAM },
    {
      type: "run.timer",
      key: `${STREAM}:timer:watchdog:h5:s2`,
      streamId: STREAM,
      runAt: NOW + 30_000,
    },
  ]);
});

test("watchdog strike two, still no progress: run.blocked with reason stall", () => {
  const state = fold(runningEvents({ tools: ["shell"], stallAfterMs: 30_000 }), {});
  const fired = decideTimer(state, STREAM, { kind: "watchdog", armedHead: 5, strike: 2 }, NOW);
  expect(fired.jobs).toEqual([]);
  expect(fired.events).toEqual([{ type: "run.blocked", payload: { reason: "stall" }, streamId: undefined }]);
});

test("watchdog with progress since the armed head is a no-op at either strike", () => {
  const events = runningEvents({ tools: ["shell"], stallAfterMs: 30_000 });
  const progressed = fold(
    // a fact after the armed head: the tool result telemetry does not count, a call does
    [
      ...events,
      evt(6, "tool.result", { line: "pong", kind: "term" }),
      evt(7, "tool.call", { tool: "shell", summary: "", callId: "c2", args: {}, effect: "read" }),
    ],
    {}
  );
  for (const strike of [1, 2] as const) {
    const fired = decideTimer(progressed, STREAM, { kind: "watchdog", armedHead: 5, strike }, NOW);
    expect(fired).toEqual({ events: [], jobs: [] });
  }
});

test("watchdog never bites a waiting, idle or terminal stream", () => {
    const waiting = fold(
    [
      ...askEvents({ tools: ["ask_user"], stallAfterMs: 30_000 }),
      evt(5, "human.requested", {
        waitId: "wait:1:c1",
        kind: "answer",
        gated: false,
        prompt: "Which one?",
        deadline: NOW + 60_000,
      }),
    ],
    {}
  );
  expect(waiting.status).toBe("waiting");
  const finished = fold(
    [...runningEvents({ tools: ["shell"], stallAfterMs: 30_000 }), evt(6, "run.finished", { result: "done" })],
    {}
  );
  for (const state of [waiting, finished]) {
    for (const strike of [1, 2] as const) {
      expect(decideTimer(state, STREAM, { kind: "watchdog", armedHead: state.head, strike }, NOW)).toEqual({
        events: [],
        jobs: [],
      });
    }
  }
});

// -- the time budget ------------------------------------------------------------

test("budget: a still-running run at startedAt + timeS blocks with budget_time; a finished one is spared", () => {
  const running = fold(
    [
      runCreated({ tools: [], budget: { timeS: 60 } }),
      evt(2, "run.started", { objective: "x" }),
      evt(3, "llm.requested", { turn: 1, callNo: 1, model: "m1", params: {}, snapshotId: null }),
    ],
    {}
  );
  const fired = decideTimer(running, STREAM, { kind: "budget" }, NOW + 60_000);
  expect(fired.jobs).toEqual([]);
  expect(fired.events).toEqual([
    { type: "run.blocked", payload: { reason: "budget_time" }, streamId: undefined },
  ]);

  const finished = fold(
    [
      runCreated({ tools: [], budget: { timeS: 60 } }),
      evt(2, "run.started", { objective: "x" }),
      evt(3, "llm.requested", { turn: 1, callNo: 1, model: "m1", params: {}, snapshotId: null }),
      evt(4, "llm.completed", {
        turn: 1,
        callNo: 1,
        text: "done",
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.1 },
        finishReason: "stop",
        model: "m1",
      }),
      evt(5, "run.finished", { result: "done", costUsd: 0.1 }),
    ],
    {}
  );
  expect(decideTimer(finished, STREAM, { kind: "budget" }, NOW + 60_000)).toEqual({ events: [], jobs: [] });
});

// -- the arms -------------------------------------------------------------------

test("a running decide on a run with a stall window and a time budget arms both timers", () => {
  const RUN = "run:r1";
  const events = runningEvents({
    tools: ["shell"],
    stallAfterMs: 30_000,
    budget: { timeS: 60 },
  }).map((event) => ({ ...event, streamId: RUN }));
  const state = fold(events, {});
  const decision = decideAgent(state, { ...STALL_DEF, streamId: RUN }, NOW);

  expect(timers(decision).map((job) => job.key)).toEqual([
    `${RUN}:timer:watchdog:h5`,
    `${RUN}:timer:budget`,
  ]);
  expect(timers(decision).map((job) => job.runAt)).toEqual([NOW + 30_000, NOW + 60_000]);
  // the re-arm key is the head: the next fact arms a later timer
  expect(parseTimerTrigger(RUN, `${RUN}:timer:watchdog:h5`)).toEqual({
    kind: "watchdog",
    armedHead: 5,
    strike: 1,
  });
  expect(parseTimerTrigger(RUN, `${RUN}:timer:budget`)).toEqual({ kind: "budget" });
});

test("no timers are armed without the knobs, and none on a waiting stream", () => {
  const bare = fold(askEvents({ tools: ["ask_user"] }), {});
  const asked = decideAgent(bare, ASK_DEF, NOW);
  // the ask's own deadline timer is the only run.timer
  expect(timers(asked)).toHaveLength(1);

  const waiting = fold(
    [
      ...askEvents({ tools: ["ask_user"], stallAfterMs: 30_000 }),
      evt(5, "human.requested", {
        waitId: "wait:1:c1",
        kind: "answer",
        gated: false,
        prompt: "Which one?",
        deadline: NOW + 60_000,
      }),
    ],
    {}
  );
  expect(decideAgent(waiting, { ...ASK_DEF }, NOW).jobs).toEqual([]);
});
