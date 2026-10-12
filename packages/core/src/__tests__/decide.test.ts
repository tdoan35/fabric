// ANY-29 R3 — @fabric/core: the agent loop's decide (docs/RUNTIME.md section 5.1, rules 1-6) and
// the per-turn cost cap. One test per listed case, named by its ID. No describe wrapper, as in the
// sibling suites — Stryker's per-test filter joins suite names with a separator Vitest 5 no longer
// uses (stryker-js#6210); flat `it` names keep the filter working.
import { expect, test } from "vitest";
import { decideAgent, fold } from "../index";
import type { AgentState } from "../index";

const NOW = 1_700_000_000_000;

/** Build an envelope; the stream id is overridable because sessions and runs decide differently. */
function evt(seq: number, type: string, payload: unknown, over: Record<string, unknown> = {}) {
  return {
    id: `e${seq}`,
    workspaceId: "ws-test",
    streamId: "session:s1",
    type,
    actor: "test",
    causation: null,
    ts: "2026-10-12T00:00:00.000Z",
    ...over,
    payload,
    seq,
  };
}

const LLM_REQUESTED = (callNo: number, turn = 1) => ({
  turn,
  callNo,
  model: "m1",
  params: {},
  snapshotId: null,
});

const LLM_COMPLETED = (over: Record<string, unknown>) => ({
  turn: 1,
  callNo: 1,
  text: "",
  toolCalls: [] as unknown[],
  usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
  finishReason: "stop",
  model: "m1",
  ...over,
});

const RUN_CREATED = {
  definition: {},
  engineVersion: "1",
  brief: "",
  grants: [],
  budgets: {},
  parent: null as Record<string, string> | null,
};

/** The session shape; per-case spreads override the knobs. No `parent`: sessions have none. */
const SESSION_DEF = {
  streamId: "session:s1",
  tools: ["shell", "artifacts.write", "ask_user"],
  maxSteps: 8,
  model: "m1",
  askWaitMs: 60_000,
  turnCostCapUsd: null,
  surfaces: ["app", "channel"],
};

/** The run shape: `parent` present (per run.created, null when the API created it) and a budget. */
const RUN_DEF = {
  streamId: "run:r1",
  tools: ["shell"],
  maxSteps: 8,
  model: "m1",
  parent: null as Record<string, string> | null,
  budget: { costUsd: 5 },
};

function decide(events: unknown[], def: Record<string, unknown>) {
  const state: AgentState = fold(events, {});
  return decideAgent(state, def as never, NOW);
}

const USER_MESSAGE = {
  text: "go",
  attachments: [],
  surface: "app",
  sender: "ty",
  platformMessageId: "pm1",
};

test("R3.1: rule 1 cancel closes both open calls as cancelled, then run.stopped; no executor jobs", () => {
  const events = [
    evt(1, "run.created", { ...RUN_CREATED }, { streamId: "run:r1" }),
    evt(2, "run.started", { objective: "x" }, { streamId: "run:r1" }),
    evt(3, "llm.requested", LLM_REQUESTED(1), { streamId: "run:r1" }),
    evt(
      4,
      "llm.completed",
      LLM_COMPLETED({
        toolCalls: [
          { id: "c1", name: "shell", args: {} },
          { id: "c2", name: "shell", args: {} },
        ],
      }),
      { streamId: "run:r1" }
    ),
    evt(5, "tool.call", { tool: "shell", summary: "", callId: "c1", args: {}, effect: "read" }, { streamId: "run:r1" }),
    evt(6, "tool.call", { tool: "shell", summary: "", callId: "c2", args: {}, effect: "read" }, { streamId: "run:r1" }),
    evt(7, "run.cancel_requested", { by: "ty" }, { streamId: "run:r1" }),
  ];
  const decision = decide(events, { ...RUN_DEF });
  expect(decision.events.map((e) => e.type)).toEqual(["tool.completed", "tool.completed", "run.stopped"]);
  expect(decision.events[0].payload).toEqual({ callId: "c1", ok: false, error: "cancelled" });
  expect(decision.events[1].payload).toEqual({ callId: "c2", ok: false, error: "cancelled" });
  expect(decision.events[2].type).toBe("run.stopped");
  expect(decision.jobs).toEqual([]);
});

test("R3.2: rule 1 budget blocks the run with reason budget and queues nothing", () => {
  const events = [
    evt(1, "run.created", { ...RUN_CREATED }, { streamId: "run:r1" }),
    evt(2, "run.started", { objective: "x" }, { streamId: "run:r1" }),
    evt(3, "llm.requested", LLM_REQUESTED(1), { streamId: "run:r1" }),
    evt(
      4,
      "llm.completed",
      LLM_COMPLETED({ usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.6 } }),
      { streamId: "run:r1" }
    ),
  ];
  const decision = decide(events, { ...RUN_DEF, budget: { costUsd: 0.5 } });
  expect(decision.events).toEqual([{ type: "run.blocked", payload: { reason: "budget" } }]);
  expect(decision.jobs).toEqual([]);
});

