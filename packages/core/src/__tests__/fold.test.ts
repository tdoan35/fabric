// ANY-28 R2 — @fabric/core: the agent-loop fold (docs/RUNTIME.md section 5.1) and the
// replay fixtures of section 10. One test per listed case, named by its ID.
//
// NOTE: deliberately no describe wrapper, as in fold.test.ts's sibling — Stryker's
// per-test filter joins suite names with a separator Vitest 5 no longer uses
// (stryker-js#6210); flat `it` names keep the filter working.
/// <reference types="node" />
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fold, FoldError } from "../index";
import type { AgentState } from "../index";

/** The session every replay starts from: sessions have no `run.created` (section 5.1). */
const SESSION_INIT = { def: { name: "dana" } };

/** Build an envelope; `seq` is explicit because R2.13 folds by it. */
function evt(seq: number, type: string, payload: unknown, over: Record<string, unknown> = {}) {
  return {
    id: `e${seq}`,
    workspaceId: "ws-test",
    streamId: "run:t",
    type,
    actor: "test",
    causation: null,
    ts: "2026-10-12T00:00:00.000Z",
    ...over,
    payload,
    seq,
  };
}

const RUN_CREATED = {
  definition: { name: "sana", engine: 2 },
  engineVersion: "2",
  brief: "Run the checks.",
  grants: ["sprite.exec"],
  budgets: { costUsd: 5 },
  parent: null,
};

