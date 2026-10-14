// The crash scenarios (ANY-37 R11, RUNTIME §15.3): five kill points, one
// script each, plus the four prove-it-can-fail KM variants that flip one
// recovery switch. Everything a scenario needs travels in its spec — the
// harness seeds the streams and bootstrap jobs, boots worker 1, kills it at
// the barrier, boots worker 2 on the same data, and asserts the invariants.
//
// The fake scripts route per-system/per-tool by RESOLVED count in the shared
// log, so the worker that takes over re-enters the entry its killed
// predecessor was holding — the blocked attempt never consumes it.
import { childRunId } from "@fabric/core";
import type { EventInput } from "../src/store/types";
import type { ModelScriptEntry, ToolScriptSpec, SurfaceScriptSpec } from "./fakes";

const WORKSPACE = "ws-crash";

/**
 * `run.created` for a fresh stream — the definition carrier (§3). Runs pass
 * `parent: { callId }`: decideAgent treats a run as a run only when
 * `run.created.parent` is a record (`isRun` = "parent" in def), and a
 * callId-only parent — schema-minimal, runId/sessionId optional — finishes
 * with `run.finished` and enqueues no `delegate.resolve`. A `parent: null`
 * run is currently decided as a session (the R11 finding, PR description).
 */
function created(definition: Record<string, unknown>, brief: string, parent: Record<string, string> | null): EventInput {
  return {
    type: "run.created",
    actor: "api",
    payload: { definition, engineVersion: "v1", brief, grants: [], budgets: {}, parent },
  };
}

const received = (text: string): EventInput => ({
  type: "message.received",
  actor: "user",
  payload: { text, attachments: [], surface: "app", sender: "tester", platformMessageId: "pm-0" },
});

/** What the harness asserts once worker 2 has settled the board. */
export interface ScenarioExpect {
  /** Streams that must carry a `run.finished` with exactly this payload. */
  finished?: { stream: string; result: string; costUsd: number }[];
  /** The projected fold per stream, deep-equal (see run.ts for the fields). */
  fold?: { stream: string; state: Record<string, unknown> }[];
  receipts?: { target: string; count: number }[];
  /** tool.interrupted facts per stream (K2 asserts present, KM3 asserts absent). */
  interrupted?: { stream: string; present: boolean }[];
  /** Resolved runs of a tool in the log (KM3 asserts the re-run happened). */
  toolRuns?: { tool: string; count: number }[];
  /** The note the Nth resolved model call for a system was handed as its last
   * tool result — K2's "the model saw tool.interrupted". */
  modelNote?: { system: string; call: number; contains: string }[];
}

export interface Scenario {
  id: string;
  title: string;
  streams: { streamId: string; events: EventInput[] }[];
  bootstrap: { type: string; key: string; streamId: string }[];
  model: readonly ModelScriptEntry[];
  tools: Record<string, ToolScriptSpec>;
  surface: SurfaceScriptSpec;
  /** Worker 1's kill point: a fake's barrier (K1/K2/K4/K5) or the claim held
   * after a chosen job completed (K3's between jobs). */
  kill: { barrier: string } | { afterCompleteOfKey: string; barrier: string };
  switches: {
    leaseNeverExpires?: boolean;
    appendNoDedupe?: boolean;
    effectBlind?: boolean;
    noDeliverKey?: boolean;
  };
  /** KM1 expects the board to NEVER settle: worker 2 exits 1 on its settle
   * timeout and the run must stay unfinished. */
  expectNoSettle?: boolean;
  /** KM2's append-level proof runs after the settle assertions. */
  km2AfterSettle?: boolean;
  settleTimeoutMs: number;
  expect: ScenarioExpect;
}

const FAST_SETTLE = 20_000;

// -- K1: killed mid model call ---------------------------------------------------
// The run needs one model call; worker 1 dies holding it; the lease lapses,
// worker 2 reclaims, the retry re-enters the same (now unblocked) script entry.

const k1: Scenario = {
  id: "K1",
  title: "kill during a model call",
  streams: [
    {
      streamId: "run:k1",
      events: [
        created({ systemPrompt: "K1", tools: [], model: "m1", surfaces: [] }, "answer", { callId: "c0" }),
        received("go"),
      ],
    },
  ],
  bootstrap: [{ type: "decide", key: "decide:run:k1:bootstrap", streamId: "run:k1" }],
  model: [{ system: "K1", text: "answer", costUsd: 0.1, block: "model-1" }],
  tools: {},
  surface: {},
  kill: { barrier: "model-1" },
  switches: {},
  settleTimeoutMs: FAST_SETTLE,
  expect: {
    finished: [{ stream: "run:k1", result: "answer", costUsd: 0.1 }],
    fold: [
      {
        stream: "run:k1",
        state: {
          status: "finished",
          turn: 1,
          calls: 1,
          costUsd: 0.1,
          turnCostUsd: 0.1,
          pendingInputs: [],
          delegations: [],
          openToolCalls: 0,
          lastFact: { type: "run.finished", payload: { result: "answer", costUsd: 0.1 } },
        },
      },
    ],
  },
};

