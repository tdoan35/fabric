// ANY-40 R9c — W14/W14a: the worker loop, end to end. `runUntilIdle` claims and
// dispatches every job the handlers queue for each other until the board is
// still: a session turn runs model → tool → model → reply → deliver; a
// delegation runs the child to its finish and resumes the parent with the
// result, the child's spend folded into the parent's costUsd by the fold. Every
// port is a fake — no model, tool, surface or network is reachable.
import { childRunId, fold } from "@fabric/core";
import { expect, test } from "vitest";
import { append, type EventInput, type RuntimeStore } from "../../index";
import { MemoryQueue } from "../../queue/memory";
import { describeDrivers } from "../../testing/drivers";
import { FakeModel } from "../../testing/fake-model";
import { FakeTools } from "../../testing/fake-tools";
import { FakeSurface } from "../../testing/fake-surface";
import { runUntilIdle } from "../../workers/loop";

const WORKSPACE = "ws-r9c-e2e";

// -- fixtures -------------------------------------------------------------------

const sessionCreated = (definition: Record<string, unknown>): EventInput => ({
  type: "run.created",
  actor: "api",
  payload: { definition, engineVersion: "v1", brief: "", grants: [], budgets: {}, parent: null },
});

const messageReceived = (text: string): EventInput => ({
  type: "message.received",
  actor: "user",
  payload: { text, attachments: [], surface: "app", sender: "tester", platformMessageId: "pm-1" },
});

const modelResult = (
  text: string,
  toolCalls: readonly Record<string, unknown>[],
  costUsd: number
) => ({
  text,
  toolCalls,
  usage: { inputTokens: 1, outputTokens: 1, costUsd },
  finishReason: toolCalls.length > 0 ? "tool-calls" : "stop",
});

async function seed(store: RuntimeStore, streamId: string, events: readonly EventInput[]) {
  await store.transaction((tx) => append(tx, WORKSPACE, [{ streamId, events }]));
}

async function bootstrapDecide(store: RuntimeStore, queue: MemoryQueue, streamId: string) {
  await store.transaction((tx) =>
    queue.enqueue(tx, { type: "decide", key: `decide:${streamId}:bootstrap`, streamId, workspaceId: WORKSPACE })
  );
}

const factsOn = async (store: RuntimeStore, streamId: string) =>
  (await store.readStream(streamId, { workspaceId: WORKSPACE })).filter(
    (event) => event.class === "fact"
  );

describeDrivers("runtime worker loop, end to end (ANY-40 R9c)", (h) => {
  test("W14 a session turn: tool call, then reply, exactly one deliver — the facts in loop order", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const model = new FakeModel([
      modelResult("", [{ name: "echo", id: "c1", args: {} }], 0.2),
      modelResult("done", [], 0.3),
    ]);
    const tools = new FakeTools({ echo: { effect: "read", runs: [{ ok: true, result: "pong" }] } });
    const surface = new FakeSurface();
    const stream = "session:e2e";

    await seed(store, stream, [
      sessionCreated({ systemPrompt: "SYS", tools: ["echo"], surfaces: ["email"], model: "m1" }),
      messageReceived("hi"),
    ]);
    await bootstrapDecide(store, queue, stream);

    const processed = await runUntilIdle({ store, queue, ports: { model, tools, surface }, workerId: "worker-e2e" });
    expect(processed).toBeGreaterThan(0);

    // the loop ran dry: nothing left claimable, a second pass idle
    const again = await runUntilIdle({ store, queue, ports: { model, tools, surface }, workerId: "worker-e2e" });
    expect(again).toBe(0);

    const factTypes = (await factsOn(store, stream)).map((event) => event.type);
    expect(factTypes).toEqual([
      "run.created",
      "message.received",
      "llm.requested",
      "llm.completed",
      "tool.call",
      "tool.completed",
      "llm.requested",
      "llm.completed",
    ]);

    // exactly one deliver happened, of the turn's reply
    expect(surface.sent).toHaveLength(1);
    expect(surface.sent[0]!.text).toBe("done");
    const delivered = (await store.readStream(stream, { workspaceId: WORKSPACE })).filter(
      (event) => event.type === "message.delivered"
    );
    expect(delivered).toHaveLength(1);
  });

  test("W14a a delegation: the parent's turn resumes with the child's result and folds its cost", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const callId = "c1";
    const childStream = `run:${childRunId("session:p", callId)}`;
    const model = new FakeModel([
      // the parent delegates in await mode
      modelResult("", [{ name: "delegate", id: callId, args: { agentId: "sub", mode: "await", brief: "look it up", budgetUsd: 1 } }], 0.1),
      // the child answers in one turn
      modelResult("child answer", [], 0.4),
      // the parent takes the result and finishes
      modelResult("parent done", [], 0.2),
    ]);
    const tools = new FakeTools({});
    const surface = new FakeSurface();
    const parent = "session:p";

    await seed(store, parent, [
      sessionCreated({
        systemPrompt: "P",
        tools: ["delegate"],
        agents: { sub: { definition: { systemPrompt: "SUB", tools: [] }, engineVersion: "v1", tools: [] } },
      }),
      messageReceived("delegate this"),
    ]);
    await bootstrapDecide(store, queue, parent);

    await runUntilIdle({ store, queue, ports: { model, tools, surface }, workerId: "worker-e2e" });

    // the child ran to its finish
    const childFacts = await factsOn(store, childStream);
    const finished = childFacts.find((event) => event.type === "run.finished");
    expect(finished?.payload).toMatchObject({ result: "child answer", costUsd: 0.4 });

    // the parent's call completed with the child's result, and the turn resumed:
    // the next model call saw it as the tool result
    const parentFacts = await factsOn(store, parent);
    const completed = parentFacts.find((event) => event.type === "tool.completed");
    expect(completed?.payload).toMatchObject({
      callId,
      ok: true,
      result: { result: "child answer", costUsd: 0.4 },
    });
    const parentCalls = model.calls.filter((call) => call.system === "P");
    expect(parentCalls).toHaveLength(2);
    const resumed = parentCalls[1]!.messages.find((message) => message.role === "tool");
    expect(resumed?.text).toContain("child answer");

    // the parent's costUsd — the fold's ledger — includes the child's spend
    const state = fold(await store.readStream(parent, { workspaceId: WORKSPACE }), {});
    expect(state.costUsd).toBeCloseTo(0.1 + 0.4 + 0.2, 10);
  });
});
