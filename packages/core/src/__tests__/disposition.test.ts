// ANY-51 S2 — @fabric/core: session facts and routing dispositions in fold and decide
// (PRODUCT section 2.1/4). One test per listed case, named by its ID; flat `it`/`test`
// names, as in the sibling suites (Stryker's per-test filter, stryker-js#6210).
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { decideAgent, EVENT_PAYLOAD_SCHEMAS, EVENT_CLASSES, fold } from "../index";
import type { AgentState } from "../index";

const NOW = 1_700_000_000_000;

/** Build an envelope; the stream id is overridable for the run-side cases. */
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

/** A `record_disposition` tool call; the args the model supplies. */
const RD_CALL = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  name: "record_disposition",
  args: { kind: "direct", target: null, reason: "answer directly", considered: ["team:ops"], ...over },
});

/** A model `disposition.recorded` fact; the payload decide appends for the call above. */
const RD_EVENT = (over: Record<string, unknown> = {}) => ({
  kind: "direct",
  target: null,
  reason: "answer directly",
  considered: ["team:ops"],
  source: "model",
  turn: 1,
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
  tools: ["shell", "propose_team", "handoff_to_team"],
  maxSteps: 8,
  model: "m1",
  askWaitMs: 60_000,
  turnCostCapUsd: null,
  surfaces: ["app", "channel"],
};

const AGENTS = {
  sub: { definition: {}, engineVersion: "1", tools: [] },
};

/** The run shape: `parent` present and a budget; `record_disposition` is an ordinary tool here. */
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

/** A turn whose calls have resolved, ready to end: message, call 1 with `calls`, call 2 bare. */
function turnEndingWith(one: unknown): unknown[] {
  return [
    evt(1, "message.received", USER_MESSAGE),
    evt(2, "llm.requested", LLM_REQUESTED(1)),
    evt(3, "llm.completed", LLM_COMPLETED({ toolCalls: [one] })),
    evt(4, "tool.call", {
      tool: (one as { name: string }).name,
      summary: "",
      callId: (one as { id: string }).id,
      args: (one as { args: object }).args,
      effect: "read",
    }),
    evt(5, "tool.completed", { callId: (one as { id: string }).id, ok: true }),
    evt(6, "llm.requested", LLM_REQUESTED(2)),
    evt(7, "llm.completed", LLM_COMPLETED({ callNo: 2, text: "Done." })),
  ];
}

test("D1: disposition.recorded parses with considered, source, turn and rejects one without source; session.created parses; both are facts", () => {
  const disposition = EVENT_PAYLOAD_SCHEMAS["disposition.recorded"];
  const parsed = disposition.parse({
    kind: "team",
    target: "ops",
    reason: "routed",
    considered: ["agent:sub"],
    source: "model",
    turn: 3,
  });
  expect(parsed).toEqual({
    kind: "team",
    target: "ops",
    reason: "routed",
    considered: ["agent:sub"],
    source: "model",
    turn: 3,
  });
  expect(() =>
    disposition.parse({ kind: "direct", target: null, reason: "r", considered: [], turn: 1 })
  ).toThrow();

  const created = EVENT_PAYLOAD_SCHEMAS["session.created"];
  expect(created).toBeDefined();
  expect(created.parse({ agentId: "dana", incognito: false, surfaces: ["app", "channel"] })).toEqual({
    agentId: "dana",
    incognito: false,
    surfaces: ["app", "channel"],
  });

  expect(EVENT_CLASSES["disposition.recorded"]).toBe("fact");
  expect(EVENT_CLASSES["session.created"]).toBe("fact");
});

test("D2: fold - session.created sets state.session; a run log and a session log without it fold to null", () => {
  const session = fold(
    [
      evt(1, "session.created", { agentId: "dana", incognito: true, surfaces: ["app"] }),
      evt(2, "message.received", USER_MESSAGE),
    ],
    {}
  );
  expect(session.session).toEqual({ agentId: "dana", incognito: true });

  const run = fold(
    [evt(1, "run.created", { ...RUN_CREATED }, { streamId: "run:r1" }), evt(2, "run.started", { objective: "x" }, { streamId: "run:r1" })],
    {}
  );
  expect(run.session).toBeNull();

  const bare = fold([evt(1, "message.received", USER_MESSAGE)], {});
  expect(bare.session).toBeNull();
});

test("D3: fold - disposition.recorded leaves lastFact at the llm.completed and sets turnDisposition; the next turn start resets it", () => {
  const events = [
    evt(1, "message.received", USER_MESSAGE),
    evt(2, "llm.requested", LLM_REQUESTED(1)),
    evt(3, "llm.completed", LLM_COMPLETED({ text: "halfway" })),
    evt(4, "disposition.recorded", RD_EVENT()),
  ];
  const state = fold(events, {});
  expect(state.lastFact).toEqual({ type: "llm.completed", payload: LLM_COMPLETED({ text: "halfway" }) });
  expect(state.turnDisposition).toBe(true);

  const nextTurn = fold(
    [...events, evt(5, "llm.requested", LLM_REQUESTED(1, 2))],
    {}
  );
  expect(nextTurn.turnDisposition).toBe(false);
});

test("D4: record_disposition with text and no other call ends the turn - disposition, its completion, the reply, nothing else", () => {
  const events = [
    evt(1, "message.received", USER_MESSAGE),
    evt(2, "llm.requested", LLM_REQUESTED(1)),
    evt(3, "llm.completed", LLM_COMPLETED({ text: "Done.", toolCalls: [RD_CALL()] })),
  ];
  const decision = decide(events, { ...SESSION_DEF });
  expect(decision.events).toEqual([
    { type: "disposition.recorded", payload: RD_EVENT() },
    { type: "tool.completed", payload: { callId: "c1", ok: true } },
    { id: "agent-message:session:s1:1", type: "agent.message", payload: { text: "Done." } },
  ]);
  expect(decision.jobs).toEqual([
    { type: "deliver", key: "deliver:agent-message:session:s1:1:app", streamId: "session:s1" },
    { type: "deliver", key: "deliver:agent-message:session:s1:1:channel", streamId: "session:s1" },
  ]);
});

test("D5: record_disposition as the only call without text keeps the turn - the next call is requested", () => {
  const events = [
    evt(1, "message.received", USER_MESSAGE),
    evt(2, "llm.requested", LLM_REQUESTED(1)),
    evt(3, "llm.completed", LLM_COMPLETED({ text: "", toolCalls: [RD_CALL()] })),
  ];
  const decision = decide(events, { ...SESSION_DEF });
  expect(decision.events).toEqual([
    { type: "disposition.recorded", payload: RD_EVENT() },
    { type: "tool.completed", payload: { callId: "c1", ok: true } },
    { type: "llm.requested", payload: { turn: 1, callNo: 2, model: "m1", params: {}, snapshotId: null } },
  ]);
  expect(decision.jobs).toEqual([{ type: "llm.call", key: "session:s1:1:llm:2", streamId: "session:s1" }]);
});

test("D6: record_disposition beside a real tool routes the tool; the next call follows once it resolves", () => {
  const events = [
    evt(1, "message.received", USER_MESSAGE),
    evt(2, "llm.requested", LLM_REQUESTED(1)),
    evt(3, "llm.completed", LLM_COMPLETED({ text: "", toolCalls: [RD_CALL(), { id: "c2", name: "shell", args: {} }] })),
  ];
  const first = decide(events, { ...SESSION_DEF });
  expect(first.events.map((e) => e.type)).toEqual([
    "disposition.recorded",
    "tool.completed",
    "tool.call",
  ]);
  expect(first.events[2]!.payload).toEqual({
    tool: "shell",
    summary: "",
    callId: "c2",
    args: {},
    effect: undefined,
  });
  expect(first.jobs.map((j) => j.type)).toEqual(["tool.exec"]);

  const after = fold(
    [
      ...events,
      evt(4, "disposition.recorded", (first.events[0] as { payload: object }).payload),
      evt(5, "tool.completed", { callId: "c1", ok: true }),
      evt(6, "tool.call", { tool: "shell", summary: "", callId: "c2", args: {}, effect: undefined }),
      evt(7, "tool.completed", { callId: "c2", ok: true }),
    ],
    {}
  );
  const second = decideAgent(after, { ...SESSION_DEF } as never, NOW);
  expect(second.events).toEqual([
    { type: "llm.requested", payload: { turn: 1, callNo: 2, model: "m1", params: {}, snapshotId: null } },
  ]);
  expect(second.jobs).toEqual([{ type: "llm.call", key: "session:s1:1:llm:2", streamId: "session:s1" }]);
});

test("D7: a turn that ends without a disposition gets the derived direct one, ahead of the reply", () => {
  const events = [
    evt(1, "message.received", USER_MESSAGE),
    evt(2, "llm.requested", LLM_REQUESTED(1)),
    evt(3, "llm.completed", LLM_COMPLETED({ text: "plain answer" })),
  ];
  const decision = decide(events, { ...SESSION_DEF });
  expect(decision.events).toEqual([
    {
      type: "disposition.recorded",
      payload: { kind: "direct", target: null, reason: "derived from the turn's calls", considered: [], source: "derived", turn: 1 },
    },
    { id: "agent-message:session:s1:1", type: "agent.message", payload: { text: "plain answer" } },
  ]);
});

test("D8: the derived kind follows the turn's calls by precedence", () => {
  const endsWith = (one: unknown, between: unknown[]) => {
    const calls = Array.isArray(one) ? one : [one];
    const base = [
      evt(1, "message.received", USER_MESSAGE),
      evt(2, "llm.requested", LLM_REQUESTED(1)),
      evt(3, "llm.completed", LLM_COMPLETED({ toolCalls: calls })),
      ...between,
      evt(4 + between.length, "llm.requested", LLM_REQUESTED(2)),
      evt(5 + between.length, "llm.completed", LLM_COMPLETED({ callNo: 2, text: "Done." })),
    ];
    return decide(base, { ...SESSION_DEF, agents: AGENTS });
  };
  const dispositionOf = (decision: { events: { type: string; payload: unknown }[] }) =>
    decision.events.find((e) => e.type === "disposition.recorded")?.payload;

  // delegate with teamId beats everything: team, target the teamId
  expect(
    dispositionOf(
      endsWith({ id: "c1", name: "delegate", args: { agentId: "sub", teamId: "ops", mode: "background" } }, [
        evt(4, "tool.call", {
          tool: "delegate",
          summary: "",
          callId: "c1",
          args: { agentId: "sub", teamId: "ops", mode: "background" },
          effect: "idempotent",
        }),
        evt(5, "tool.completed", { callId: "c1", ok: true, result: { runId: "d-1" } }),
      ])
    )
  ).toEqual({ kind: "team", target: "ops", reason: "derived from the turn's calls", considered: [], source: "derived", turn: 1 });

  // a plain delegate: agent, target the agentId
  expect(
    dispositionOf(
      endsWith({ id: "c1", name: "delegate", args: { agentId: "sub", mode: "background" } }, [
        evt(4, "tool.call", {
          tool: "delegate",
          summary: "",
          callId: "c1",
          args: { agentId: "sub", mode: "background" },
          effect: "idempotent",
        }),
        evt(5, "tool.completed", { callId: "c1", ok: true, result: { runId: "d-1" } }),
      ])
    )
  ).toEqual({ kind: "agent", target: "sub", reason: "derived from the turn's calls", considered: [], source: "derived", turn: 1 });

  // propose_-prefixed tools: propose
  expect(
    dispositionOf(
      endsWith({ id: "c1", name: "propose_team", args: {} }, [
        evt(4, "tool.call", { tool: "propose_team", summary: "", callId: "c1", args: {}, effect: "read" }),
        evt(5, "tool.completed", { callId: "c1", ok: true }),
      ])
    )
  ).toEqual({ kind: "propose", target: null, reason: "derived from the turn's calls", considered: [], source: "derived", turn: 1 });

  // ask_user: clarify
  expect(
    dispositionOf(
      endsWith({ id: "c1", name: "ask_user", args: { prompt: "Which?" } }, [
        evt(4, "human.requested", {
          waitId: "wait:1:c1",
          kind: "answer",
          gated: false,
          prompt: "Which?",
          deadline: NOW + 60_000,
        }),
      ])
    )
  ).toEqual({ kind: "clarify", target: null, reason: "derived from the turn's calls", considered: [], source: "derived", turn: 1 });

  // delegate and ask_user in one turn: the delegate's rank wins
  expect(
    dispositionOf(
      endsWith(
        [
          { id: "c1", name: "delegate", args: { agentId: "sub", mode: "background" } },
          { id: "c2", name: "ask_user", args: { prompt: "Which?" } },
        ],
        [
          evt(4, "tool.call", {
            tool: "delegate",
            summary: "",
            callId: "c1",
            args: { agentId: "sub", mode: "background" },
            effect: "idempotent",
          }),
          evt(5, "tool.completed", { callId: "c1", ok: true, result: { runId: "d-1" } }),
          evt(6, "human.requested", {
            waitId: "wait:1:c2",
            kind: "answer",
            gated: false,
            prompt: "Which?",
            deadline: NOW + 60_000,
          }),
        ]
      )
    )
  ).toEqual({ kind: "agent", target: "sub", reason: "derived from the turn's calls", considered: [], source: "derived", turn: 1 });
});

test("D9: one disposition per turn - the model's suppresses the derived one and a second call is answered ok:false", () => {
  const events = [
    evt(1, "message.received", USER_MESSAGE),
    evt(2, "llm.requested", LLM_REQUESTED(1)),
    // call 1 records without text: the turn continues
    evt(3, "llm.completed", LLM_COMPLETED({ text: "", toolCalls: [RD_CALL()] })),
    evt(4, "disposition.recorded", RD_EVENT()),
    evt(5, "tool.completed", { callId: "c1", ok: true }),
    // call 2 records again, with text: answered, not re-recorded, and the turn ends
    evt(6, "llm.requested", LLM_REQUESTED(2)),
    evt(7, "llm.completed", LLM_COMPLETED({ callNo: 2, text: "final", toolCalls: [RD_CALL()] })),
  ];
  const decision = decide(events, { ...SESSION_DEF });
  expect(decision.events).toEqual([
    { type: "tool.completed", payload: { callId: "c1", ok: false, error: "disposition already recorded" } },
    { id: "agent-message:session:s1:1", type: "agent.message", payload: { text: "final" } },
  ]);
  const kinds = decision.events
    .filter((e) => e.type === "disposition.recorded")
    .map((e) => (e.payload as { source: string }).source);
  expect(kinds).toEqual([]); // the call 1 disposition stands; no derived and no second model one
});

test("D10: userChosenAgent makes the fallback direct at that agent, sourced user", () => {
  const events = [
    evt(1, "message.received", USER_MESSAGE),
    evt(2, "llm.requested", LLM_REQUESTED(1)),
    evt(3, "llm.completed", LLM_COMPLETED({ text: "Done." })),
  ];
  const decision = decide(events, { ...SESSION_DEF, userChosenAgent: "researcher" });
  expect(decision.events).toEqual([
    {
      type: "disposition.recorded",
      payload: { kind: "direct", target: "researcher", reason: "chosen by the user", considered: [], source: "user", turn: 1 },
    },
    { id: "agent-message:session:s1:1", type: "agent.message", payload: { text: "Done." } },
  ]);
});

test("D11: a run never records a disposition and denies record_disposition outside its tools", () => {
  const events = [
    evt(1, "run.created", { ...RUN_CREATED }, { streamId: "run:r1" }),
    evt(2, "run.started", { objective: "x" }, { streamId: "run:r1" }),
    evt(3, "llm.requested", LLM_REQUESTED(1), { streamId: "run:r1" }),
    evt(4, "llm.completed", LLM_COMPLETED({ toolCalls: [RD_CALL()] }), { streamId: "run:r1" }),
  ];
  const denied = decide(events, { ...RUN_DEF });
  expect(denied.events).toEqual([
    {
      type: "tool.denied",
      payload: { tool: "record_disposition", target: "", reason: "tool is not in the run's allowlist", callId: "c1" },
    },
  ]);
  // The run carries the S2 fields too: no session, no disposition standing.
  const runState = fold(events, {});
  expect(runState.session).toBeNull();
  expect(runState.turnDisposition).toBe(false);

  const ending = [
    ...events,
    evt(5, "llm.requested", LLM_REQUESTED(2), { streamId: "run:r1" }),
    evt(6, "llm.completed", LLM_COMPLETED({ callNo: 2, text: "The result." }), { streamId: "run:r1" }),
  ];
  const finished = decide(ending, { ...RUN_DEF });
  expect(finished.events.map((e) => e.type)).toEqual(["run.finished"]);
});

test("D12: no double ending - the re-decide after the D4 turn is silent", () => {
  const base = [
    evt(1, "message.received", USER_MESSAGE),
    evt(2, "llm.requested", LLM_REQUESTED(1)),
    evt(3, "llm.completed", LLM_COMPLETED({ text: "Done.", toolCalls: [RD_CALL()] })),
  ];
  const first = decide(base, { ...SESSION_DEF });
  const appended = [
    ...base,
    evt(4, "disposition.recorded", (first.events[0] as { payload: object }).payload),
    evt(5, "tool.completed", { callId: "c1", ok: true }),
    evt(6, "agent.message", { text: "Done." }),
  ];
  const state = fold(appended, {});
  expect(decideAgent(state, { ...SESSION_DEF } as never, NOW)).toEqual({ events: [], jobs: [] });
});

test("D13: the cost-cap and the failed-call endings each derive their disposition before the reply", () => {
  const cappedTurn = [
    evt(1, "message.received", USER_MESSAGE),
    evt(2, "llm.requested", LLM_REQUESTED(1)),
    evt(3, "llm.completed", LLM_COMPLETED({ toolCalls: [{ id: "c1", name: "shell", args: {} }] })),
    evt(4, "tool.call", { tool: "shell", summary: "", callId: "c1", args: {}, effect: "read" }),
    evt(5, "tool.completed", { callId: "c1", ok: true }),
  ];
  const capped = decide(cappedTurn, { ...SESSION_DEF, turnCostCapUsd: 0.01 });
  expect(capped.events.map((e) => e.type)).toEqual(["disposition.recorded", "agent.message"]);
  expect((capped.events[0] as { payload: Record<string, unknown> }).payload).toMatchObject({
    kind: "direct",
    source: "derived",
  });

  const failed = [
    evt(1, "message.received", USER_MESSAGE),
    evt(2, "llm.requested", LLM_REQUESTED(1)),
    evt(3, "llm.failed", { turn: 1, callNo: 1, error: "the key is revoked", retryable: false }),
  ];
  const ended = decide(failed, { ...SESSION_DEF });
  expect(ended.events.map((e) => e.type)).toEqual(["disposition.recorded", "agent.message"]);
  expect((ended.events[0] as { payload: Record<string, unknown> }).payload).toMatchObject({
    kind: "direct",
    source: "derived",
  });
});

test("D16: a mapped tool counts at its mapped kind and target", () => {
  const events = turnEndingWith({ id: "c1", name: "handoff_to_team", args: { teamId: "t1" } });
  const def = {
    ...SESSION_DEF,
    dispositionKinds: { handoff_to_team: { kind: "team", targetArg: "teamId" } },
  };
  const decision = decide(events, def);
  expect(decision.events).toEqual([
    {
      type: "disposition.recorded",
      payload: { kind: "team", target: "t1", reason: "derived from the turn's calls", considered: [], source: "derived", turn: 1 },
    },
    { id: "agent-message:session:s1:1", type: "agent.message", payload: { text: "Done." } },
  ]);
});

test("D15: a proposal decision on an idle session is a pending input and starts the next turn", () => {
  const events = [
    evt(1, "session.created", { agentId: "dana", incognito: false, surfaces: ["app"] }),
    evt(2, "message.received", USER_MESSAGE),
    evt(3, "llm.requested", LLM_REQUESTED(1)),
    evt(4, "llm.completed", LLM_COMPLETED({ text: "Done." })),
    evt(5, "disposition.recorded", RD_EVENT()),
    evt(6, "agent.message", { text: "Done." }),
    evt(7, "proposal.decided", { kind: "agent", decision: "approved", by: "ty" }),
  ];
  const state = fold(events, {});
  expect(state.status).toBe("idle");
  expect(state.pendingInputs).toEqual([
    { type: "proposal.decided", payload: { kind: "agent", decision: "approved", by: "ty" } },
  ]);
  const decision = decideAgent(state, { ...SESSION_DEF } as never, NOW);
  expect(decision.events).toEqual([
    { type: "llm.requested", payload: { turn: 2, callNo: 1, model: "m1", params: {}, snapshotId: null } },
  ]);
  expect(decision.jobs).toEqual([{ type: "llm.call", key: "session:s1:2:llm:1", streamId: "session:s1" }]);
});

test("D14: every fixture log, the new session-disposition one included, folds to its state.json", () => {
  const logsDir = fileURLToPath(new URL("../../fixtures/logs/", import.meta.url));
  const entries = (map: Map<string, unknown>) => [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const serialise = (state: AgentState) => ({
    ...state,
    openToolCalls: entries(state.openToolCalls),
    waits: entries(state.waits),
  });

    const logs = ["simple-turn", "tool-call-turn", "cancelled-run", "wait-and-answer", "session-disposition"];
  for (const base of logs) {
    const logPath = `${logsDir}${base}.jsonl`;
    const statePath = `${logsDir}${base}.state.json`;
    expect(existsSync(logPath), `missing log ${base}.jsonl`).toBe(true);
    expect(existsSync(statePath), `missing state fixture for ${base}`).toBe(true);

    const events = readFileSync(logPath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as unknown);
    const state = fold(events, { def: { name: "dana" } });
    expect(serialise(state), `replay mismatch for ${base}`).toEqual(JSON.parse(readFileSync(statePath, "utf8")));
  }
});