// -- K2: killed mid rerunnable tool ----------------------------------------------
// Effect-class recovery (§6): the retry finds no recorded result and records
// `tool.interrupted` — the model sees the note and finishes; the tool's side
// effects never run a second time.

const k2: Scenario = {
  id: "K2",
  title: "kill during a sandbox command (rerunnable tool)",
  streams: [
    {
      streamId: "run:k2",
      events: [
        created({ systemPrompt: "K2", tools: ["build"], model: "m1", surfaces: [] }, "build it", { callId: "c0" }),
        received("build it"),
      ],
    },
  ],
  bootstrap: [{ type: "decide", key: "decide:run:k2:bootstrap", streamId: "run:k2" }],
  model: [
    { system: "K2", toolCalls: [{ name: "build", id: "c1", args: {} }], costUsd: 0.1 },
    { system: "K2", text: "done", costUsd: 0.2 },
  ],
  tools: { build: { effect: "rerunnable", runs: [{ ok: true, result: "built", block: "tool-1" }] } },
  surface: {},
  kill: { barrier: "tool-1" },
  switches: {},
  settleTimeoutMs: FAST_SETTLE,
  expect: {
    finished: [{ stream: "run:k2", result: "done", costUsd: 0.3 }],
    fold: [
      {
        stream: "run:k2",
        state: {
          status: "finished",
          turn: 1,
          calls: 2,
          costUsd: 0.3,
          turnCostUsd: 0.3,
          pendingInputs: [],
          delegations: [],
          openToolCalls: 0,
          lastFact: { type: "run.finished", payload: { result: "done", costUsd: 0.3 } },
        },
      },
    ],
    interrupted: [{ stream: "run:k2", present: true }],
    toolRuns: [{ tool: "build", count: 0 }],
    modelNote: [{ system: "K2", call: 1, contains: "interrupted by a restart" }],
  },
};

// -- K3: killed between jobs -------------------------------------------------------
// Worker 1 completes the tool job, then dies holding nothing before the next
// claim; worker 2 picks the board up. The tool.exec key is `<stream>:<callId>`.

const k3: Scenario = {
  id: "K3",
  title: "kill between jobs (after a commit, before the next claim)",
  streams: [
    {
      streamId: "run:k3",
      events: [
        created({ systemPrompt: "K3", tools: ["echo"], model: "m1", surfaces: [] }, "hi", { callId: "c0" }),
        received("hi"),
      ],
    },
  ],
  bootstrap: [{ type: "decide", key: "decide:run:k3:bootstrap", streamId: "run:k3" }],
  model: [
    { system: "K3", toolCalls: [{ name: "echo", id: "c1", args: {} }], costUsd: 0.1 },
    { system: "K3", text: "done", costUsd: 0.2 },
  ],
  tools: { echo: { effect: "read", runs: [{ ok: true, result: "pong" }] } },
  surface: {},
  kill: { afterCompleteOfKey: "run:k3:c1", barrier: "between-jobs" },
  switches: {},
  settleTimeoutMs: FAST_SETTLE,
  expect: {
    finished: [{ stream: "run:k3", result: "done", costUsd: 0.3 }],
    fold: [
      {
        stream: "run:k3",
        state: {
          status: "finished",
          turn: 1,
          calls: 2,
          costUsd: 0.3,
          turnCostUsd: 0.3,
          pendingInputs: [],
          delegations: [],
          openToolCalls: 0,
          lastFact: { type: "run.finished", payload: { result: "done", costUsd: 0.3 } },
        },
      },
    ],
    toolRuns: [{ tool: "echo", count: 1 }],
  },
};

// -- K4: killed while a parent waits on a child ------------------------------------

const K4_CHILD = `run:${childRunId("session:k4p", "c1")}`;

