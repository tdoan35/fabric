// ANY-84 M6 — the listed cases Y5, Y6 and Y11, verbatim from the card. The
// loop half: the stamped MCP tools gate through core decide exactly as the
// policy says — an `approval` attachment waits even under full_auto, `mode`
// gates follow the session's mode per kind, and an approved wait resumes
// into the tool call and its completion carrying the server's text. A real
// MCP server on 127.0.0.1 (the shared ANY-84 fixture), embedded PGlite,
// scripted model, no external network.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  append,
  MemoryQueue,
  openStore,
  respond,
  runUntilIdle,
  type EventInput,
  type RuntimeStore,
} from "@fabric/runtime";
import { expect, test } from "vitest";
import { ensureMcpSchema, mcpClient, mcpServers } from "@fabric/tools/mcp";
import {
  mcpToolRunner,
  sessionTools,
  specialistSessionDef,
  withMcpTools,
  type McpSessionDeps,
  type SpecialistAgent,
  type SpecialistSessionDef,
} from "../../assistant/session";
import { startTestMcpServer, type TestMcpServer } from "../../../../../apps/server/src/__tests__/fixtures/mcp/server";

const WORKSPACE = "ws-m6";

const AGENT: SpecialistAgent = {
  id: "researcher",
  name: "Renna",
  role: "Research",
  instructions: "# SOUL.md\n\nYou are the studio's researcher.",
};

/** The stamp's def shape beyond SpecialistSessionDef (T14's test twin). */
type StampedDef = SpecialistSessionDef & {
  tools?: string[];
  toolPolicy?: Record<string, { access?: string; gate?: string; kind?: string }>;
};

interface FakeResult {
  text: string;
  toolCalls: readonly Record<string, unknown>[];
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  finishReason: string;
}

/** The scripted model: one entry per call, verbatim (the M3 harness). */
class FakeModel {
  calls = 0;
  readonly #script: FakeResult[];
  constructor(script: FakeResult[]) {
    this.#script = [...script];
  }
  async call(request: unknown): Promise<FakeResult> {
    void request;
    this.calls += 1;
    const entry = this.#script.shift();
    if (entry === undefined) throw new Error("FakeModel: no scripted entry left");
    return { ...entry, toolCalls: [...entry.toolCalls] };
  }
}

const callResult = (id: string, name: string, args: Record<string, unknown>): FakeResult => ({
  text: "",
  toolCalls: [{ id, name, args }],
  usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
  finishReason: "tool-calls",
});

const textResult = (text: string): FakeResult => ({
  text,
  toolCalls: [],
  usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
  finishReason: "stop",
});

interface StoredEventLike {
  type: string;
  payload: Record<string, unknown>;
}

const of = (events: StoredEventLike[], type: string) => events.filter((event) => event.type === type);

/** Boots the researcher's stream against a real attached MCP server, stamps
 * the M6 definition and drains one turn under `mode`. */
