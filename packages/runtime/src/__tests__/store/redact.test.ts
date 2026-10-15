// S11 (ANY-61) — `redactStream`: the one sanctioned exception to the
// append-only rule (LEARNING §10.4 erasure). Text-bearing payload fields of the
// given event types become "[erased]", every `attachments` empties, a
// `content.erased` fact appends — and seqs, types, ids and the event count
// never move. The fold (I3) must read the same status/turn/cost/session after.
import { afterEach, expect, test } from "vitest";
import { fold } from "@fabric/core";
import { append, redactStream } from "../../index";
import type { RuntimeStore } from "../../index";
import { describeDrivers } from "../../testing/drivers";

const ERASED = "[erased]";
const WORKSPACE = "redact-workspace";

/** The event types whose text-bearing fields the purge redacts (S11). */
const REDACT_TYPES = [
  "message.received",
  "llm.completed",
  "agent.message",
  "tool.call",
  "tool.completed",
  "tool.result",
  "disposition.recorded",
] as const;

type Seed = { type: string; actor?: string; payload: Record<string, unknown> };

const fullStreamSeed = (): Seed[] => [
  { type: "session.created", payload: { agentId: "dana", incognito: true, surfaces: ["app"] } },
  {
    type: "message.received",
    payload: {
      text: "hello there",
      attachments: [{ name: "notes.txt" }],
      surface: "app",
      sender: "user",
      platformMessageId: "pm-1",
    },
  },
  {
    type: "llm.completed",
    payload: {
      turn: 1,
      callNo: 1,
      text: "the reply text",
      toolCalls: [{ callId: "c1", args: { path: "a.md" } }],
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.25 },
      finishReason: "stop",
      model: "test-model",
    },
  },
  { type: "agent.message", payload: { text: "assistant words" } },
  { type: "tool.call", payload: { tool: "read", summary: "read a file", callId: "c1", args: { file: "a.md" }, effect: "read" } },
  { type: "tool.completed", payload: { callId: "c1", ok: true, result: { bytes: 12 } } },
  { type: "tool.result", payload: { line: "terminal line", kind: "term" } },
  {
    type: "disposition.recorded",
    payload: { kind: "direct", target: null, reason: "simple answer", considered: ["agent", "team"], source: "model", turn: 1 },
  },
];

const seed = async (store: RuntimeStore, streamId: string, events: Seed[]): Promise<void> => {
  await store.transaction((tx) =>
    append(tx, WORKSPACE, [
      {
        streamId,
        events: events.map((event) => ({ ...event, actor: event.actor ?? "test" })),
      },
    ])
  );
};