const k4: Scenario = {
  id: "K4",
  title: "kill while a parent waits on a child (await delegation, child mid-turn)",
  streams: [
    {
      streamId: K4_CHILD,
      events: [received("child brief")],
    },
    {
      streamId: "session:k4p",
      events: [
        created(
          {
            systemPrompt: "P",
            tools: ["delegate"],
            model: "m1",
            surfaces: [],
            agents: {
              sub: { definition: { systemPrompt: "SUB", tools: [], model: "m1" }, engineVersion: "v1", tools: [] },
            },
          },
          "delegate this",
          null
        ),
        received("delegate this"),
      ],
    },
  ],
  bootstrap: [{ type: "decide", key: "decide:session:k4p:bootstrap", streamId: "session:k4p" }],
  model: [
    {
      system: "P",
      toolCalls: [{ name: "delegate", id: "c1", args: { agentId: "sub", mode: "await", brief: "child brief", budgetUsd: 1 } }],
      costUsd: 0.1,
    },
    { system: "SUB", text: "child answer", costUsd: 0.4, block: "child-1" },
    { system: "P", text: "parent done", costUsd: 0.2 },
  ],
  tools: {},
  surface: {},
  kill: { barrier: "child-1" },
  switches: {},
  settleTimeoutMs: FAST_SETTLE,
  expect: {
    finished: [{ stream: K4_CHILD, result: "child answer", costUsd: 0.4 }],
    fold: [
      {
        stream: K4_CHILD,
        state: {
          status: "finished",
          turn: 1,
          calls: 1,
          costUsd: 0.4,
          turnCostUsd: 0.4,
          pendingInputs: [],
          delegations: [],
          openToolCalls: 0,
          lastFact: { type: "run.finished", payload: { result: "child answer", costUsd: 0.4 } },
        },
      },
      {
        stream: "session:k4p",
        state: {
          status: "idle",
          turn: 1,
          calls: 2,
          costUsd: 0.7,
          turnCostUsd: 0.3,
          pendingInputs: [],
          delegations: [],
          openToolCalls: 0,
        },
      },
    ],
  },
};

// -- K5: killed mid deliver ---------------------------------------------------------

const k5: Scenario = {
  id: "K5",
  title: "kill during a deliver (surface blocked mid-send)",
  streams: [
    {
      streamId: "session:k5",
      events: [
        created({ systemPrompt: "K5", tools: [], model: "m1", surfaces: ["email"] }, "hello", null),
        received("hello"),
      ],
    },
  ],
  bootstrap: [{ type: "decide", key: "decide:session:k5:bootstrap", streamId: "session:k5" }],
  model: [{ system: "K5", text: "reply", costUsd: 0.1 }],
  tools: {},
  surface: { block: { target: "email", barrier: "deliver-1" } },
  kill: { barrier: "deliver-1" },
  switches: {},
  settleTimeoutMs: FAST_SETTLE,
  expect: {
    fold: [
      {
        stream: "session:k5",
        state: {
          status: "idle",
          turn: 1,
          calls: 1,
          costUsd: 0.1,
          turnCostUsd: 0.1,
          pendingInputs: [],
          delegations: [],
          openToolCalls: 0,
        },
      },
    ],
    receipts: [{ target: "email", count: 1 }],
  },
};

// -- The KM variants: one switch each, the invariant must break ---------------------

const km1: Scenario = {
  ...k1,
  id: "KM1",
  title: "lease expiry off: the killed job is never reclaimed, K1 never finishes",
  switches: { leaseNeverExpires: true },
  settleTimeoutMs: 8_000,
  expectNoSettle: true,
  expect: { finished: [], fold: [] },
};

const km2: Scenario = {
  ...k3,
  id: "KM2",
  title: "causation dedupe off (append without the index): a re-run append double-records",
  switches: { appendNoDedupe: true },
  km2AfterSettle: true,
};

const km3: Scenario = {
  ...k2,
  id: "KM3",
  title: "effect-class recovery off: the retry re-runs the rerunnable tool",
  switches: { effectBlind: true },
  expect: {
    ...k2.expect,
    interrupted: [{ stream: "run:k2", present: false }],
    toolRuns: [{ tool: "build", count: 1 }],
    modelNote: [],
  },
};

const km4: Scenario = {
  ...k5,
  id: "KM4",
  title: "deliver idempotency off: the surface receives the message twice",
  switches: { noDeliverKey: true },
  expect: {
    ...k5.expect,
    receipts: [{ target: "email", count: 2 }],
  },
};

/** K1–K5 then KM1–KM4, the order the card lists them in. */
export const SCENARIOS: readonly Scenario[] = [k1, k2, k3, k4, k5, km1, km2, km3, km4];

export { WORKSPACE };
