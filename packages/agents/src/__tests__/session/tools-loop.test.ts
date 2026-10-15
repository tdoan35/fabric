// ANY-81 T14 — the listed cases J6..J7, verbatim from the card. The session
// loop with real host tools behind the registry: the approval gate holds the
// call as a `human.requested` approve wait (T3), the answer resumes it as a
// `tool.call`, and the host tool runs against the scope the caller built.
// Embedded PGlite, scripted model, temp runDir — no network.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { append, MemoryQueue, openStore, respond, runUntilIdle, type EventInput } from "@fabric/runtime";
import { expect, test } from "vitest";
import { createRegistry } from "@fabric/tools";
import { hostTools } from "@fabric/tools/host";
import {
  definitionAccess,
  specialistSessionDef,
  sessionTools,
  withToolset,
  type SpecialistAgent,
} from "../../assistant/session";

const WORKSPACE = "ws-t14";
const STREAM = "session:t14";

const AGENT: SpecialistAgent = {
  id: "researcher",
  name: "Renna",
  role: "Research",
  instructions: "# SOUL.md\n\nYou are the studio's researcher.",
};

interface FakeResult {
  text: string;
  toolCalls: readonly Record<string, unknown>[];
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  finishReason: string;
}

/** The scripted model: one entry per call, verbatim. */
class FakeModel {
  calls: number = 0;
  readonly #script: FakeResult[];
  constructor(script: FakeResult[]) {
    this.#script = [...script];
  }
  async call(_request: unknown): Promise<FakeResult> {
    const entry = this.#shift();
    this.calls += 1;
    return entry;
  }
  #shift(): FakeResult {
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

/** The turn's definition: the specialist stamp with the sprite.exec row through
 * the real host registry, plus a far-out ask deadline so the timer never fires
 * inside the test. */
function turnDefinition(registry: ReturnType<typeof createRegistry>) {
  const access = definitionAccess([{ name: "sprite.exec", policy: "allowed" }], new Set(registry.names()));
  const def = withToolset(specialistSessionDef(AGENT), { registry, access }) as Record<string, unknown> & {
    askWaitMs?: number;
  };
  def.askWaitMs = 3_600_000;
  return def;
}

interface StoredEventLike {
  type: string;
  payload: Record<string, unknown>;
}

/** Boots the stream, drains phase one (to the wait or the calls), and hands
 * back everything the assertions need. */
async function runTurn(opts: {
  script: FakeResult[];
  beforeMessage?: EventInput;
  drainAfterRespond?: boolean;
  respondTo?: string; // the wait id; undefined = no respond phase
}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "fabric-t14-loop-"));
  const runDir = path.join(dataDir, "agent");
  const store = await openStore({ driver: "pglite", dataDir });
  try {
    const queue = new MemoryQueue();
    const registry = createRegistry(hostTools());
    const model = new FakeModel(opts.script);

    const scopeCalls: Record<string, unknown>[] = [];
    const tools = sessionTools({
      recall: async () => [],
      registry: {
        tools: registry,
        scope: async (io) => {
          scopeCalls.push({ ...io });
          return {
            workspaceId: io.workspaceId,
            streamId: io.streamId,
            agentId: io.agentId,
            callId: io.callId,
            runDir,
            secret: async () => {
              throw new Error("no secret in this fixture");
            },
          };
        },
      },
    });

    const definition = turnDefinition(registry);
    await store.transaction((tx) =>
      append(tx, WORKSPACE, [
        {
          streamId: STREAM,
          events: [
            { type: "session.created", actor: "api", payload: { agentId: "researcher", incognito: false, surfaces: ["app"] } },
            { type: "run.created", actor: "api", payload: { definition, engineVersion: "t14", brief: "", grants: [], budgets: {}, parent: null } },
            ...(opts.beforeMessage ?? []),
            { type: "message.received", actor: "user", payload: { text: "hello", attachments: [], surface: "app", sender: "tester", platformMessageId: "pm-1" } },
          ],
        },
      ]),
    );
    await store.transaction((tx) =>
      queue.enqueue(tx, { type: "decide", key: `decide:${STREAM}:boot`, streamId: STREAM, workspaceId: WORKSPACE }),
    );

    await runUntilIdle({ store, queue, ports: { model, tools, surface: { send: async () => ({}) } }, workerId: "worker-t14" }, 100);

    const events = () =>
      store.readStream(STREAM, { workspaceId: WORKSPACE }) as Promise<unknown[]> as Promise<StoredEventLike[]>;
    let all = await events();
    const afterFirstDrain = all;

    if (opts.respondTo !== undefined) {
      const wait = afterFirstDrain.find((event) => event.type === "human.requested");
      const waitId = (wait!.payload as { waitId: string }).waitId;
      const outcome = await respond(store, WORKSPACE, STREAM, waitId, opts.respondTo, {
        by: "tester",
        surface: "app",
        queue,
      });
      expect((outcome as { outcome: string }).outcome).toBe("accepted");
      await runUntilIdle({ store, queue, ports: { model, tools, surface: { send: async () => ({}) } }, workerId: "worker-t14" }, 100);
      all = await events();
    }

    return { store, all, afterFirstDrain, scopeCalls, runDir, model, events, cleanup:() => Promise.all([store.close(), rm(dataDir, { recursive: true, force: true })]) };
  } catch (error) {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }
}