test("R3.3: the per-turn cap ends the turn with a delegate offer; just under it the turn continues", () => {
  const turn = [
    evt(1, "message.received", USER_MESSAGE),
    evt(2, "llm.requested", LLM_REQUESTED(1)),
    evt(
      3,
      "llm.completed",
      LLM_COMPLETED({
        callNo: 1,
        toolCalls: [{ id: "c1", name: "shell", args: {} }],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.02 },
      })
    ),
    evt(4, "tool.call", { tool: "shell", summary: "", callId: "c1", args: {}, effect: "read" }),
    evt(5, "tool.completed", { callId: "c1", ok: true }),
    evt(6, "llm.requested", LLM_REQUESTED(2)),
    evt(
      7,
      "llm.completed",
      LLM_COMPLETED({
        callNo: 2,
        toolCalls: [{ id: "c2", name: "shell", args: {} }],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.03 },
      })
    ),
    evt(8, "tool.call", { tool: "shell", summary: "", callId: "c2", args: {}, effect: "read" }),
    evt(9, "tool.completed", { callId: "c2", ok: true }),
  ];
  const capped = decide(turn, { ...SESSION_DEF, turnCostCapUsd: 0.05 });
  expect(capped.events).toHaveLength(1);
  expect(capped.events[0].type).toBe("agent.message");
  expect(String((capped.events[0].payload as { text: string }).text)).toMatch(/cap/);
  expect(capped.events.every((e) => e.type !== "llm.requested")).toBe(true);
  expect(capped.jobs.map((j) => j.key)).toEqual([
    "deliver:agent-message:session:s1:1:app",
    "deliver:agent-message:session:s1:1:channel",
  ]);

  const below = decide(turn, { ...SESSION_DEF, turnCostCapUsd: 0.051 });
  expect(below.events).toEqual([
    { type: "llm.requested", payload: { turn: 1, callNo: 3, model: "m1", params: {}, snapshotId: null } },
  ]);
  expect(below.jobs).toEqual([{ type: "llm.call", key: "session:s1:1:llm:3", streamId: "session:s1" }]);
});

test("R3.4: rule 2 routes a denied, an ask and an allowed call from one completion", () => {
  const events = [
    evt(1, "message.received", USER_MESSAGE),
    evt(2, "llm.requested", LLM_REQUESTED(1)),
    evt(
      3,
      "llm.completed",
      LLM_COMPLETED({
        toolCalls: [
          { id: "c1", name: "network.ping", args: {} },
          { id: "c2", name: "ask_user", args: { prompt: "Which one?" } },
          { id: "c3", name: "shell", args: { cmd: "ls" } },
        ],
      })
    ),
  ];
  const decision = decide(events, { ...SESSION_DEF, toolEffects: { shell: "rerunnable" } });
  expect(decision.events.map((e) => e.type)).toEqual(["tool.denied", "human.requested", "tool.call"]);
  expect(decision.events[0].payload).toEqual({
    tool: "network.ping",
    target: "",
    reason: "tool is not in the run's allowlist",
    callId: "c1",
  });
  expect(decision.events[1].payload).toEqual({
    waitId: "wait:1:c2",
    kind: "answer",
    gated: false,
    prompt: "Which one?",
    deadline: NOW + 60_000,
  });
  expect(decision.events[2].payload).toEqual({
    tool: "shell",
    summary: "",
    callId: "c3",
    args: { cmd: "ls" },
    effect: "rerunnable",
  });
  expect(decision.jobs).toEqual([
    { type: "run.timer", key: "session:s1:timer:wait:1:c2", streamId: "session:s1", runAt: NOW + 60_000 },
    { type: "tool.exec", key: "session:s1:c3", streamId: "session:s1" },
  ]);
});

function twoResolvedCalls(): unknown[] {
  return [
    evt(1, "message.received", USER_MESSAGE),
    evt(2, "llm.requested", LLM_REQUESTED(1)),
    evt(3, "llm.completed", LLM_COMPLETED({ callNo: 1, toolCalls: [{ id: "c1", name: "shell", args: {} }] })),
    evt(4, "tool.call", { tool: "shell", summary: "", callId: "c1", args: {}, effect: "read" }),
    evt(5, "tool.completed", { callId: "c1", ok: true }),
    evt(6, "llm.requested", LLM_REQUESTED(2)),
    evt(7, "llm.completed", LLM_COMPLETED({ callNo: 2, toolCalls: [{ id: "c2", name: "shell", args: {} }] })),
    evt(8, "tool.call", { tool: "shell", summary: "", callId: "c2", args: {}, effect: "read" }),
    evt(9, "tool.completed", { callId: "c2", ok: true }),
  ];
}

