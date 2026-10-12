// ANY-30 R4 — @fabric/core: delegation in the agent loop's decide (docs/RUNTIME.md section 5.2
// and the budget half of section 7): the `delegate` branch of rule 2, the deterministic child id,
// the parent's reservation, resolveDelegation, and cancellation across the subtree. One test per
// listed case, named by its ID; flat names as in the sibling suites (stryker-js#6210).
import { expect, test } from "vitest";
import { childRunId, decideAgent, fold, resolveDelegation } from "../index";
import type { AgentState, DecideEvent } from "../index";

const NOW = 1_700_000_000_000;

/** Build an envelope; the stream id is overridable because delegation spans three streams. */
function evt(seq: number, type: string, payload: unknown, over: Record<string, unknown> = {}) {
  return {
    id: `e${seq}`,
    workspaceId: "ws-test",
    streamId: "run:p1",
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

/** The callee registry: the definition snapshot `decide` copies into the child's run.created. */
const AGENTS = {
  senna: { definition: { name: "senna", engine: 2 }, engineVersion: "2", tools: ["b", "c", "d"] },
};

/** A run whose grants are a, b, c plus delegate itself; the callee narrows them to b, c. */
const DELEGATOR = {
  streamId: "run:p1",
  tools: ["a", "b", "c", "delegate"],
  maxSteps: 8,
  model: "m1",
  parent: null as Record<string, string> | null,
  budget: { costUsd: 5 },
  agents: AGENTS,
};

const SESSION_DEF = {
  streamId: "session:s1",
  tools: ["shell"],
  maxSteps: 8,
  model: "m1",
  turnCostCapUsd: null,
  surfaces: ["app"],
};

const DELEGATE_ARGS = { agentId: "senna", mode: "await", brief: "Run the checks.", budgetUsd: 0.5 };

const DELEGATE_CALL = (over: Record<string, unknown>) => ({
  id: "c1",
  name: "delegate",
  args: { ...DELEGATE_ARGS, ...over },
});

function decide(events: unknown[], def: Record<string, unknown> = DELEGATOR) {
  const state = fold(events, {});
  return decideAgent(state, def as never, NOW);
}

/** The decision's events that landed on the parent's own stream, as storable envelopes. */
function parentEnvelopes(decision: { events: DecideEvent[] }, stream: string, from: number): unknown[] {
  return decision.events
    .filter((event) => !event.streamId || event.streamId === stream)
    .map((event, index) => evt(from + index, event.type, event.payload, { streamId: event.streamId ?? stream }));
}

/** A child state that ended the way the last event says, having spent `costUsd`. */
function endedChild(terminal: { type: string; payload: Record<string, unknown> }, costUsd: number): AgentState {
  return fold(
    [
      evt(1, "run.created", { ...RUN_CREATED, parent: { runId: "p1", callId: "c1" } }, { streamId: "run:c" }),
      evt(2, "run.started", { objective: "x" }, { streamId: "run:c" }),
      evt(3, "llm.requested", LLM_REQUESTED(1), { streamId: "run:c" }),
      evt(
        4,
        "llm.completed",
        LLM_COMPLETED({ usage: { inputTokens: 1, outputTokens: 1, costUsd } }),
        { streamId: "run:c" }
      ),
      evt(5, terminal.type, terminal.payload, { streamId: "run:c" }),
    ],
    {}
  );
}

/** A parent run with one open await delegation of 0.5 and 0.10 spent so far. */
function parentWithOpenDelegation(): unknown[] {
  return [
    evt(1, "run.created", { ...RUN_CREATED }, { streamId: "run:p1" }),
    evt(2, "run.started", { objective: "x" }, { streamId: "run:p1" }),
    evt(3, "llm.requested", LLM_REQUESTED(1), { streamId: "run:p1" }),
    evt(
      4,
      "llm.completed",
      LLM_COMPLETED({
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.1 },
        toolCalls: [DELEGATE_CALL({})],
      }),
      { streamId: "run:p1" }
    ),
    evt(
      5,
      "tool.call",
      { tool: "delegate", summary: "", callId: "c1", args: { ...DELEGATE_ARGS }, effect: "idempotent" },
      { streamId: "run:p1" }
    ),
  ];
}

test("R4.1: await delegate emits the parent tool.call, the child run.created on its own stream and a decide job; the call stays open", () => {
  const events = [
    evt(1, "run.created", { ...RUN_CREATED }, { streamId: "run:p1" }),
    evt(2, "run.started", { objective: "x" }, { streamId: "run:p1" }),
    evt(3, "llm.requested", LLM_REQUESTED(1), { streamId: "run:p1" }),
    evt(4, "llm.completed", LLM_COMPLETED({ toolCalls: [DELEGATE_CALL({})] }), { streamId: "run:p1" }),
  ];
  const decision = decide(events);
  const childStream = `run:${childRunId("run:p1", "c1")}`;
  expect(decision.events.map((event) => event.type)).toEqual(["tool.call", "run.created"]);
  expect(decision.events[0].payload).toEqual({
    tool: "delegate",
    summary: "",
    callId: "c1",
    args: { ...DELEGATE_ARGS },
    effect: "idempotent",
  });
  expect(decision.events[1].streamId).toBe(childStream);
  expect(decision.jobs).toEqual([
    { type: "decide", key: `decide:${childStream}`, streamId: childStream },
  ]);
  const after = fold([...events, ...parentEnvelopes(decision, "run:p1", 5)], {});
  expect([...after.openToolCalls.keys()]).toEqual(["c1"]);
});

test("R4.2: childRunId is the same for the same pair and differs when the stream or the call differs", () => {
  const one = childRunId("run:p1", "c1");
  expect(childRunId("run:p1", "c1")).toBe(one);
  expect(childRunId("run:p1", "c2")).not.toBe(one);
  expect(childRunId("run:p2", "c1")).not.toBe(one);
});

test("R4.3: background delegate also completes the call with the child run; the next decide continues the turn", () => {
  const events = [
    evt(1, "run.created", { ...RUN_CREATED }, { streamId: "run:p1" }),
    evt(2, "run.started", { objective: "x" }, { streamId: "run:p1" }),
    evt(3, "llm.requested", LLM_REQUESTED(1), { streamId: "run:p1" }),
    evt(
      4,
      "llm.completed",
      LLM_COMPLETED({ toolCalls: [DELEGATE_CALL({ mode: "background" })] }),
      { streamId: "run:p1" }
    ),
  ];
  const decision = decide(events);
  expect(decision.events.map((event) => event.type)).toEqual(["tool.call", "run.created", "tool.completed"]);
  expect(decision.events[2].payload).toEqual({
    callId: "c1",
    ok: true,
    result: { runId: childRunId("run:p1", "c1") },
  });
  const followup = decide([...events, ...parentEnvelopes(decision, "run:p1", 5)]);
  expect(followup.events.map((event) => event.type)).toEqual(["llm.requested"]);
  expect(followup.events[0].payload).toEqual({ turn: 1, callNo: 2, model: "m1", params: {}, snapshotId: null });
});

test("R4.4: the child's run.created carries definition, engineVersion, brief, grants, budgets and the parent reference", () => {
  const events = [
    evt(1, "run.created", { ...RUN_CREATED }, { streamId: "run:p1" }),
    evt(2, "run.started", { objective: "x" }, { streamId: "run:p1" }),
    evt(3, "llm.requested", LLM_REQUESTED(1), { streamId: "run:p1" }),
    evt(4, "llm.completed", LLM_COMPLETED({ toolCalls: [DELEGATE_CALL({})] }), { streamId: "run:p1" }),
  ];
  const decision = decide(events);
  const created = decision.events.find((event) => event.type === "run.created");
  const payload = created?.payload as Record<string, unknown>;
  expect(payload.definition).toEqual({ name: "senna", engine: 2 });
  expect(payload.engineVersion).toBe("2");
  expect(payload.brief).toBe("Run the checks.");
  expect(payload.grants).toEqual(["b", "c"]);
  expect(payload.budgets).toEqual({ costUsd: 0.5 });
  expect(payload.parent).toEqual({ runId: "p1", callId: "c1" });
  expect(created?.streamId).toBe(`run:${childRunId("run:p1", "c1")}`);
});

test("R4.5: grants parent a,b,c and callee b,c,d intersect to child b,c, in the parent's order", () => {
  const events = [
    evt(1, "run.created", { ...RUN_CREATED }, { streamId: "run:p1" }),
    evt(2, "run.started", { objective: "x" }, { streamId: "run:p1" }),
    evt(3, "llm.requested", LLM_REQUESTED(1), { streamId: "run:p1" }),
    evt(4, "llm.completed", LLM_COMPLETED({ toolCalls: [DELEGATE_CALL({})] }), { streamId: "run:p1" }),
  ];
  const decision = decide(events);
  const created = decision.events.find((event) => event.type === "run.created");
  expect((created?.payload as Record<string, unknown>).grants).toEqual(["b", "c"]);
});

test("R4.6: the delegation reserves its budgetUsd on the parent", () => {
  const events = [
    evt(1, "run.created", { ...RUN_CREATED }, { streamId: "run:p1" }),
    evt(2, "run.started", { objective: "x" }, { streamId: "run:p1" }),
    evt(3, "llm.requested", LLM_REQUESTED(1), { streamId: "run:p1" }),
    evt(4, "llm.completed", LLM_COMPLETED({ toolCalls: [DELEGATE_CALL({})] }), { streamId: "run:p1" }),
  ];
  const decision = decide(events);
  const state = fold([...events, ...parentEnvelopes(decision, "run:p1", 5)], {});
  expect(state.reservedUsd).toBe(0.5);
});

test("R4.7: a delegation above the parent's remaining budget is refused with no child; the exact remainder is accepted", () => {
  const budget = { costUsd: 1 };
  const scenario = (budgetUsd: number) => [
    evt(1, "run.created", { ...RUN_CREATED }, { streamId: "run:p1" }),
    evt(2, "run.started", { objective: "x" }, { streamId: "run:p1" }),
    evt(3, "llm.requested", LLM_REQUESTED(1), { streamId: "run:p1" }),
    evt(
      4,
      "llm.completed",
      LLM_COMPLETED({
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.69 },
        toolCalls: [DELEGATE_CALL({ mode: "background", budgetUsd: 0.2 })],
      }),
      { streamId: "run:p1" }
    ),
    evt(
      5,
      "tool.call",
      { tool: "delegate", summary: "", callId: "c0", args: { ...DELEGATE_ARGS, mode: "background", budgetUsd: 0.2 }, effect: "idempotent" },
      { streamId: "run:p1" }
    ),
    evt(6, "tool.completed", { callId: "c0", ok: true, result: { runId: childRunId("run:p1", "c0") } }, {
      streamId: "run:p1",
    }),
    evt(7, "llm.requested", LLM_REQUESTED(2), { streamId: "run:p1" }),
    evt(
      8,
      "llm.completed",
      LLM_COMPLETED({ callNo: 2, usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 }, toolCalls: [DELEGATE_CALL({ budgetUsd })] }),
      { streamId: "run:p1" }
    ),
  ];
  const def = { ...DELEGATOR, budget };
  const refused = decide(scenario(0.2), def);
    expect(refused.events).toEqual([
      { type: "tool.completed", payload: { callId: "c1", ok: false, error: "insufficient budget" } },
    ]);
  expect(refused.jobs).toEqual([]);
  const accepted = decide(scenario(0.1), def);
  expect(accepted.events.map((event) => event.type)).toEqual(["tool.call", "run.created"]);
});

