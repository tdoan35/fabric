// ANY-56 S7 — the listed cases A1..A8, verbatim from the card. Dana's turn runs
// on the durable agent loop: the definition snapshot carries the system prompt
// and tool schemas, `ll.call` hands them to the model, `record_disposition` and
// `ask_user` stay virtual, `recall` runs on the ToolPort, and the per-turn cap
// and MAX_STEPS end the turn. Fake model, fake memory store, embedded PGlite —
// no network anywhere.
import { mkdtemp } from "node:fs/promises";
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
  assembleContext,
  danaSessionDef,
  sessionTools,
  withSessionContext,
} from "../../assistant/session";
import { DISPOSITION_INSTRUCTION, FIXTURE_SYSTEM } from "./fixture";

const WORKSPACE = "ws-s7";

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

const textResult = (text: string, costUsd = 0.01): FakeResult => ({
  text,
  toolCalls: [],
  usage: { inputTokens: 1, outputTokens: 1, costUsd },
  finishReason: "stop",
});

const callResult = (
  toolCalls: readonly Record<string, unknown>[],
  rest: Partial<FakeResult> = {}
): FakeResult => ({
  text: "",
  toolCalls,
  usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
  finishReason: "tool-calls",
  ...rest,
});

// -- stream fixtures ------------------------------------------------------------

const sessionCreated = (incognito: boolean): EventInput => ({
  type: "session.created",
  actor: "api",
  payload: { agentId: "dana", incognito, surfaces: ["app"] },
});

const runCreated = (definition: Record<string, unknown>): EventInput => ({
  type: "run.created",
  actor: "api",
  payload: { definition, engineVersion: "s7", brief: "", grants: [], budgets: {}, parent: null },
});

const messageReceived = (text: string): EventInput => ({
  type: "message.received",
  actor: "user",
  payload: { text, attachments: [], surface: "app", sender: "tester", platformMessageId: "pm-1" },
});

interface StoredEventLike {
  type: string;
  payload: unknown;
  [key: string]: unknown;
}

/** Boots one session stream with the given definition, posts one message, and
 * drains the real worker loop over the fake ports. */
async function runTurn(opts: {
  definition: Record<string, unknown>;
  incognito: boolean;
  script: readonly FakeResult[];
  recall: (query: string) => Promise<readonly { key: string; value: string; source: string }[]>;
}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "fabric-s7-"));
  const store = await openStore({ driver: "pglite", dataDir });
  try {
    const queue = new MemoryQueue();
    const model = new FakeSessionModel(opts.script);
    const stream = "session:s7";

    await store.transaction((tx) =>
      append(tx, WORKSPACE, [
        {
          streamId: stream,
          events: [sessionCreated(opts.incognito), runCreated(opts.definition), messageReceived("hello")],
        },
      ])
    );
    await store.transaction((tx) =>
      queue.enqueue(tx, { type: "decide", key: `decide:${stream}:boot`, streamId: stream, workspaceId: WORKSPACE })
    );

    const sent: string[] = [];
    await runUntilIdle({
      store,
      queue,
      ports: {
        model: withSessionContext(model, opts.recall),
        tools: sessionTools({ recall: opts.recall }),
        surface: {
          send: async (_target: string, message: { text: string }) => {
            sent.push(message.text);
            return {};
          },
        },
      },
      workerId: "worker-s7",
    });

    const events = (await store.readStream(stream, { workspaceId: WORKSPACE })) as StoredEventLike[];
    return { model, events, sent };
  } finally {
    await store.close();
  }
}

// -- the cases ------------------------------------------------------------------

test("A1 a plain question: the model gets Dana's system prompt and the three tools; the turn ends with agent.message", async () => {
  const definition = danaSessionDef() as unknown as Record<string, unknown>;
  const recall = recallSpy([]);
  const { model, events } = await runTurn({
    definition,
    incognito: false,
    script: [textResult("One line.")],
    recall: recall.recall,
  });

  expect(model.calls).toHaveLength(1);
  expect(model.calls[0]!.system).toBe(FIXTURE_SYSTEM);
  expect(model.calls[0]!.system).toContain(DISPOSITION_INSTRUCTION);
  expect(model.calls[0]!.tools.map((tool) => tool.name)).toEqual([
    "record_disposition",
    "ask_user",
    "recall",
  ]);

  const message = events.find((event) => event.type === "agent.message") as
    | { payload: { text: string } }
    | undefined;
  expect(message?.payload).toMatchObject({ text: "One line." });
});

test("A2 record_disposition then answer: one model-source disposition with its considered list, no tool.exec", async () => {
  const definition = danaSessionDef() as unknown as Record<string, unknown>;
  const recall = recallSpy([]);
  const { model, events } = await runTurn({
    definition,
    incognito: false,
    script: [
      callResult([
        { id: "c1", name: "record_disposition", args: { kind: "direct", reason: "plain question", considered: ["agent", "clarify"] } },
      ]),
      textResult("Two lines."),
    ],
    recall: recall.recall,
  });

  expect(model.calls).toHaveLength(2);
  const dispositions = events.filter((event) => event.type === "disposition.recorded") as
    { payload: Record<string, unknown> }[];
  expect(dispositions).toHaveLength(1);
  expect(dispositions[0]!.payload).toMatchObject({ source: "model", considered: ["agent", "clarify"] });
  expect(events.filter((event) => event.type === "tool.call")).toHaveLength(0);
  const message = events.find((event) => event.type === "agent.message") as
    | { payload: { text: string } }
    | undefined;
  expect(message?.payload).toMatchObject({ text: "Two lines." });
});