const of = (events: StoredEventLike[], type: string) => events.filter((event) => event.type === type);

// -- J6 ------------------------------------------------------------------------

test("J6 loop, mode ask: the edit holds as an approve wait, the answer resumes the very call, the file lands", async () => {
  const { all, afterFirstDrain, runDir, model, cleanup } = await runTurn({
    script: [callResult("c1", "write_file", { path: "notes.txt", content: "hi" }), textResult("done")],
    respondTo: "approve",
  });
  const _unused = model;
  try {
    // phase one: the wait, no tool.call yet
    const waits = of(afterFirstDrain, "human.requested");
    expect(waits).toHaveLength(1);
    expect(waits[0]!.payload).toMatchObject({ kind: "approve" });
    const approval = waits[0]!.payload.approval as { callId: string; tool: string };
    expect(approval).toMatchObject({ callId: "c1", tool: "write_file" });
    expect(of(afterFirstDrain, "tool.call")).toEqual([]);

    // phase two: the same callId, the completion, the file
    const calls = of(all, "tool.call") as { payload: Record<string, unknown> }[];
    expect(calls.map((call) => call.payload.callId)).toEqual(["c1"]);
    const completed = of(all, "tool.completed") as { payload: Record<string, unknown> }[];
    expect(completed).toHaveLength(1);
    expect(completed[0]!.payload).toMatchObject({ callId: "c1", ok: true });
    expect(await readFile(path.join(runDir, "notes.txt"), "utf8")).toBe("hi");

    // the scripted reply ends the turn
    expect(of(all, "agent.message").length).toBeGreaterThanOrEqual(1);
  } finally {
    await cleanup();
  }
});

// -- J7 ------------------------------------------------------------------------

test("J7 loop, mode auto_edits: the edit runs unasked, the command still asks", async () => {
  const { all, cleanup } = await runTurn({
    script: [
      callResult("c1", "write_file", { path: "notes.txt", content: "hi" }),
      callResult("c2", "shell", { command: "echo hi" }),
      textResult("done"),
    ],
    beforeMessage: [{ type: "session.approval_mode_set", actor: "user", payload: { mode: "auto_edits" } }],
  });
  try {
    const calls = of(all, "tool.call") as { payload: Record<string, unknown> }[];
    expect(calls.map((call) => call.payload.callId)).toEqual(["c1"]);

    const waits = of(all, "human.requested") as { payload: Record<string, unknown> }[];
    expect(waits).toHaveLength(1);
    expect(waits[0]!.payload).toMatchObject({ kind: "approve" });
    expect((waits[0]!.payload.approval as { tool: string }).tool).toBe("shell");

    const completed = of(all, "tool.completed") as { payload: Record<string, unknown> }[];
    expect(completed.map((c) => c.payload.callId)).toEqual(["c1"]);
    expect(completed[0]!.payload).toMatchObject({ ok: true });

    // the wait is still open: the turn has not ended
    expect(of(all, "agent.message")).toEqual([]);
  } finally {
    await cleanup();
  }
});

const _path = path;