test("R4.8: await resolve completes the parent's call with the child's result; the fold releases the reservation and takes the cost", () => {
  const child = endedChild({ type: "run.finished", payload: { result: "ta-da" } }, 0.15);
  const decision = resolveDelegation({ childRunId: "child-8", callId: "c1", state: child }, "await");
  expect(decision.events).toEqual([
    { type: "tool.completed", payload: { callId: "c1", ok: true, result: { result: "ta-da", costUsd: 0.15 } } },
  ]);
  expect(decision.jobs).toEqual([]);
  const parent = parentWithOpenDelegation();
  const before = fold(parent, {});
  expect(before.reservedUsd).toBe(0.5);
  expect(before.costUsd).toBe(0.1);
  const after = fold([...parent, ...decision.events.map((event, index) => evt(6 + index, event.type, event.payload))], {});
  expect(after.reservedUsd).toBe(0);
  expect(after.costUsd).toBe(0.25);
});

test("R4.9: background resolve reports a delegation.result; an idle session takes it as a pending input and starts a turn", () => {
  const child = endedChild({ type: "run.finished", payload: { result: "ta-da" } }, 0.15);
  const decision = resolveDelegation({ childRunId: "child-9", callId: "c1", state: child }, "background");
  expect(decision.events).toEqual([
    {
      type: "delegation.result",
      payload: { childRunId: "child-9", outcome: "done", summary: "", output: "ta-da", costUsd: 0.15 },
    },
  ]);
  const asEvent = (seq: number, event: DecideEvent, streamId: string) =>
    evt(seq, event.type, event.payload, { streamId });
  const session = fold(
    [
      evt(1, "message.received", { text: "go", attachments: [], surface: "app", sender: "ty", platformMessageId: "pm1" }, {
        streamId: "session:s1",
      }),
      evt(2, "llm.requested", LLM_REQUESTED(1), { streamId: "session:s1" }),
      evt(3, "llm.completed", LLM_COMPLETED({}), { streamId: "session:s1" }),
      asEvent(4, decision.events[0], "session:s1"),
    ],
    {}
  );
  expect(session.status).toBe("idle");
  expect(session.pendingInputs).toEqual([
    { type: "delegation.result", payload: { childRunId: "child-9", outcome: "done", summary: "", output: "ta-da", costUsd: 0.15 } },
  ]);
  const next = decideAgent(session, SESSION_DEF as never, NOW);
  expect(next.events[0].type).toBe("llm.requested");
  expect((next.events[0].payload as Record<string, unknown>).turn).toBe(2);
  expect((next.events[0].payload as Record<string, unknown>).callNo).toBe(1);
});

