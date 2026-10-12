// ANY-27 R1 — @fabric/core: event envelope, payload schemas, fact/telemetry classes,
// upcasters and stream ids (docs/RUNTIME.md sections 2 and 3). One test per listed case,
// named by its ID.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  EVENT_PAYLOAD_SCHEMAS,
  EVENT_CLASSES,
  isFact,
  parseEvent,
  registerEventType,
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
  "step.started",
  "llm.requested",
  "llm.completed",
  "llm.failed",
  "context.compacted",
  "tool.call",
  "tool.completed",
  "tool.interrupted",
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

describe("ANY-27 R1: core", () => {
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
});
