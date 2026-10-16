// ANY-27 R1 — @fabric/core: event envelope, payload schemas, fact/telemetry classes,
// upcasters and stream ids (docs/RUNTIME.md sections 2 and 3). One test per listed case,
// named by its ID.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  EVENT_PAYLOAD_SCHEMAS,
  EVENT_CLASSES,
  eventClass,
  isFact,
  latestVersion,
  parseEvent,
  registerEventType,
  EventParseError,
  streamId,
  parseStreamId,
} from "../index";
import { recordings } from "@fabric/fixtures/recordings";

/** Every event type in RUNTIME section 3, facts then telemetry, in table order. */
const ALL_TYPES = [
  "run.created",
  "run.started",
  "message.received",
  "disposition.recorded",
  "session.created",
  "session.approval_mode_set",
  "step.started",
  "llm.requested",
  "llm.completed",
  "llm.failed",
  "context.compacted",
  "tool.call",
  "tool.completed",
  "tool.interrupted",
  "tool.queued",
  "tool.dequeued",
  "tool.denied",
  "delegation.result",
  "step.finished",
  "review.verdict",
  "criterion.checked",
  "rework.requested",
  "human.requested",
  "human.responded",
  "memory.written",
  "skill.written",
  "skill.used",
  "skill.state_changed",
  "learning.completed",
  "content.erased",
  "feedback.given",
  "proposal.created",
  "proposal.decided",
  "run.cancel_requested",
  "run.blocked",
  "run.stopped",
  "run.finished",
  "artifact.created",
  "context.snapshot",
  "tool.result",
  "agent.message",
  "run.progress",
  "budget.update",
  "message.delivered",
  "handoff",
] as const;

/** The `telemetry` rows of the section 3 table; every other type is a `fact`. */
const TELEMETRY_TYPES = [
  "context.snapshot",
  "tool.result",
  "agent.message",
  "run.progress",
  "budget.update",
  "message.delivered",
  "handoff",
] as const;