test("R4.10: a blocked or stopped child resolves as ok false with its reason (await) or the outcome (background)", () => {
  const blocked = endedChild({ type: "run.blocked", payload: { reason: "waiting on approval" } }, 0.02);
  const stopped = endedChild({ type: "run.stopped", payload: { by: "ty", text: "No longer needed." } }, 0.02);
  const awaitBlocked = resolveDelegation({ childRunId: "cb", callId: "c1", state: blocked }, "await");
  expect(awaitBlocked.events).toEqual([
    { type: "tool.completed", payload: { callId: "c1", ok: false, error: "waiting on approval" } },
  ]);
  const awaitStopped = resolveDelegation({ childRunId: "cs", callId: "c1", state: stopped }, "await");
  expect(awaitStopped.events).toEqual([
    { type: "tool.completed", payload: { callId: "c1", ok: false, error: "No longer needed." } },
  ]);
  const backgroundBlocked = resolveDelegation({ childRunId: "cb", callId: "c1", state: blocked }, "background");
  expect(backgroundBlocked.events).toEqual([
    {
      type: "delegation.result",
      payload: { childRunId: "cb", outcome: "blocked", summary: "waiting on approval", costUsd: 0.02 },
    },
  ]);
  const backgroundStopped = resolveDelegation({ childRunId: "cs", callId: "c1", state: stopped }, "background");
  expect(backgroundStopped.events).toEqual([
    {
      type: "delegation.result",
      payload: { childRunId: "cs", outcome: "stopped", summary: "No longer needed.", costUsd: 0.02 },
    },
  ]);
});

