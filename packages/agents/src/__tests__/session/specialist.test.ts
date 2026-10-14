// ANY-59 S9 — the listed cases G1..G6, verbatim from the card. A specialist's
// direct chat runs on the same agent loop as Dana's: the definition snapshot
// is built from the agent's registry record, carries `ask_user` only (the
// specialists' own tools arrive with ANY-44) and `userChosenAgent`, so every
// turn falls back to the `direct · user-chosen` disposition (S2). Fake model,
// fake memory store, embedded PGlite — no network anywhere.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  append,
  MemoryQueue,
  openStore,
  runUntilIdle,
  type EventInput,
} from "@fabric/runtime";
import { expect, test } from "vitest";
import {
  specialistSessionDef,
  sessionTools,
  withSessionContext,
  type SpecialistAgent,
} from "../../assistant/session";

const WORKSPACE = "ws-s9";
const STREAM = "session:s9";

// -- the registry stub: two agents, the records the registry route serves -------

const RESEARCHER: SpecialistAgent = {
  id: "researcher",
  name: "Renna",
  role: "Research",
  instructions: "# SOUL.md\n\nYou are the studio's researcher. Answer with sources.",
  personality: "Terse, cites everything.",
  model: "Opus 5.5",
};

const WRITER: SpecialistAgent = {
  id: "writer",
  name: "Quill",
  role: "Copywriting",
  instructions: "# SOUL.md\n\nYou are the studio's copywriter.",
  personality: "Warm, plain words.",
  model: "Haiku 4.5",
};

// -- fakes ----------------------------------------------------------------------

interface FakeResult {
  text: string;
  toolCalls: readonly Record<string, unknown>[];
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  finishReason: string;
}

interface FakeTool {
  name: string;
  description?: string;
  parameters?: unknown;
}

/** Records every request verbatim (system, messages, tools, thinking) and plays
 * the script back one entry per call. */
class FakeSessionModel {
  readonly calls: {
    system: string;
    messages: readonly unknown[];
    tools: readonly FakeTool[];
    thinking?: string;
  }[] = [];

  readonly #script: FakeResult[];

  constructor(script: readonly FakeResult[]) {
    this.#script = [...script];
  }

  async call(request: {
    system: string;
    messages: readonly unknown[];
    tools: readonly FakeTool[];
    thinking?: string;
  }): Promise<FakeResult> {
    this.calls.push({
      system: request.system,
      messages: [...request.messages],
      tools: [...request.tools],
      ...(request.thinking !== undefined ? { thinking: request.thinking } : {}),
    });
    const entry = this.#script.shift();
    if (entry === undefined) throw new Error("FakeSessionModel: no scripted entry left");
    return { ...entry, toolCalls: [...entry.toolCalls] };
  }
}

/** The fake memory store: recorded queries, canned facts. */
function recallSpy(facts: readonly { key: string; value: string; source: string }[]) {
  const queries: string[] = [];
  const recall = async (query: string) => {
    queries.push(query);
    return facts.map((fact) => ({ ...fact }));
  };
  return { recall, queries };
}

const textResult = (text: string): FakeResult => ({
  text,
  toolCalls: [],
  usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
  finishReason: "stop",
});

const callResult = (toolCalls: readonly Record<string, unknown>[]): FakeResult => ({
  text: "",
  toolCalls,
  usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
  finishReason: "tool-calls",
});

// -- stream fixtures ------------------------------------------------------------

const sessionCreated = (agentId: string, incognito: boolean): EventInput => ({
  type: "session.created",
  actor: "api",
  payload: { agentId, incognito, surfaces: ["app"] },
});

const runCreated = (definition: Record<string, unknown>): EventInput => ({
  type: "run.created",
  actor: "api",
  payload: { definition, engineVersion: "s9", brief: "", grants: [], budgets: {}, parent: null },
});

const messageReceived = (text: string): EventInput => ({
  type: "message.received",
  actor: "user",
  payload: { text, attachments: [], surface: "app", sender: "tester", platformMessageId: "pm-1" },
});

interface StoredEventLike {
  type: string;
  payload: Record<string, unknown>;
  [key: string]: unknown;
}

/** Boots one specialist session stream with the given definition, posts one
 * message, and drains the worker loop over the fake ports — the S7 harness,
 * the specialist's session facts in place of Dana's. */