test("R3.5: rule 3 requests call 3 when every call of the turn has resolved", () => {
  const decision = decide(twoResolvedCalls(), { ...SESSION_DEF });
  expect(decision.events).toEqual([
    { type: "llm.requested", payload: { turn: 1, callNo: 3, model: "m1", params: {}, snapshotId: null } },
  ]);
  expect(decision.jobs).toEqual([{ type: "llm.call", key: "session:s1:1:llm:3", streamId: "session:s1" }]);
});

test("R3.6: at MAX_STEPS with all calls resolved the turn ends without another request", () => {
  const decision = decide(twoResolvedCalls(), { ...SESSION_DEF, maxSteps: 2 });
  expect(decision.events[0].type).toBe("agent.message");
  expect(decision.events.some((e) => e.type === "llm.requested")).toBe(false);
  expect(decision.jobs.map((j) => j.type)).toEqual(["deliver", "deliver"]);
});

test("R3.7: rule 4 on a session copies the reply and delivers to every surface", () => {
  const events = [
    evt(1, "message.received", USER_MESSAGE),
    evt(2, "llm.requested", LLM_REQUESTED(1)),
    evt(3, "llm.completed", LLM_COMPLETED({ text: "All done." })),
  ];
  const decision = decide(events, { ...SESSION_DEF });
  expect(decision.events).toEqual([
    { id: "agent-message:session:s1:1", type: "agent.message", payload: { text: "All done." } },
  ]);
  expect(decision.jobs).toEqual([
    { type: "deliver", key: "deliver:agent-message:session:s1:1:app", streamId: "session:s1" },
    { type: "deliver", key: "deliver:agent-message:session:s1:1:channel", streamId: "session:s1" },
  ]);
});

function finishedRun(parent: Record<string, string> | null): unknown[] {
  return [
    evt(1, "run.created", { ...RUN_CREATED, parent }, { streamId: "run:r1" }),
    evt(2, "run.started", { objective: "x" }, { streamId: "run:r1" }),
    evt(3, "llm.requested", LLM_REQUESTED(1), { streamId: "run:r1" }),
    evt(4, "llm.completed", LLM_COMPLETED({ text: "The result." }), { streamId: "run:r1" }),
  ];
}

test("R3.8: rule 4 on a run finishes it; a parent gets the resolve job, an orphan does not", () => {
  const parented = decide(finishedRun({ runId: "run:parent", callId: "c9" }), {
    ...RUN_DEF,
    parent: { runId: "run:parent", callId: "c9" },
  });
  expect(parented.events).toEqual([{ type: "run.finished", payload: { result: "The result.", costUsd: 0.01 } }]);
  expect(parented.jobs).toEqual([{ type: "delegate.resolve", key: "run:r1:resolve", streamId: "run:r1" }]);

  const orphan = decide(finishedRun(null), { ...RUN_DEF, parent: null });
  expect(orphan.events.map((e) => e.type)).toEqual(["run.finished"]);
  expect(orphan.jobs).toEqual([]);
});

test("R3.9: a retryable failure is retried once; the second one ends the turn with the news", () => {
  const first = [
    evt(1, "message.received", USER_MESSAGE),
    evt(2, "llm.requested", LLM_REQUESTED(1)),
    evt(3, "llm.failed", { turn: 1, callNo: 1, error: "rate limited", retryable: true }),
  ];
  const retried = decide(first, { ...SESSION_DEF });
  expect(retried.events).toEqual([
    { type: "llm.requested", payload: { turn: 1, callNo: 1, model: "m1", params: {}, snapshotId: null } },
  ]);
  expect(retried.jobs).toEqual([{ type: "llm.call", key: "session:s1:1:llm:1", streamId: "session:s1" }]);

  const second = [
    ...first,
    evt(4, "llm.requested", LLM_REQUESTED(1)),
    evt(5, "llm.failed", { turn: 1, callNo: 1, error: "rate limited again", retryable: true }),
  ];
  const ended = decide(second, { ...SESSION_DEF });
  expect(ended.events).toHaveLength(1);
  expect(ended.events[0].type).toBe("agent.message");
  expect(String((ended.events[0].payload as { text: string }).text)).toMatch(/rate limited again/);
  expect(ended.jobs.map((j) => j.type)).toEqual(["deliver", "deliver"]);
});