/** Build an envelope around a payload; overrides fill the fields a case varies. */
function env(type: string, payload: unknown, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "evt-1",
    workspaceId: "ws-test",
    streamId: "run:r1",
    seq: 1,
    type,
    actor: "test",
    causation: null,
    ts: "2026-10-12T00:00:00.000Z",
    ...over,
    payload,
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const inner of Object.values(value as object)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

// NOTE: deliberately no describe wrapper. Stryker's per-test filter joins suite names with a
// separator Vitest 5 no longer uses (stryker-js#6210), which silently marks every covered
// mutant as survived; flat `it` names keep the filter working.
it("R1.1: a schema exists for exactly the RUNTIME section 3 types", () => {
    expect(Object.keys(EVENT_PAYLOAD_SCHEMAS).sort()).toEqual([...ALL_TYPES].sort());
  });

  it("R1.2: every type maps to its section 3 class; isFact agrees", () => {
    const facts = ALL_TYPES.filter((t) => !(TELEMETRY_TYPES as readonly string[]).includes(t));
    expect((EVENT_CLASSES as Record<string, string>)["tool.call"]).toBe("fact");
    for (const type of facts) expect((EVENT_CLASSES as Record<string, string>)[type]).toBe("fact");
    for (const type of TELEMETRY_TYPES) expect((EVENT_CLASSES as Record<string, string>)[type]).toBe("telemetry");
    expect(Object.keys(EVENT_CLASSES).sort()).toEqual([...ALL_TYPES].sort());
    expect(isFact("tool.call")).toBe(true);
    expect(isFact("tool.result")).toBe(false);
    expect(isFact("agent.message")).toBe(false);
    expect(isFact("budget.update")).toBe(false);
  });

  it("R1.3: parseEvent accepts a valid llm.completed and names a missing field", () => {
    const payload = {
      turn: 3,
      callNo: 2,
      text: "done",
      toolCalls: [{ id: "c1", name: "sprite_exec", args: { cmd: "ls" } }],
      usage: { inputTokens: 120, outputTokens: 80, costUsd: 0.012 },
      finishReason: "tool-calls",
      model: "ngram-135m",
    };
    const ok = parseEvent(env("llm.completed", payload));
    expect(ok.v).toBe(1);
    expect(ok.class).toBe("fact");
    expect(ok.payload).toEqual(payload);

    const missing: Record<string, unknown> = { ...payload };
    delete missing.callNo;
    expect(() => parseEvent(env("llm.completed", missing))).toThrow();
    let message = "";
    try {
      parseEvent(env("llm.completed", missing));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/callNo/);
  });

  it("R1.4: parseEvent rejects an unknown type, naming it", () => {
    expect(() => parseEvent(env("planet.aligned", {}))).toThrow(/planet\.aligned/);
  });

  it("R1.5: registered upcasters lift an old v to the latest, in order", () => {
    registerEventType({
      type: "test.upcast",
      schema: z.record(z.string(), z.unknown()),
      upcasters: {
        1: (payload) => ({ ...(payload as Record<string, unknown>), two: 2 }),
        2: (payload) => ({ ...(payload as Record<string, unknown>), three: 3 }),
      },
    });
    const v1 = parseEvent(env("test.upcast", { name: "a" }, { v: 1 }));
    expect(v1.v).toBe(3);
    expect(v1.payload).toEqual({ name: "a", two: 2, three: 3 });

    const latest = { name: "a", two: 2, three: 3 };
    const v3 = parseEvent(env("test.upcast", latest, { v: 3 }));
    expect(v3.v).toBe(3);
    expect(v3.payload).toEqual(latest);
  });

  it("R1.6: a v above the latest known version is rejected", () => {
    expect(() => parseEvent(env("run.started", { objective: "x" }, { v: 2 }))).toThrow();
    registerEventType({ type: "test.versions", schema: z.record(z.string(), z.unknown()) });
    expect(() => parseEvent(env("test.versions", {}, { v: 2 }))).toThrow();
  });

  it("R1.7: memory.written carries contentRef, never text (strict payload)", () => {
    const payload = { scope: "agent:memoria", itemId: "mem-1", op: "add", contentRef: "ref-abc" };
    expect(parseEvent(env("memory.written", payload)).payload).toEqual({
      scope: "agent:memoria",
      itemId: "mem-1",
      op: "add",
      contentRef: "ref-abc",
    });
    const withText = { ...payload, text: "the memory text itself" };
    expect(() => parseEvent(env("memory.written", withText))).toThrow(/text/);
  });

  it("R1.8: every recording event of a section 3 type parses as v1", () => {
    const bundle = recordings["ngram-135m"];
    const base = Date.parse(bundle.run.startedAt);
    // Recording types outside section 3, with the reason they are skipped. None today:
    // every type in ngram-135m is a section 3 type.
    const skipped: Record<string, string> = {};
    const unhandled = [...new Set(bundle.events.map((event) => event.type))].filter(
      (type) => !(type in EVENT_PAYLOAD_SCHEMAS) && !(type in skipped)
    );
    expect(unhandled).toEqual([]);

    for (const event of bundle.events) {
      if (!(event.type in EVENT_PAYLOAD_SCHEMAS)) continue;
      const parsed = parseEvent(
        env(event.type, event.payload, {
          id: `rec-${String(event.seqHint)}`,
          seq: event.seqHint,
          actor: event.actorAgentId ?? "system",
          ts: new Date(base + event.t * 1000).toISOString(),
        })
      );
      expect(parsed.v).toBe(1);
      expect(parsed.payload).toEqual(event.payload);
    }
  });

  it("R1.9: stream ids build and parse; other prefixes are rejected", () => {
    expect(streamId.session("abc")).toBe("session:abc");
    expect(streamId.run("r1")).toBe("run:r1");
    expect(streamId.agent("a7")).toBe("agent:a7");
    expect(parseStreamId("run:x")).toEqual({ kind: "run", id: "x" });
    expect(parseStreamId("session:abc")).toEqual({ kind: "session", id: "abc" });
    expect(() => parseStreamId("job:x")).toThrow();
  });

  it("R1.10: parsing never mutates its input", () => {
    const raw = deepFreeze(env("run.started", { objective: "folds to state" }));
    const before = JSON.stringify(raw);
    const parsed = parseEvent(raw);
    expect(JSON.stringify(raw)).toBe(before);
    expect(parsed).not.toBe(raw);
    expect(parsed.seq).toBe(1);
    expect(parsed.v).toBe(1);
    expect(parsed.payload).toEqual({ objective: "folds to state" });
  });

it("R1.11: every type's happy path parses, with a payload variant where the schema branches", () => {
    const valid: Record<string, Record<string, unknown>> = {
      "run.created": {
        definition: { name: "sana" },
        engineVersion: "1",
        brief: "do the thing",
        grants: ["sprite.exec"],
        budgets: { costUsd: 5 },
        parent: { runId: "run:1", callId: "c1" },
      },
      "run.started": { objective: "o" },
      "message.received": { text: "hi", attachments: [{ url: "https://x" }], surface: "app", sender: "ty", platformMessageId: "p1" },
      "disposition.recorded": { kind: "agent", target: "sana", reason: "needs hands", considered: ["team:ops"], source: "model", turn: 1 },
      "session.created": { agentId: "dana", incognito: false, surfaces: ["app"] },
      "session.approval_mode_set": { mode: "full_auto" },
      "step.started": { label: "Plan", stage: "Plan", kind: "work", stepKey: "Plan|elliot|1", pass: 1, childRunId: "run:9" },
      "llm.requested": { turn: 1, callNo: 1, model: "m", params: { temperature: 0.2 }, snapshotId: "snap-1" },
      "llm.completed": {
        turn: 1,
        callNo: 1,
        text: "done",
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 2, costUsd: 3 },
        finishReason: "stop",
        model: "m",
      },
      "llm.failed": { turn: 1, callNo: 2, error: "429", retryable: true },
      "context.compacted": { upToSeq: 9, summary: "earlier" },
      "tool.call": { tool: "sprite_exec", summary: "list", callId: "c1", args: { cmd: "ls" }, effect: "rerunnable" },
      "tool.completed": { callId: "c1", ok: true, result: { files: 3 } },
      "tool.interrupted": { callId: "c1", effect: "rerunnable", note: "restart" },
      "tool.denied": { tool: "send", target: "x", reason: "r", callId: "c2" },
      "delegation.result": { childRunId: "run:2", outcome: "done", summary: "s", output: { a: 1 }, artifacts: [], costUsd: 1.5 },
      "step.finished": { label: "Plan", stage: "Plan", kind: "work", stepKey: "k", outcome: "done" },
      "review.verdict": { verdict: "request_changes", text: "t" },
      "criterion.checked": { index: 1, pass: false, note: "n" },
      "rework.requested": { to: "elliot", used: 1, budget: 2 },
      "human.requested": { waitId: "w1", kind: "approve", gated: true, prompt: "ok?", deadline: 1791_780_000_000 },
      "human.responded": { waitId: "w1", decision: "yes", by: "ty", surface: "app" },
      "memory.written": { scope: "agent:memoria", itemId: "i1", op: "forget", contentRef: "ref" },
      "skill.written": { skillId: "s1", version: 2, op: "patch", contentRef: "ref", scope: "global", origin: "learned", source: "run:1" },
      "skill.used": { skillId: "s1", version: 2, stream: "run:1", outcome: "helped", revises: "s0" },
      "skill.state_changed": { skillId: "s1", from: "candidate", to: "stable", reason: "used", strength: 0.5 },
      "learning.completed": { sourceStream: "run:1", upToSeq: 10, written: 2, skipped: 1, costUsd: 0.1 },
      "content.erased": { contentRef: "ref", reason: "stale", by: "ty" },
      "feedback.given": { targetEventId: "evt-9", kind: "edit", diffRef: "d1" },
      "proposal.created": { kind: "agent", definition: { a: 1 } },
      "proposal.decided": { kind: "agent", decision: "approved", by: "ty" },
      "run.cancel_requested": { by: "ty" },
      "run.blocked": { reason: "budget", itemId: "w1" },
      "run.stopped": { by: "ty", text: "t" },
      "run.finished": { reportId: "r1", result: { ok: true }, costUsd: 2 },
      "artifact.created": { name: "a.md", artifactId: "art-1" },
      "context.snapshot": { snapshotId: "snap-1" },
      "tool.result": { line: "$ ls", kind: "term" },
      "agent.message": { text: "hello" },
      "run.progress": { text: "t", milestone: "half" },
      "budget.update": { reworkUsed: 1, reworkBudget: 2, costUsd: 3 },
      "message.delivered": { eventId: "e1", target: "telegram:1", platformMessageId: null },
      handoff: { to: "jonah", step: "Implement" },
    };
    for (const [type, payload] of Object.entries(valid)) {
      const parsed = parseEvent(env(type, payload));
      expect(parsed.class).toBe((EVENT_CLASSES as Record<string, string>)[type]);
      expect(parsed.payload).toEqual(
        type === "run.created" ? { ...payload, parent: { runId: "run:1", callId: "c1" } } : payload
      );
    }
    // The branching variants: nullable / optional shapes of the same types.
    expect(parseEvent(env("run.created", { ...valid["run.created"], parent: null })).payload).toEqual({
      ...valid["run.created"],
      parent: null,
    });
    expect(parseEvent(env("tool.completed", { callId: "c", ok: false, resultRef: "s3://x", error: "e" })).payload).toEqual({
      callId: "c",
      ok: false,
      resultRef: "s3://x",
      error: "e",
    });
    expect(parseEvent(env("human.requested", { waitId: "w", kind: "answer", gated: false, prompt: "p", deadline: null })).v).toBe(1);
    // Enum fields reject values outside their table.
    expect(() => parseEvent(env("memory.written", { scope: "s", itemId: "i", op: "ADD", contentRef: "r" }))).toThrow(/op/);
    expect(() => parseEvent(env("tool.call", { tool: "t", summary: "s", effect: "sometimes" }))).toThrow(/effect/);
    expect(() => parseEvent(env("review.verdict", { verdict: "maybe", text: "t" }))).toThrow(/verdict/);
    expect(() => parseEvent(env("message.received", { text: "t", attachments: [], surface: "email", sender: "s", platformMessageId: "p" }))).toThrow(
      /surface/
    );
  });

  it("R1.12: envelope fields are validated, each named in the error", () => {
    const base = env("run.started", { objective: "x" });
    for (const field of ["id", "workspaceId", "streamId", "actor", "ts"]) {
      expect(() => parseEvent({ ...base, [field]: "" })).toThrow(new RegExp(`event ${field}`));
      const absent = { ...base };
      delete absent[field];
      expect(() => parseEvent(absent)).toThrow(new RegExp(`event ${field}`));
    }
    for (const seq of [0, 1.5, "1"]) expect(() => parseEvent({ ...base, seq })).toThrow(/seq/);
    const noSeq = { ...base };
    delete noSeq.seq;
    expect(() => parseEvent(noSeq)).toThrow(/seq/);
    for (const v of [0, 1.5, "1"]) expect(() => parseEvent({ ...base, v })).toThrow(/v must be/);
    expect(() => parseEvent({ ...base, causation: 5 })).toThrow(/causation/);
    expect(() => parseEvent({ ...base, type: 42 })).toThrow(/42/);
    // A bad stream id inside the envelope surfaces as an EventParseError naming it.
    let error: unknown;
    try {
      parseEvent({ ...base, streamId: "job:x" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EventParseError);
    expect((error as Error).message).toMatch(/job:x/);
    // A job key rides along as causation.
    expect(parseEvent({ ...base, causation: "job:stream:turn:llm:1" }).causation).toBe("job:stream:turn:llm:1");
  });

  it("R1.13: a non-object event is rejected", () => {
    for (const raw of [null, 42, "event", [], true]) expect(() => parseEvent(raw)).toThrow(EventParseError);
  });

  it("R1.14: a declared class must match the table; an omitted class is filled in", () => {
    expect(parseEvent(env("tool.result", { line: "l", kind: "term" }, { class: "telemetry" })).class).toBe("telemetry");
    expect(parseEvent(env("run.started", { objective: "x" }, { class: undefined })).class).toBe("fact");
    expect(() => parseEvent(env("run.started", { objective: "x" }, { class: "telemetry" }))).toThrow(/class/);
    expect(() => parseEvent(env("tool.result", { line: "l", kind: "term" }, { class: "fact" }))).toThrow(/class/);
  });

  it("R1.15: class and version helpers answer for unknown types too", () => {
    expect(eventClass("nope")).toBeUndefined();
    expect(isFact("nope")).toBe(false);
    expect(latestVersion("run.started")).toBe(1);
    expect(latestVersion("nope")).toBe(0);
  });

  it("R1.16: a gap in the upcaster chain is reported, later versions still lift", () => {
    registerEventType({
      type: "test.gap",
      schema: z.record(z.string(), z.unknown()),
      upcasters: { 2: (payload) => payload },
    });
    expect(() => parseEvent(env("test.gap", {}, { v: 1 }))).toThrow(/missing upcaster/);
    expect(parseEvent(env("test.gap", { ok: true }, { v: 2 })).v).toBe(3);
  });

  it("R1.17: stream id shapes outside the three prefixes are rejected", () => {
    expect(() => parseStreamId("sessionabc")).toThrow(/session:/);
    expect(() => parseStreamId("run:")).toThrow();
    expect(() => parseStreamId("")).toThrow();
    expect(parseStreamId("agent:a:b").id).toBe("a:b");
    expect(parseStreamId("agent:a:b").kind).toBe("agent");
  });