test("A3 recall is a read tool.exec whose result reaches the next model call's messages", async () => {
  const definition = danaSessionDef() as unknown as Record<string, unknown>;
  const recall = recallSpy([{ key: "user.home", value: "1117 Ocean Ave", source: "test" }]);
  const { model, events } = await runTurn({
    definition,
    incognito: false,
    script: [
      callResult([{ id: "c1", name: "recall", args: { query: "home address" } }]),
      textResult("It is 1117 Ocean Ave."),
    ],
    recall: recall.recall,
  });

  const call = events.find((event) => event.type === "tool.call") as
    | { payload: Record<string, unknown> }
    | undefined;
  expect(call?.payload).toMatchObject({ tool: "recall", effect: "read" });

  const toolMessages = (model.calls[1]!.messages as { role: string; text: string }[]).filter(
    (message) => message.role === "tool"
  );
  expect(toolMessages).toHaveLength(1);
  expect(JSON.stringify(toolMessages[0])).toContain("1117 Ocean Ave");
});

test("A4 an incognito session: no recall tool, the memory store is never queried, no memory section", async () => {
  const definition = danaSessionDef({ incognito: true }) as unknown as Record<string, unknown>;
  const recall = recallSpy([{ key: "user.name", value: "Ty", source: "test" }]);
  const { model, events } = await runTurn({
    definition,
    incognito: true,
    script: [textResult("Answer.")],
    recall: recall.recall,
  });

  expect(model.calls[0]!.tools.map((tool) => tool.name)).toEqual(["record_disposition", "ask_user"]);
  expect(recall.queries).toHaveLength(0);
  expect(model.calls[0]!.system).toBe(definition.system);
  expect(model.calls[0]!.system).not.toContain("What you remember");
  expect(events.find((event) => event.type === "agent.message")).toBeDefined();
});

test("A5 the per-turn cap ends the turn after one call with the cap message and a derived disposition", async () => {
  const definition = danaSessionDef({ turnCostCapUsd: 0.01 }) as unknown as Record<string, unknown>;
  const recall = recallSpy([]);
  const { model, events } = await runTurn({
    definition,
    incognito: false,
    // one call at 0.02 USD is over the 0.01 cap
    script: [textResult("", 0.02)],
    recall: recall.recall,
  });

  expect(model.calls).toHaveLength(1);
  const message = events.find((event) => event.type === "agent.message") as
    | { payload: { text: string } }
    | undefined;
  expect(message?.payload.text).toContain("cost cap");
  const dispositions = events.filter((event) => event.type === "disposition.recorded") as
    { payload: Record<string, unknown> }[];
  expect(dispositions).toHaveLength(1);
  expect(dispositions[0]!.payload).toMatchObject({ source: "derived" });
});

test("A6 maxSteps: a model that always recalls is stopped after six calls", async () => {
  const definition = danaSessionDef() as unknown as Record<string, unknown>;
  const recall = recallSpy([]);
  const script = Array.from({ length: 6 }, (_, index) =>
    callResult([{ id: `c${index}`, name: "recall", args: { query: "q" } }])
  );
  const { model } = await runTurn({ definition, incognito: false, script, recall: recall.recall });

  expect(model.calls).toHaveLength(6);
});

test("A7 the session's thinking level reaches the model port's call options", async () => {
  const definition = danaSessionDef({ thinking: "low" }) as unknown as Record<string, unknown>;
  const recall = recallSpy([]);
  const { model } = await runTurn({
    definition,
    incognito: false,
    script: [textResult("Answer.")],
    recall: recall.recall,
  });

  expect(model.calls[0]!.thinking).toBe("low");
});

test("A8 a plain session's context carries the recalled facts as a memory section on the system prompt", async () => {
  const definition = danaSessionDef() as unknown as Record<string, unknown>;
  const recall = recallSpy([{ key: "user.name", value: "Ty Doan", source: "test" }]);
  const { model } = await runTurn({
    definition,
    incognito: false,
    script: [textResult("Hello.")],
    recall: recall.recall,
  });

  expect(recall.queries).toEqual(["hello"]); // the turn's user text
  expect(model.calls[0]!.system.startsWith(definition.system as string)).toBe(true);
  expect(model.calls[0]!.system).toContain("Ty Doan");
});

test("A9 assembleContext directly: incognito never queries, an empty query never queries", async () => {
  const recall = recallSpy([{ key: "k", value: "v", source: "s" }]);
  const facts = { system: "SYS", messages: [{ role: "user" as const, text: "hello" }] };
  const incognito = await assembleContext({ session: { incognito: true } }, facts, recall.recall);
  expect(incognito.system).toBe("SYS");
  expect(recall.queries).toHaveLength(0);

  const noQuery = await assembleContext(
    { session: { incognito: false } },
    { system: "SYS", messages: [] },
    recall.recall
  );
  expect(noQuery.system).toBe("SYS");
  expect(recall.queries).toHaveLength(0);

  const assembled = await assembleContext({ session: { incognito: false } }, facts, recall.recall);
  expect(assembled.system).not.toBe("SYS");
  expect(recall.queries).toEqual(["hello"]);
});