test("R3.10: a retryable:false failure ends the turn with a narration and no retry", () => {
  const events = [
    evt(1, "message.received", USER_MESSAGE),
    evt(2, "llm.requested", LLM_REQUESTED(1)),
    evt(3, "llm.failed", { turn: 1, callNo: 1, error: "the key is revoked", retryable: false }),
  ];
  const decision = decide(events, { ...SESSION_DEF });
  expect(decision.events).toHaveLength(1);
  expect(decision.events[0].type).toBe("agent.message");
  expect(String((decision.events[0].payload as { text: string }).text)).toMatch(/the key is revoked/);
  expect(decision.events.every((e) => e.type !== "llm.requested")).toBe(true);
  expect(decision.jobs.map((j) => j.type)).toEqual(["deliver", "deliver"]);
});

test("R3.11: rule 6 idle with two pending inputs starts a turn at call 1 of the next turn", () => {
  const events = [
    evt(1, "message.received", USER_MESSAGE),
    evt(2, "human.responded", { waitId: "w1", decision: "yes", by: "ty", surface: "app" }),
  ];
  const state = fold(events, {});
  expect(state.pendingInputs).toHaveLength(2);
  const decision = decideAgent(state, { ...SESSION_DEF } as never, NOW);
  expect(decision.events).toEqual([
    { type: "llm.requested", payload: { turn: 1, callNo: 1, model: "m1", params: {}, snapshotId: null } },
  ]);
  expect(decision.jobs).toEqual([{ type: "llm.call", key: "session:s1:1:llm:1", streamId: "session:s1" }]);
});

test("R3.12: idle with no pending inputs and no open waits decides nothing", () => {
  const state = fold([], {});
  expect(state.status).toBe("idle");
  const decision = decideAgent(state, { ...SESSION_DEF } as never, NOW);
  expect(decision.events).toEqual([]);
  expect(decision.jobs).toEqual([]);
});

test("R3.13: precedence - cancelRequested wins over a resolved batch, so no llm.requested fires", () => {
  const events = [
    evt(1, "message.received", USER_MESSAGE),
    evt(2, "llm.requested", LLM_REQUESTED(1)),
    evt(3, "llm.completed", LLM_COMPLETED({ callNo: 1, toolCalls: [{ id: "c1", name: "shell", args: {} }] })),
    evt(4, "tool.call", { tool: "shell", summary: "", callId: "c1", args: {}, effect: "read" }),
    evt(5, "tool.completed", { callId: "c1", ok: true }),
    evt(6, "run.cancel_requested", { by: "ty" }),
  ];
  const decision = decide(events, { ...SESSION_DEF });
  expect(decision.events.map((e) => e.type)).toEqual(["run.stopped"]);
  expect(decision.events.some((e) => e.type === "llm.requested")).toBe(false);
  expect(decision.jobs).toEqual([]);
});

test("R3.14: purity - the same frozen state decides to the same events and jobs, keys included", () => {
  const events = [
    evt(1, "message.received", USER_MESSAGE),
    evt(2, "llm.requested", LLM_REQUESTED(1)),
    evt(
      3,
      "llm.completed",
      LLM_COMPLETED({
        toolCalls: [
          { id: "c1", name: "ask_user", args: { prompt: "Which?" } },
          { id: "c2", name: "shell", args: { cmd: "ls" } },
        ],
      })
    ),
  ];
  const state: AgentState = fold(events, {});
  const frozen = JSON.parse(
    JSON.stringify({ ...state, openToolCalls: [...state.openToolCalls], waits: [...state.waits] })
  );
  const revived: AgentState = {
    ...(frozen as object),
    openToolCalls: new Map(frozen.openToolCalls),
    waits: new Map(frozen.waits),
  } as AgentState;
  const first = decideAgent(revived, { ...SESSION_DEF, toolEffects: { shell: "read" } } as never, NOW);
  const second = decideAgent(revived, { ...SESSION_DEF, toolEffects: { shell: "read" } } as never, NOW);
  expect(second).toEqual(first);
  expect(first.jobs.map((j) => j.key)).toEqual(["session:s1:timer:wait:1:c1", "session:s1:c2"]);
});

test("R3.15: waiting with an open wait and no new input decides nothing", () => {
    const events = [
      evt(1, "message.received", USER_MESSAGE),
      evt(2, "llm.requested", LLM_REQUESTED(1)),
      evt(
        3,
        "llm.completed",
        LLM_COMPLETED({ toolCalls: [{ id: "c1", name: "ask_user", args: { prompt: "Which?" } }] })
      ),
    ];
    const first = decide(events, { ...SESSION_DEF });
    // re-fold with the human.requested appended, as the append of the first decision would
    const waited = fold(
      [
        ...events,
        evt(4, "human.requested", {
          waitId: "wait:1:c1",
          kind: "answer",
          gated: false,
          prompt: "Which?",
          deadline: NOW + 60_000,
        }),
      ],
      {}
    );
    expect(waited.status).toBe("waiting");
    const second = decideAgent(waited, { ...SESSION_DEF } as never, NOW);
    expect(second.events).toEqual([]);
    expect(second.jobs).toEqual([]);
});