const LLM_COMPLETED = (over: Record<string, unknown>) => ({
  turn: 1,
  callNo: 1,
  text: "done",
  toolCalls: [],
  usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
  finishReason: "stop",
  model: "ngram-135m",
  ...over,
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const inner of Object.values(value as object)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/** Maps serialise as sorted entry arrays (section 10); everything else stands. */
function serialise(state: AgentState) {
  const entries = (map: Map<string, unknown>) =>
    [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { ...state, openToolCalls: entries(state.openToolCalls), waits: entries(state.waits) };
}

it("R2.1: run.created + run.started -> status running, the definition snapshot, turn 0, cost 0", () => {
    const events = [
      evt(1, "run.created", RUN_CREATED),
      evt(2, "run.started", { objective: "Run the checks" }),
    ];
    const state = fold(events, {});
    expect(state.status).toBe("running");
    expect(state.def).toEqual({ name: "sana", engine: 2 });
    expect(state.turn).toBe(0);
    expect(state.costUsd).toBe(0);
  });

  it("R2.2: an idle session plus message.received holds one pending input, still idle", () => {
    const message = {
      text: "Run the green build",
      attachments: [],
      surface: "app",
      sender: "ty",
      platformMessageId: "pm-1",
    };
    const state = fold([evt(1, "message.received", message)], {});
    expect(state.status).toBe("idle");
    expect(state.pendingInputs).toEqual([{ type: "message.received", payload: message }]);
  });

  it("R2.3: the turn's first llm.requested starts the turn and consumes pending inputs", () => {
    const requested = { turn: 1, callNo: 1, model: "m", params: {}, snapshotId: null };
    const state = fold(
      [
        evt(1, "message.received", {
          text: "go",
          attachments: [],
          surface: "app",
          sender: "ty",
          platformMessageId: "pm-1",
        }),
        evt(2, "llm.requested", requested),
      ],
      {}
    );
    expect(state.turn).toBe(1);
    expect(state.pendingInputs).toEqual([]);
    expect(state.calls).toBe(0);
    expect(state.status).toBe("running");
  });

  it("R2.4: two llm.completed count 2 calls and sum their costUsd", () => {
    const state = fold(
      [
        evt(1, "llm.requested", { turn: 1, callNo: 1, model: "m", params: {}, snapshotId: null }),
        evt(2, "llm.completed", LLM_COMPLETED({ callNo: 1, usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.01 } })),
        evt(3, "llm.completed", LLM_COMPLETED({ callNo: 2, usage: { inputTokens: 3, outputTokens: 4, costUsd: 0.02 } })),
      ],
      {}
    );
    expect(state.calls).toBe(2);
    expect(state.costUsd).toBeCloseTo(0.03, 12);
  });

  it("R2.5: openToolCalls tracks tool.call until completed or interrupted, by callId", () => {
    const call = (callId: string) => ({
      tool: "sprite_exec",
      summary: `run ${callId}`,
      callId,
      args: {},
      effect: "rerunnable" as const,
    });
    const opened = fold([evt(1, "tool.call", call("a")), evt(2, "tool.call", call("b"))], {});
    expect([...opened.openToolCalls.keys()].sort()).toEqual(["a", "b"]);

    const oneLeft = fold(
      [evt(1, "tool.call", call("a")), evt(2, "tool.call", call("b")), evt(3, "tool.completed", { callId: "a", ok: true })],
      {}
    );
    expect([...oneLeft.openToolCalls.keys()]).toEqual(["b"]);

    const none = fold(
      [
        evt(1, "tool.call", call("a")),
        evt(2, "tool.call", call("b")),
        evt(3, "tool.completed", { callId: "a", ok: true }),
        evt(4, "tool.interrupted", { callId: "b", effect: "rerunnable", note: "restart" }),
      ],
      {}
    );
    expect(none.openToolCalls.size).toBe(0);
  });

  it("R2.6: human.requested waits; human.responded closes it and parks a pending input", () => {
    const wait = { waitId: "w1", kind: "approve" as const, gated: true, prompt: "Ship?", deadline: null };
    const waiting = fold([evt(1, "human.requested", wait)], {});
    expect(waiting.waits.get("w1")).toEqual(wait);
    expect(waiting.status).toBe("waiting");

    const answered = fold(
      [
        evt(1, "human.requested", wait),
        evt(2, "human.responded", { waitId: "w1", decision: "yes", by: "ty", surface: "app" }),
      ],
      {}
    );
    expect(answered.waits.size).toBe(0);
    expect(answered.pendingInputs).toEqual([
      { type: "human.responded", payload: { waitId: "w1", decision: "yes", by: "ty", surface: "app" } },
    ]);
    expect(answered.status).not.toBe("waiting");
    expect(answered.status).toBe("idle");
  });

  it("R2.7: context.compacted moves compactedUpTo to the latest seq", () => {
    const compact = (upToSeq: number) => ({ upToSeq, summary: "earlier context" });
    expect(fold([evt(1, "context.compacted", compact(12))], {}).compactedUpTo).toBe(12);
    expect(fold([evt(1, "context.compacted", compact(12)), evt(2, "context.compacted", compact(20))], {}).compactedUpTo).toBe(20);
  });

  it("R2.8: run.cancel_requested raises cancelRequested", () => {
    expect(fold([evt(1, "run.started", { objective: "o" })], {}).cancelRequested).toBe(false);
    expect(fold([evt(1, "run.cancel_requested", { by: "ty" })], {}).cancelRequested).toBe(true);
  });

  it("R2.9: run.blocked / stopped / finished are terminal; later facts stay inside", () => {
    const terminals = [
      ["run.blocked", { reason: "budget spent" }, "blocked"],
      ["run.stopped", { by: "ty", text: "stopped" }, "stopped"],
      ["run.finished", { result: { ok: true } }, "finished"],
    ] as const;
    for (const [type, payload, status] of terminals) {
      const events = [evt(1, "run.started", { objective: "o" }), evt(2, type, payload)];
      expect(fold(events, {}).status).toBe(status);
      // A later fact does not move the run out of the terminal status.
      const after = [
        ...events,
        evt(3, "llm.requested", { turn: 1, callNo: 1, model: "m", params: {}, snapshotId: null }),
      ];
      expect(fold(after, {}).status).toBe(status);
    }
  });

  it("R2.10: telemetry is skipped — interleaved folds equal to the stripped log", () => {
    const facts = [
      evt(1, "message.received", { text: "go", attachments: [], surface: "app", sender: "ty", platformMessageId: "p" }),
      evt(2, "llm.requested", { turn: 1, callNo: 1, model: "m", params: {}, snapshotId: null }),
      evt(3, "llm.completed", LLM_COMPLETED({ toolCalls: [{ id: "c1", name: "sprite_exec" }] })),
      evt(4, "tool.call", { tool: "sprite_exec", summary: "s", callId: "c1", args: {}, effect: "read" }),
      evt(5, "tool.completed", { callId: "c1", ok: true }),
    ];
    // Telemetry rides in the same log (the UI's copy of the same stream).
    const telemetry = [
      evt(6, "context.snapshot", { snapshotId: "snap-1" }),
      evt(7, "tool.result", { line: "$ ls", kind: "term" }),
      evt(8, "agent.message", { text: "halfway" }),
      evt(9, "budget.update", { costUsd: 0.01 }),
    ];
    const interleaved = fold([...facts, ...telemetry].sort((a, b) => a.seq - b.seq), {});
    const stripped = fold(facts, {});
    expect(interleaved).toEqual(stripped);
    // And the telemetry really is absent from the fold's bookkeeping.
    expect(interleaved.openToolCalls.size).toBe(0);
    expect(interleaved.calls).toBe(1);
  });

  it("R2.11: folding is deterministic and never mutates its input", () => {
    const events = [
      evt(2, "llm.requested", { turn: 1, callNo: 1, model: "m", params: {}, snapshotId: null }),
      evt(1, "message.received", { text: "go", attachments: [], surface: "app", sender: "ty", platformMessageId: "p" }),
      evt(3, "llm.completed", LLM_COMPLETED({})),
    ];
    const before = JSON.stringify(events);
    const once = fold(events, {});
    expect(fold(events, {})).toEqual(once);
    expect(JSON.stringify(events)).toBe(before);

    const frozen = deepFreeze(structuredClone(events));
    expect(fold(frozen, {})).toEqual(once);
    expect(JSON.stringify(frozen)).toBe(before);
  });

  it("R2.12: every fixture log folds to its state.json; a log without one fails", () => {
    const logsDir = fileURLToPath(new URL("../../fixtures/logs/", import.meta.url));
    const logs = readdirSync(logsDir).filter((name) => name.endsWith(".jsonl"));
    expect(logs.length).toBeGreaterThanOrEqual(4);
    for (const log of logs) {
      const base = log.replace(/\.jsonl$/, "");
      const statePath = `${logsDir}${base}.state.json`;
      expect(existsSync(statePath), `missing state fixture for ${log}`).toBe(true);

      const events = readFileSync(`${logsDir}${log}`, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as unknown);
      const state = fold(events, SESSION_INIT);
      expect(serialise(state), `replay mismatch for ${log}`).toEqual(JSON.parse(readFileSync(statePath, "utf8")));
    }
  });

  it("R2.13: facts fold in seq order; a gap or duplicate seq raises FoldError naming it", () => {
    const message = (text: string) => ({
      text,
      attachments: [],
      surface: "app",
      sender: "ty",
      platformMessageId: "p",
    });
    // Out-of-order input is folded in seq order: the earlier message lands first.
    const shuffled = fold(
      [evt(2, "message.received", message("second")), evt(1, "message.received", message("first"))],
      {}
    );
    expect(shuffled.pendingInputs.map((input) => (input.payload as { text: string }).text)).toEqual([
      "first",
      "second",
    ]);

    const gap = () => fold([evt(1, "run.started", { objective: "o" }), evt(3, "run.started", { objective: "o" })], {});
    expect(gap).toThrow(FoldError);
    expect(gap).toThrow(/3/);

    const duplicate = () =>
      fold([evt(1, "run.started", { objective: "o" }), evt(2, "run.started", { objective: "o" }), evt(2, "run.started", { objective: "o" })], {});
    expect(duplicate).toThrow(FoldError);
    expect(duplicate).toThrow(/2/);
  });

it("R2.14: a later callNo continues the turn — no new turn, calls kept from the turn start", () => {
    const state = fold(
      [
        evt(1, "llm.requested", { turn: 1, callNo: 1, model: "m", params: {}, snapshotId: null }),
        evt(2, "llm.completed", LLM_COMPLETED({ callNo: 1, toolCalls: [{ id: "c1", name: "t" }] })),
        evt(3, "llm.requested", { turn: 1, callNo: 2, model: "m", params: {}, snapshotId: null }),
      ],
      {}
    );
    expect(state.turn).toBe(1);
    expect(state.calls).toBe(1);
    expect(state.status).toBe("running");
  });