async function runTurn(opts: {
  mode: "ask" | "auto_edits" | "full_auto";
  script: FakeResult[];
  access?: "allowed" | "approval";
}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "fabric-m6-loop-"));
  const runDir = path.join(dataDir, "agent");
  const store: RuntimeStore = await openStore({ driver: "pglite", dataDir });
  const fixture: TestMcpServer = await startTestMcpServer();
  const queue = new MemoryQueue();
  const streamId = `session:${AGENT.id}`;
  try {
    await ensureMcpSchema(store);
    const servers = mcpServers(store, WORKSPACE);
    await servers.add({ name: "local", url: fixture.url, auth: "none" });
    await servers.attach("local", AGENT.id, opts.access ?? "allowed");

    const deps: McpSessionDeps = {
      servers,
      clientFor: async () => mcpClient({ url: fixture.url }),
      scope: async (io) => ({
        workspaceId: io.workspaceId,
        streamId: io.streamId,
        agentId: io.agentId,
        callId: io.callId,
        runDir,
        secret: async () => {
          throw new Error("no secret in this fixture");
        },
      }),
    };
    const definition = await withMcpTools(specialistSessionDef(AGENT), AGENT.id, deps);
    const model = new FakeModel(opts.script);
    const tools = sessionTools({ recall: async () => [], mcp: mcpToolRunner(deps) });

    const events: EventInput[] = [
      { type: "session.created", actor: "api", payload: { agentId: AGENT.id, incognito: false, surfaces: ["app"] } },
      { type: "session.approval_mode_set", actor: "api", payload: { mode: opts.mode } },
      {
        type: "run.created",
        actor: "api",
        payload: { definition, engineVersion: "m6", brief: "", grants: [], budgets: {}, parent: null },
      },
      {
        type: "message.received",
        actor: "user",
        payload: { text: "use the tool", attachments: [], surface: "app", sender: "tester", platformMessageId: "pm-1" },
      },
    ];
    await store.transaction((tx) => append(tx, WORKSPACE, [{ streamId, events }]));
    await store.transaction((tx) =>
      queue.enqueue(tx, { type: "decide", key: `decide:${streamId}:boot`, streamId, workspaceId: WORKSPACE }),
    );

    const drain = async () => {
      await runUntilIdle(
        { store, queue, ports: { model, tools, surface: { send: async () => ({}) } }, workerId: "worker-m6" },
        100,
      );
    };
    await drain();
    const readEvents = async () =>
      (await store.readStream(streamId, { workspaceId: WORKSPACE })) as unknown as StoredEventLike[];

    return {
      fixture,
      definition: definition as unknown as StampedDef,
      readEvents,
      respondWait: (waitId: string) =>
        respond(store, WORKSPACE, streamId, waitId, "approve", { by: "tester", surface: "app", queue }),
      drain,
      cleanup: async () => {
        await store.close();
        await fixture.close();
        await rm(dataDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await store.close();
    await fixture.close();
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }
}

// -- Y5 ------------------------------------------------------------------------

test("Y5 an approval attachment stamps access approval, and under full_auto a call to mcp_local_lookup is an approve wait", async () => {
  const run = await runTurn({
    mode: "full_auto",
    access: "approval",
    script: [callResult("call-y5", "mcp_local_lookup", { q: "x" })],
  });
  try {
    expect(run.definition.toolPolicy?.mcp_local_lookup).toEqual({
      access: "approval",
      gate: "mode",
      kind: "read",
    });

    const events = await run.readEvents();
    const waits = of(events, "human.requested");
    expect(waits).toHaveLength(1);
    expect(waits[0]!.payload.kind).toBe("approve");
    expect((waits[0]!.payload.approval as { tool?: string } | undefined)?.tool).toBe("mcp_local_lookup");
    expect(of(events, "tool.completed")).toEqual([]);
    expect(run.fixture.calls("tools/call")).toBe(0);
  } finally {
    await run.cleanup();
  }
},
20_000,
);

// -- Y6 ------------------------------------------------------------------------

test("Y6 under ask mcp_local_create waits; under auto_edits mcp_local_lookup runs as a tool.call while mcp_local_create waits", async () => {
  // ask: nothing runs unasked
  const ask = await runTurn({
    mode: "ask",
    script: [callResult("call-y6a", "mcp_local_create", { name: "n" })],
  });
  try {
    const events = await ask.readEvents();
    const waits = of(events, "human.requested");
    expect(waits).toHaveLength(1);
    expect(waits[0]!.payload.kind).toBe("approve");
    expect(of(events, "tool.completed")).toEqual([]);
  } finally {
    await ask.cleanup();
  }

  // auto_edits: the read runs
  const edits = await runTurn({
    mode: "auto_edits",
    script: [callResult("call-y6b", "mcp_local_lookup", { q: "x" }), textResult("done")],
  });
  try {
    const events = await edits.readEvents();
    expect(of(events, "human.requested")).toEqual([]);
    const calls = of(events, "tool.call");
    expect(calls.some((event) => event.payload.tool === "mcp_local_lookup")).toBe(true);
    const completed = of(events, "tool.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]!.payload.ok).toBe(true);
    expect((completed[0]!.payload.result as { text?: string } | undefined)?.text).toBe("lookup: x");
    expect(edits.fixture.calls("tools/call")).toBe(1);
  } finally {
    await edits.cleanup();
  }

  // auto_edits: the external still waits
  const editsExternal = await runTurn({
    mode: "auto_edits",
    script: [callResult("call-y6c", "mcp_local_create", { name: "n" })],
  });
  try {
    const events = await editsExternal.readEvents();
    const waits = of(events, "human.requested");
    expect(waits).toHaveLength(1);
    expect(waits[0]!.payload.kind).toBe("approve");
    expect(of(events, "tool.completed")).toEqual([]);
  } finally {
    await editsExternal.cleanup();
  }
},
30_000,
);

// -- Y11 -----------------------------------------------------------------------

test("Y11 loop, mode ask: mcp_local_create waits, respond approve runs the same callId through to tool.completed carrying the server's text", async () => {
  const run = await runTurn({
    mode: "ask",
    script: [callResult("call-y11", "mcp_local_create", { name: "thing" }), textResult("done")],
  });
  try {
    let events = await run.readEvents();
    const wait = of(events, "human.requested")[0];
    expect(wait?.payload.kind).toBe("approve");
    const waitId = String(wait?.payload.waitId);
    const callId = String((wait?.payload.approval as { callId?: unknown } | undefined)?.callId);
    expect(callId).toBe("call-y11");

    expect((await run.respondWait(waitId)).outcome).toBe("accepted");
    await run.drain();

    events = await run.readEvents();
    const respondedAt = events.findIndex((event) => event.type === "human.responded");
    const calledAt = events.findIndex(
      (event) => event.type === "tool.call" && event.payload.callId === callId,
    );
    expect(respondedAt).toBeGreaterThan(-1);
    expect(calledAt).toBeGreaterThan(respondedAt);

    const completed = of(events, "tool.completed").find((event) => event.payload.callId === callId);
    expect(completed?.payload.ok).toBe(true);
    expect((completed?.payload.result as { text?: string } | undefined)?.text).toBe("created thing");
    expect(run.fixture.calls("tools/call")).toBe(1);
  } finally {
    await run.cleanup();
  }
},
20_000,
);