test("R4.11: cancelling a parent with two open delegations requests cancellation on both children, then closes the calls and stops", () => {
  const events = [
    evt(1, "run.created", { ...RUN_CREATED }, { streamId: "run:p1" }),
    evt(2, "run.started", { objective: "x" }, { streamId: "run:p1" }),
    evt(3, "llm.requested", LLM_REQUESTED(1), { streamId: "run:p1" }),
    evt(
      4,
      "llm.completed",
      LLM_COMPLETED({
        toolCalls: [DELEGATE_CALL({ budgetUsd: 0.5 }), DELEGATE_CALL({ id: "c2", budgetUsd: 0.3 })],
      }),
      { streamId: "run:p1" }
    ),
    evt(5, "tool.call", { tool: "delegate", summary: "", callId: "c1", args: { ...DELEGATE_ARGS }, effect: "idempotent" }, {
      streamId: "run:p1",
    }),
    evt(
      6,
      "tool.call",
      { tool: "delegate", summary: "", callId: "c2", args: { ...DELEGATE_ARGS, budgetUsd: 0.3 }, effect: "idempotent" },
      { streamId: "run:p1" }
    ),
    evt(7, "run.cancel_requested", { by: "ty" }, { streamId: "run:p1" }),
  ];
  const decision = decide(events);
  const child1 = `run:${childRunId("run:p1", "c1")}`;
  const child2 = `run:${childRunId("run:p1", "c2")}`;
  expect(decision.events.map((event) => [event.type, event.streamId ?? "run:p1"])).toEqual([
    ["run.cancel_requested", child1],
    ["run.cancel_requested", child2],
    ["tool.completed", "run:p1"],
    ["tool.completed", "run:p1"],
    ["run.stopped", "run:p1"],
  ]);
  expect(decision.events[0].payload).toEqual({ by: "parent" });
  expect(decision.events[1].payload).toEqual({ by: "parent" });
  expect(decision.events[2].payload).toEqual({ callId: "c1", ok: false, error: "cancelled" });
  expect(decision.events[3].payload).toEqual({ callId: "c2", ok: false, error: "cancelled" });
  expect(decision.events[4].payload).toEqual({ by: "decide", text: "Cancellation requested." });
  expect(decision.jobs).toEqual([]);
});