async function runTurn(opts: {
  definition: Record<string, unknown>;
  agentId?: string;
  incognito?: boolean;
  script: readonly FakeResult[];
  recall: (query: string) => Promise<readonly { key: string; value: string; source: string }[]>;
}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "fabric-s9-"));
  const store = await openStore({ driver: "pglite", dataDir });
  try {
    const queue = new MemoryQueue();
    const model = new FakeSessionModel(opts.script);
    const agentId = opts.agentId ?? "researcher";

    await store.transaction((tx) =>
      append(tx, WORKSPACE, [
        {
          streamId: STREAM,
          events: [
            sessionCreated(agentId, opts.incognito === true),
            runCreated(opts.definition),
            messageReceived("hello"),
          ],
        },
      ])
    );
    await store.transaction((tx) =>
      queue.enqueue(tx, { type: "decide", key: `decide:${STREAM}:boot`, streamId: STREAM, workspaceId: WORKSPACE })
    );

    await runUntilIdle(
      {
        store,
        queue,
        ports: {
          model: withSessionContext(model, opts.recall),
          tools: sessionTools({ recall: opts.recall }),
          surface: { send: async () => ({}) },
        },
        workerId: "worker-s9",
      },
      100
    );

    const events = (await store.readStream(STREAM, { workspaceId: WORKSPACE })) as unknown as StoredEventLike[];
    return { model, events };
  } finally {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

const of = (events: StoredEventLike[], type: string) => events.filter((event) => event.type === type);

// -- the cases ------------------------------------------------------------------

test("G1 a specialist session: the model gets that agent's prompt and ask_user only; the turn ends with agent.message", async () => {
  const definition = specialistSessionDef(RESEARCHER) as unknown as Record<string, unknown>;
  const recall = recallSpy([]);
  const { model, events } = await runTurn({ definition, script: [textResult("One line.")], recall: recall.recall });

  expect(model.calls).toHaveLength(1);
  expect(model.calls[0]!.system).toBe(RESEARCHER.instructions);
  expect(model.calls[0]!.tools.map((tool) => tool.name)).toEqual(["ask_user"]);

  const message = events.find((event) => event.type === "agent.message") as
    | { payload: { text: string } }
    | undefined;
  expect(message?.payload).toMatchObject({ text: "One line." });
});

test("G2 every turn records the user-chosen disposition exactly once: direct, the agent, source user", async () => {
  const definition = specialistSessionDef(RESEARCHER) as unknown as Record<string, unknown>;
  const recall = recallSpy([]);
  const { events } = await runTurn({ definition, script: [textResult("Two lines.")], recall: recall.recall });

  const dispositions = of(events, "disposition.recorded") as { payload: Record<string, unknown> }[];
  expect(dispositions).toHaveLength(1);
  expect(dispositions[0]!.payload).toMatchObject({ kind: "direct", target: "researcher", source: "user" });
});

test("G3 record_disposition is not offered: a model that calls it anyway gets tool.denied", async () => {
  const definition = specialistSessionDef(RESEARCHER) as unknown as Record<string, unknown>;
  // not offered: neither the allowlist nor the schemas name it
  expect(definition.tools).toEqual(["ask_user"]);
  const schemas = definition.toolSchemas as { name: string }[];
    expect(schemas.map((schema) => schema.name)).not.toContain("record_disposition");

  const recall = recallSpy([]);
  const { events } = await runTurn({
    definition,
    script: [
      callResult([{ id: "c1", name: "record_disposition", args: { kind: "agent", reason: "needs hands" } }]),
      textResult("Done."),
    ],
    recall: recall.recall,
  });

  const denied = of(events, "tool.denied") as { payload: Record<string, unknown> }[];
  expect(denied).toHaveLength(1);
  expect(denied[0]!.payload).toMatchObject({ tool: "record_disposition", callId: "c1" });
  // the turn still lands on the user-chosen disposition, once
  const dispositions = of(events, "disposition.recorded") as { payload: Record<string, unknown> }[];
  expect(dispositions).toHaveLength(1);
  expect(dispositions[0]!.payload).toMatchObject({ kind: "direct", target: "researcher", source: "user" });
});

test("G4 the agent's model id and thinking level reach the model port", async () => {
  const definition = specialistSessionDef(RESEARCHER) as unknown as Record<string, unknown>;
  const recall = recallSpy([]);
  const { model, events } = await runTurn({ definition, script: [textResult("Sure.")], recall: recall.recall });

  // the model id rides the turn's llm.requested — the port's request record
  const requested = of(events, "llm.requested") as { payload: Record<string, unknown> }[];
  expect(requested).toHaveLength(1);
  expect(requested[0]!.payload).toMatchObject({ model: "Opus 5.5" });

  // the thinking level rides the call options: the non-Dana default, not dana's off
  expect(model.calls[0]!.thinking).toBe("medium");

  // the record is the source: the writer's own model, never the researcher's
  const writerDef = specialistSessionDef(WRITER) as unknown as Record<string, unknown>;
  expect(writerDef.model).toBe("Haiku 4.5");
});

test("G6 an incognito specialist session queries no memory: the spy never fires, no memory section", async () => {
  const definition = specialistSessionDef(RESEARCHER, { incognito: true }) as unknown as Record<string, unknown>;
  const recall = recallSpy([{ key: "user.name", value: "Ty", source: "test" }]);
  const { model } = await runTurn({
    definition,
    incognito: true,
    script: [textResult("Answer.")],
    recall: recall.recall,
  });

  expect(recall.queries).toHaveLength(0);
  expect(model.calls[0]!.tools.map((tool) => tool.name)).toEqual(["ask_user"]);
  expect(model.calls[0]!.system).not.toContain("What you remember");
});
