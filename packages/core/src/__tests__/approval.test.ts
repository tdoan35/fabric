// ANY-74 T3 — @fabric/core: approval gates in decide (docs/ANY-44 D5, PRODUCT §8.3 amended
// 2026-10-13). One test per listed case, named by its ID; flat `test` names as in the sibling
// suites (Stryker's per-test filter). The runtime enforces the approval mode: a gated call
// holds as an `approve` wait until answered or expired, and the session's approval mode folds
// from `session.approval_mode_set`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { decideAgent, eventClass, fold, parseEvent } from "../index";
import type { AgentState } from "../index";

const NOW = 1_700_000_000_000;

function evt(seq: number, type: string, payload: unknown, over: Record<string, unknown> = {}) {
  return {
    id: `e${seq}`,
    workspaceId: "ws-test",
    streamId: "session:s1",
    type,
    actor: "test",
    causation: null,
    ts: "2026-10-13T00:00:00.000Z",
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

const USER_MESSAGE = {
  text: "go",
  attachments: [],
  surface: "app",
  sender: "ty",
  platformMessageId: "pm1",
};

/** The session shape; per-case spreads override the policy knobs. */
const SESSION_DEF = {
  streamId: "session:s1",
  tools: ["write_file", "shell", "send"],
  maxSteps: 8,
  model: "m1",
  askWaitMs: 60_000,
  turnCostCapUsd: null,
  surfaces: ["app"],
};

/** The run shape: `parent` present and a budget, as in decide.test.ts. */
const RUN_DEF = {
  streamId: "run:r1",
  tools: ["write_file"],
  maxSteps: 8,
  model: "m1",
  parent: null as Record<string, string> | null,
  budget: { costUsd: 5 },
};

function decide(events: unknown[], def: Record<string, unknown>, now: number = NOW) {
  const state: AgentState = fold(events, {});
  return decideAgent(state, def as never, now);
}

const WRITE_CALL = { id: "c1", name: "write_file", args: { path: "notes.md" }, summary: "note" };
const SHELL_CALL = { id: "c2", name: "shell", args: { cmd: "ls" }, summary: "list" };

/** The turn under test: one completion carrying the given calls. */
const turnWithCalls = (...calls: Record<string, unknown>[]) => [
  evt(1, "message.received", USER_MESSAGE),
  evt(2, "llm.requested", LLM_REQUESTED(1)),
  evt(3, "llm.completed", LLM_COMPLETED({ toolCalls: calls, finishReason: "tool-calls" })),
];

/** The approve wait rule 2 parks a gated call on, plus overridable fields. */
const approvalWait = (over: Record<string, unknown>) => ({
  waitId: "approve:1:c1",
  kind: "approve",
  gated: false,
  prompt: "Allow write_file: note?",
  deadline: NOW + 60_000,
  approval: { callId: "c1", tool: "write_file", args: { path: "notes.md" }, summary: "note" },
  ...over,
});

const logsDir = fileURLToPath(new URL("../../fixtures/logs/", import.meta.url));

function fixtureLog(base: string): unknown[] {
  return readFileSync(`${logsDir}${base}.jsonl`, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

test("Q1: session.approval_mode_set parses as a fact; human.requested parses with kind approve and an approval payload", () => {
  const mode = parseEvent(evt(1, "session.approval_mode_set", { mode: "full_auto" }));
  expect(mode.payload).toEqual({ mode: "full_auto" });
  expect(mode.class).toBe("fact");
  expect(eventClass("session.approval_mode_set")).toBe("fact");

  const request = parseEvent(
    evt(2, "human.requested", {
      waitId: "approve:1:c1",
      kind: "approve",
      gated: true,
      prompt: "Allow send: greeting?",
      deadline: NOW + 1000,
      approval: { callId: "c1", tool: "send", args: { to: "kim" }, summary: "greeting" },
    })
  );
  expect(request.payload).toEqual({
    waitId: "approve:1:c1",
    kind: "approve",
    gated: true,
    prompt: "Allow send: greeting?",
    deadline: NOW + 1000,
    approval: { callId: "c1", tool: "send", args: { to: "kim" }, summary: "greeting" },
  });
});

test("Q2: fold defaults approvalMode to ask and session.approval_mode_set moves it", () => {
  const plain = fold([evt(1, "message.received", USER_MESSAGE)], {});
  expect(plain.approvalMode).toBe("ask");

  const set = fold(
    [evt(1, "message.received", USER_MESSAGE), evt(2, "session.approval_mode_set", { mode: "full_auto" })],
    {}
  );
  expect(set.approvalMode).toBe("full_auto");
});

test("Q3: no toolPolicy decides every fixture log byte-identically to the pre-T3 loop", () => {
  const pins: Record<string, unknown> = {
    "simple-turn": {
      events: [
        { type: "llm.requested", payload: { turn: 2, callNo: 1, model: "default", params: {}, snapshotId: null } },
      ],
      jobs: [{ type: "llm.call", key: "session:s1:2:llm:1", streamId: "session:s1" }],
    },
    "tool-call-turn": {
      events: [{ type: "run.finished", payload: { result: "Checks finished: one failure.", costUsd: 0.03 } }],
      jobs: [],
    },
    "cancelled-run": { events: [], jobs: [] },
    "wait-and-answer": {
      events: [
        {
          type: "disposition.recorded",
          payload: {
            kind: "direct",
            target: null,
            reason: "derived from the turn's calls",
            considered: [],
            source: "derived",
            turn: 2,
          },
        },
        {
          id: "agent-message:session:s2:2",
          type: "agent.message",
          payload: { text: "Booked. Confirmation is in your calendar." },
        },
      ],
      jobs: [],
    },
    "session-disposition": { events: [], jobs: [] },
  };
  const defs: Record<string, Record<string, unknown>> = {
    "simple-turn": { streamId: "session:s1", tools: [], maxSteps: 8 },
    "tool-call-turn": { streamId: "run:r1", tools: ["shell"], maxSteps: 8, parent: null },
    "cancelled-run": { streamId: "run:r2", tools: ["shell"], maxSteps: 8, parent: null },
    "wait-and-answer": { streamId: "session:s2", tools: ["ask_user"], maxSteps: 8, askWaitMs: 60_000 },
    "session-disposition": { streamId: "session:s3", tools: [], maxSteps: 8 },
  };
  for (const [base, expected] of Object.entries(pins)) {
    const state = fold(fixtureLog(base), { def: { name: "dana" } });
    const decision = decideAgent(state, defs[base] as never, NOW);
    expect(decision, base).toEqual(expected);
  }
});

test("Q4: mode ask gates a mode-covered edit behind an approve wait and its deadline timer, with no tool.call", () => {
  const def = {
    ...SESSION_DEF,
    tools: ["write_file"],
    toolPolicy: { write_file: { access: "allowed", gate: "mode", kind: "edit" } },
  };
  const decision = decide(turnWithCalls(WRITE_CALL), def);
  expect(decision.events).toEqual([{ type: "human.requested", payload: approvalWait({}) }]);
  expect(decision.jobs).toEqual([
    { type: "run.timer", key: "session:s1:timer:approve:1:c1", streamId: "session:s1", runAt: NOW + 60_000 },
  ]);
});

test("Q5: mode auto_edits runs edits at once and still asks commands", () => {
  const def = {
    ...SESSION_DEF,
    toolPolicy: {
      write_file: { access: "allowed", gate: "mode", kind: "edit" },
      shell: { access: "allowed", gate: "mode", kind: "command" },
    },
  };
  const events = [
    evt(1, "message.received", USER_MESSAGE),
    evt(2, "llm.requested", LLM_REQUESTED(1)),
    evt(3, "session.approval_mode_set", { mode: "auto_edits" }),
    evt(4, "llm.completed", LLM_COMPLETED({ toolCalls: [WRITE_CALL, SHELL_CALL], finishReason: "tool-calls" })),
  ];
  const decision = decide(events, def);
  expect(decision.events).toEqual([
    {
      type: "tool.call",
      payload: { tool: "write_file", summary: "note", callId: "c1", args: { path: "notes.md" } },
    },
    {
      type: "human.requested",
      payload: approvalWait({
        waitId: "approve:1:c2",
        prompt: "Allow shell: list?",
        approval: { callId: "c2", tool: "shell", args: { cmd: "ls" }, summary: "list" },
      }),
    },
  ]);
  expect(decision.jobs).toEqual([
    { type: "tool.exec", key: "session:s1:c1", streamId: "session:s1" },
    { type: "run.timer", key: "session:s1:timer:approve:1:c2", streamId: "session:s1", runAt: NOW + 60_000 },
  ]);
});

test("Q6: mode full_auto runs commands but a gate always still asks, flagged gated", () => {
  const def = {
    ...SESSION_DEF,
    toolPolicy: {
      shell: { access: "allowed", gate: "mode", kind: "command" },
      send: { access: "allowed", gate: "always", kind: "external" },
    },
  };
  const sendCall = { id: "c3", name: "send", args: {}, summary: "" };
  const events = [
    evt(1, "message.received", USER_MESSAGE),
    evt(2, "llm.requested", LLM_REQUESTED(1)),
    evt(3, "session.approval_mode_set", { mode: "full_auto" }),
    evt(4, "llm.completed", LLM_COMPLETED({ toolCalls: [SHELL_CALL, sendCall], finishReason: "tool-calls" })),
  ];
  const decision = decide(events, def);
  expect(decision.events.map((event) => event.type)).toEqual(["tool.call", "human.requested"]);
  const asked = decision.events[1]?.payload as Record<string, unknown>;
  expect(asked.waitId).toBe("approve:1:c3");
  expect(asked.gated).toBe(true);
  expect((asked.approval as Record<string, unknown>).tool).toBe("send");
});

test("Q7: approval access asks under every mode, full_auto included", () => {
  const def = {
    ...SESSION_DEF,
    tools: ["publish"],
    toolPolicy: { publish: { access: "approval", gate: "none", kind: "external" } },
  };
  for (const mode of ["ask", "auto_edits", "full_auto"]) {
    const events = [
      evt(1, "message.received", USER_MESSAGE),
      evt(2, "llm.requested", LLM_REQUESTED(1)),
      evt(3, "session.approval_mode_set", { mode }),
      evt(
        4,
        "llm.completed",
        LLM_COMPLETED({ toolCalls: [{ id: "c1", name: "publish", args: {}, summary: "go" }], finishReason: "tool-calls" })
      ),
    ];
    const decision = decide(events, def);
    expect(decision.events.map((event) => event.type)).toEqual(["human.requested"]);
    expect(decision.jobs.map((job) => job.type)).toEqual(["run.timer"]);
  }
});

test("Q8: an approve answer runs the held call under its original callId, effect and exec job", () => {
  const def = { ...SESSION_DEF, tools: ["write_file"], toolEffects: { write_file: "idempotent" } };
  const events = [
    ...turnWithCalls(WRITE_CALL),
    evt(4, "human.requested", approvalWait({})),
    evt(5, "human.responded", { waitId: "approve:1:c1", decision: "approve", by: "ty", surface: "app" }),
  ];
  const decision = decide(events, def);
  expect(decision.events).toEqual([
    {
      type: "tool.call",
      payload: { tool: "write_file", summary: "note", callId: "c1", args: { path: "notes.md" }, effect: "idempotent" },
    },
  ]);
  expect(decision.jobs).toEqual([{ type: "tool.exec", key: "session:s1:c1", streamId: "session:s1" }]);
});

test("Q9: a deny completes the call as declined, and the next decide requests the next model call", () => {
  const def = { ...SESSION_DEF, tools: ["write_file"] };
  const events = [
    ...turnWithCalls(WRITE_CALL),
    evt(4, "human.requested", approvalWait({})),
    evt(5, "human.responded", { waitId: "approve:1:c1", decision: "deny", by: "ty", surface: "app" }),
  ];
  const state: AgentState = fold(events, {});
  const denied = decideAgent(state, def as never, NOW);
  expect(denied.events).toEqual([
    { type: "tool.completed", payload: { callId: "c1", ok: false, error: "declined by the user" } },
  ]);
  expect(denied.jobs).toEqual([]);

  const resumed = fold(
    [...events, evt(6, "tool.completed", { callId: "c1", ok: false, error: "declined by the user" })],
    {}
  );
  const next = decideAgent(resumed, def as never, NOW);
  expect(next.events).toEqual([
    { type: "llm.requested", payload: { turn: 1, callNo: 2, model: "m1", params: {}, snapshotId: null } },
  ]);
  expect(next.jobs).toEqual([{ type: "llm.call", key: "session:s1:1:llm:2", streamId: "session:s1" }]);
});

test("Q10: an approval past its deadline completes as expired on the next decide", () => {
  const def = { ...SESSION_DEF, tools: ["write_file"] };
  const events = [...turnWithCalls(WRITE_CALL), evt(4, "human.requested", approvalWait({ deadline: NOW + 1000 }))];
  const state: AgentState = fold(events, {});
  const expired = decideAgent(state, def as never, NOW + 2000);
  expect(expired.events).toEqual([
    { type: "tool.completed", payload: { callId: "c1", ok: false, error: "approval expired" } },
  ]);
  expect(expired.jobs).toEqual([]);
});

test("Q11: one gated call of two holds the turn: the ungated runs, no model call until the gated resolves", () => {
  const def = {
    ...SESSION_DEF,
    tools: ["shell", "slow_publish"],
    toolPolicy: { slow_publish: { access: "allowed", gate: "mode", kind: "external" } },
  };
  const slowCall = { id: "c3", name: "slow_publish", args: {}, summary: "post" };
  const events = [
    evt(1, "message.received", USER_MESSAGE),
    evt(2, "llm.requested", LLM_REQUESTED(1)),
    evt(3, "llm.completed", LLM_COMPLETED({ toolCalls: [SHELL_CALL, slowCall], finishReason: "tool-calls" })),
  ];
  const decision = decide(events, def);
  expect(decision.events.map((event) => event.type)).toEqual(["tool.call", "human.requested"]);
  expect(decision.jobs.map((job) => job.key)).toEqual(["session:s1:c2", "session:s1:timer:approve:1:c3"]);

  // The ungated call resolves: the held approval still blocks rule 3.
  const partial = fold([...events, evt(4, "tool.completed", { callId: "c2", ok: true, result: "listed" })], {});
  const waiting = decideAgent(partial, def as never, NOW);
  expect(waiting.events).toEqual([]);
  expect(waiting.jobs).toEqual([]);
});

test("Q12: a mode change never retro-approves an open wait; the next call runs under the new mode", () => {
  const def = {
    ...SESSION_DEF,
    tools: ["write_file"],
    toolPolicy: { write_file: { access: "allowed", gate: "mode", kind: "edit" } },
  };
  const events = [
    ...turnWithCalls(WRITE_CALL),
    evt(4, "human.requested", approvalWait({})),
    evt(5, "session.approval_mode_set", { mode: "full_auto" }),
    evt(
      6,
      "llm.completed",
      LLM_COMPLETED({ callNo: 2, toolCalls: [{ id: "c9", name: "write_file", args: {}, summary: "" }], finishReason: "tool-calls" })
    ),
  ];
  const decision = decide(events, def);
  expect(decision.events.map((event) => event.type)).toEqual(["tool.call"]);
  expect((decision.events[0]?.payload as Record<string, unknown>).callId).toBe("c9");
});

test("Q13: a run gates by its own approvalMode, no session fact involved", () => {
  const def = {
    ...RUN_DEF,
    tools: ["write_file"],
    toolPolicy: { write_file: { access: "allowed", gate: "mode", kind: "edit" } },
    approvalMode: "auto_edits",
  };
  const events = [
    evt(1, "run.created", RUN_CREATED, { streamId: "run:r1" }),
    evt(2, "run.started", { objective: "x" }, { streamId: "run:r1" }),
    evt(3, "llm.requested", LLM_REQUESTED(1), { streamId: "run:r1" }),
    evt(4, "llm.completed", LLM_COMPLETED({ toolCalls: [WRITE_CALL], finishReason: "tool-calls" }), {
      streamId: "run:r1",
    }),
  ];
  const state = fold(events, {});
  expect(state.approvalMode).toBe("ask"); // the def carries the run's mode; the fold does not
  const decision = decideAgent(state, def as never, NOW);
  expect(decision.events.map((event) => event.type)).toEqual(["tool.call"]);
  expect(decision.jobs.map((job) => job.type)).toEqual(["tool.exec"]);
});

test("Q14: no double handling - the approve flow's own log decides nothing on replay", () => {
  const def = { ...SESSION_DEF, tools: ["write_file"], toolEffects: { write_file: "idempotent" } };
  const events = [
    ...turnWithCalls(WRITE_CALL),
    evt(4, "human.requested", approvalWait({})),
    evt(5, "human.responded", { waitId: "approve:1:c1", decision: "approve", by: "ty", surface: "app" }),
    evt(6, "tool.call", {
      tool: "write_file",
      summary: "note",
      callId: "c1",
      args: { path: "notes.md" },
      effect: "idempotent",
    }),
  ];
  const state: AgentState = fold(events, {});
  const again = decideAgent(state, def as never, NOW);
  expect(again).toEqual({ events: [], jobs: [] });
});

test("Q15: the approval-gate fixture replays to its state.json with the wait resolved", () => {
  const entries = (map: Map<string, unknown>) =>
    [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const serialise = (state: AgentState) => ({
    ...state,
    openToolCalls: entries(state.openToolCalls),
    waits: entries(state.waits),
  });

  const events = fixtureLog("approval-gate");
  const statePath = `${logsDir}approval-gate.state.json`;
  const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
  const state = fold(events, { def: { name: "dana" } });
  expect(serialise(state)).toEqual(parsed);
  // The fixture walks ask -> approve -> result: the wait resolves and the turn completes.
  expect(state.turn).toBe(1);
  expect(state.calls).toBe(2);
  expect(state.waits.size).toBe(0);
  expect((state.lastFact!!.payload as Record<string, unknown>).text).toContain("note");
});