test("R4.12: deciding twice on the same state yields one childRunId and the identical run.created", () => {
  const events = [
    evt(1, "run.created", { ...RUN_CREATED }, { streamId: "run:p1" }),
    evt(2, "run.started", { objective: "x" }, { streamId: "run:p1" }),
    evt(3, "llm.requested", LLM_REQUESTED(1), { streamId: "run:p1" }),
    evt(4, "llm.completed", LLM_COMPLETED({ toolCalls: [DELEGATE_CALL({})] }), { streamId: "run:p1" }),
  ];
  const state = fold(events, {});
  const first = decideAgent(state, DELEGATOR as never, NOW);
  const second = decideAgent(state, DELEGATOR as never, NOW);
  expect(second).toEqual(first);
  const created = first.events.filter((event) => event.type === "run.created");
    expect(created).toHaveLength(1);
  expect(created[0].streamId).toBe(`run:${childRunId("run:p1", "c1")}`);
});

test("R4.13: delegating to an agent outside the registry fails the call and creates no child", () => {
  const events = [
    evt(1, "run.created", { ...RUN_CREATED }, { streamId: "run:p1" }),
    evt(2, "run.started", { objective: "x" }, { streamId: "run:p1" }),
    evt(3, "llm.requested", LLM_REQUESTED(1), { streamId: "run:p1" }),
    evt(
      4,
      "llm.completed",
      LLM_COMPLETED({ toolCalls: [DELEGATE_CALL({ agentId: "ghost" })] }),
      { streamId: "run:p1" }
    ),
  ];
  const decision = decide(events, { ...DELEGATOR, agents: {} });
  expect(decision.events).toEqual([
    { type: "tool.completed", payload: { callId: "c1", ok: false, error: "unknown agent: ghost" } },
  ]);
  expect(decision.jobs).toEqual([]);
});