describeDrivers("S11 runtime: incognito redaction (ANY-61)", (h) => {
  let store: RuntimeStore | undefined;

  afterEach(async () => {
    store = undefined;
  });

  const open = async (): Promise<RuntimeStore> => {
    store ??= await h.openStore();
    return store;
  };

  test("I2: redactStream replaces exactly the listed fields; seqs, types, ids and the count are unchanged; content.erased is appended", async () => {
    const db = await open();
    const streamId = "session:redact-full";
    await seed(db, streamId, fullStreamSeed());
    const before = await db.readStream(streamId, { workspaceId: WORKSPACE });
    expect(before).toHaveLength(8);

    const changed = await redactStream(db, WORKSPACE, streamId, { types: [...REDACT_TYPES], at: 1_234_567 });
    expect(changed).toBe(7);

    const after = await db.readStream(streamId, { workspaceId: WORKSPACE });
    // The event count never changes; exactly one appended event.
    expect(after).toHaveLength(9);
    const byType = (type: string): unknown[] => after.filter((event) => event.type === type).map((event) => event.payload);

    // Envelope invariants: same ids, seqs, types and v, in the same order.
    expect(after.slice(0, 8).map((e) => [e.id, e.seq, e.type, e.v])).toEqual(
      before.map((e) => [e.id, e.seq, e.type, e.v])
    );

    const [received] = byType("message.received") as Record<string, unknown>[];
    expect(received?.text).toBe(ERASED);
    expect(received?.attachments).toEqual([]);

    const [completed] = byType("llm.completed") as Record<string, unknown>[];
    expect(completed?.text).toBe(ERASED);
    const toolCalls = completed?.toolCalls as Record<string, unknown>[];
    expect(toolCalls?.[0]?.args).toBe(ERASED);
    // Untouched fields stay: the usage is audit data, not text.
    expect(completed?.usage).toEqual({ inputTokens: 10, outputTokens: 5, costUsd: 0.25 });

    const [agentMessage] = byType("agent.message") as Record<string, unknown>[];
    expect(agentMessage?.text).toBe(ERASED);

    const [toolCall] = byType("tool.call") as Record<string, unknown>[];
    expect(toolCall?.args).toEqual({});
    expect(toolCall?.tool).toBe("read");

    const [toolCompleted] = byType("tool.completed") as Record<string, unknown>[];
    expect(toolCompleted?.result).toBe(ERASED);

    const [toolResult] = byType("tool.result") as Record<string, unknown>[];
    expect(toolResult?.line).toBe(ERASED);

    const [disposition] = byType("disposition.recorded") as Record<string, unknown>[];
    expect(disposition?.reason).toBe(ERASED);
    expect(disposition?.considered).toEqual([]);
    expect(disposition?.kind).toBe("direct");
    expect(disposition?.source).toBe("model");

    // The erasure marker: appended last, a fact, pointing at the stream.
    const marker = after[8]!;
    expect(marker.type).toBe("content.erased");
    expect(marker.class).toBe("fact");
    expect(marker.payload).toEqual({ contentRef: streamId, reason: "incognito", by: "system" });

    // The unlisted type is untouched.
    const [created] = byType("session.created") as Record<string, unknown>[];
    expect(created).toMatchObject({ agentId: "dana", incognito: true });
  });

  test("I2b: a partial type list changes only those events and counts them", async () => {
    const db = await open();
    const streamId = "session:redact-partial";
    await seed(db, streamId, [
      { type: "agent.message", payload: { text: "keep? no" } },
      {
        type: "message.received",
        payload: { text: "user text", attachments: [], surface: "app", sender: "user", platformMessageId: "pm-2" },
      },
    ]);

    const changed = await redactStream(db, WORKSPACE, streamId, { types: ["agent.message"], at: 42 });
    expect(changed).toBe(1);

    const after = await db.readStream(streamId, { workspaceId: WORKSPACE });
    expect(after).toHaveLength(3);
    const received = after.find((event) => event.type === "message.received")!.payload as Record<string, unknown>;
    expect(received.text).toBe("user text");
    const agentMessage = after.find((event) => event.type === "agent.message")!.payload as Record<string, unknown>;
    expect(agentMessage.text).toBe(ERASED);
    expect(after.some((event) => event.type === "content.erased")).toBe(true);
  });

  test("I3: folding a redacted stream gives the same status, turn, costUsd and session as before redaction", async () => {
    const db = await open();
    const streamId = "session:redact-fold";
    await seed(db, streamId, [
      { type: "session.created", payload: { agentId: "dana", incognito: true, surfaces: ["app"] } },
      {
        type: "message.received",
        payload: { text: "run the thing", attachments: [], surface: "app", sender: "user", platformMessageId: "pm-3" },
      },
      { type: "llm.requested", payload: { turn: 1, callNo: 1, model: "test-model", params: {}, snapshotId: null } },
      {
        type: "llm.completed",
        payload: {
          turn: 1,
          callNo: 1,
          text: "done",
          toolCalls: [],
          usage: { inputTokens: 3, outputTokens: 4, costUsd: 0.75 },
          finishReason: "stop",
          model: "test-model",
        },
      },
      {
        type: "disposition.recorded",
        payload: { kind: "direct", target: null, reason: "it is done", considered: [], source: "model", turn: 1 },
      },
    ]);

    const fields = (state: { status: unknown; turn: unknown; costUsd: unknown; session: unknown }) => ({
      status: state.status,
      turn: state.turn,
      costUsd: state.costUsd,
      session: state.session,
    });

    const beforeRows = await db.readStream(streamId, { workspaceId: WORKSPACE });
    const before = fields(fold(beforeRows) as never);

    await redactStream(db, WORKSPACE, streamId, { types: [...REDACT_TYPES], at: 1 });

    const afterRows = await db.readStream(streamId, { workspaceId: WORKSPACE });
    const after = fields(fold(afterRows) as never);
    expect(after).toEqual(before);
  });
});
