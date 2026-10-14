// ANY-57 S8a — the listed cases P1..P3 and P7, verbatim from the card, plus the
// loop half of P4 (a decided proposal reaching the next turn's model messages;
// the endpoint half lives in apps/server's session-proposals suite). Dana's
// propose_* tools run as `tool.exec` with effect `idempotent`, write the
// proposal through the store keyed by the call id, and announce
// `proposal.created` on the session stream. Fake model, fake proposal store,
// embedded PGlite — no network, no app database.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  append,
  MemoryQueue,
  openStore,
  runUntilIdle,
  type EventInput,
  type RuntimeStore,
} from "@fabric/runtime";
import { expect, test } from "vitest";
import { danaSessionDef, sessionTools } from "../../assistant/session";
import type { ProposalStore } from "../../assistant/session";
import { DISPOSITION_INSTRUCTION, FIXTURE_SYSTEM } from "./fixture";

const WORKSPACE = "ws-s8a";
const STREAM = "session:s8a";

// -- fakes ----------------------------------------------------------------------

interface FakeResult {
  text: string;
  toolCalls: readonly Record<string, unknown>[];
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  finishReason: string;
}

/** Records every request verbatim and plays the script back one entry per call. */
class FakeSessionModel {
  readonly calls: { system: string; messages: readonly unknown[]; tools: readonly { name: string }[] }[] = [];
  readonly #script: FakeResult[];
  constructor(script: readonly FakeResult[]) {
    this.#script = [...script];
  }
  async call(request: {
    system: string;
    messages: readonly unknown[];
    tools: readonly { name: string }[];
  }): Promise<FakeResult> {
    this.calls.push({ system: request.system, messages: [...request.messages], tools: [...request.tools] });
    const entry = this.#script.shift();
    if (entry === undefined) throw new Error("FakeSessionModel: no scripted entry left");
    return { ...entry, toolCalls: [...entry.toolCalls] };
  }
}

/** The proposal store double: idempotent per (session, callId) — the same
 * contract the db-backed store carries; the loop body must not rely on more. */
function fakeProposalStore(): ProposalStore & {
  rows: { sessionId: string; toolCallId: string; kind: string; proposalId: string }[];
} {
  const rows: { sessionId: string; toolCallId: string; kind: string; proposalId: string }[] = [];
  const seen = new Map<string, string>();
  let next = 1;
  return {
    rows,
    async record(input) {
      const key = `${input.sessionId}:${input.toolCallId}`;
      const existing = seen.get(key);
      if (existing !== undefined) return { proposalId: existing, created: false };
      const proposalId = `prop-${next++}`;
      seen.set(key, proposalId);
      rows.push({ sessionId: input.sessionId, toolCallId: input.toolCallId, kind: input.kind, proposalId });
      return { proposalId, created: true };
    },
    async world() {
      return { agents: [{ id: "elliot", name: "Elliot", role: "lead" }], pool: [] };
    },
  };
}

const callResult = (toolCalls: readonly Record<string, unknown>[]): FakeResult => ({
  text: "",
  toolCalls,
  usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
  finishReason: "tool-calls",
});

const textResult = (text: string): FakeResult => ({
  text,
  toolCalls: [],
  usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
  finishReason: "stop",
});

const disposerCall = (id: string): Record<string, unknown> => ({
  id,
  name: "record_disposition",
  args: { kind: "propose", reason: "no team covers it", considered: ["direct"] },
});

const proposeCall = (id: string): Record<string, unknown> => ({
  id,
  name: "propose_team",
  args: { name: "Dig Team", purpose: "dig", roster: ["elliot"] },
});

const sessionCreated = (definition: Record<string, unknown>): readonly Event[] =>
  [
    {
      type: "session.created",
      actor: "api",
      payload: { agentId: "dana", incognito: false, surfaces: ["app"] },
    },
    {
      type: "run.created",
      actor: "api",
      payload: { definition, engineVersion: "s8a", brief: "", grants: [], budgets: {}, parent: null },
    },
    {
      type: "message.received",
      actor: "user",
      payload: { text: "propose a team", attachments: [], surface: "app", sender: "tester", platformMessageId: "pm-1" },
    },
  ] as const;

interface StoredEventLike {
  type: string;
  payload: Record<string, unknown>;
  [key: string]: unknown;
}

type Event = EventInput;

/** Boots the session stream and the loop's ports; `drain` runs the workers to
 * idle, `reenqueueToolExec` re-queues a handled tool.exec key (the at-least-once
 * re-run), `appendFact` does what the server's endpoints do. */
async function boot(script: readonly FakeResult[]) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "fabric-s8a-"));
  const store: RuntimeStore = await openStore({ driver: "pglite", dataDir });
  const queue = new MemoryQueue();
  const model = new FakeSessionModel(script);
  const proposals = fakeProposalStore();
  const tools = sessionTools({
    recall: async () => [],
    proposals: { store: proposals, loop: { store, workspace: WORKSPACE } },
  });

  await store.transaction((tx) =>
    append(tx, WORKSPACE, [{ streamId: STREAM, events: [...sessionCreated(danaSessionDef() as unknown as Record<string, unknown>)] }]),
  );
  await store.transaction((tx) =>
    queue.enqueue(tx, { type: "decide", key: `decide:${STREAM}:boot`, streamId: STREAM, workspaceId: WORKSPACE }),
  );

  const drain = () =>
    runUntilIdle(
      {
        store,
        queue,
        ports: { model, tools, surface: { send: async () => ({}) } },
        workerId: "worker-s8a",
      },
      100,
    );

  const reenqueueToolExec = (key: string) =>
    store.transaction((tx) =>
      queue.enqueue(tx, { type: "tool.exec", key, streamId: STREAM, workspaceId: WORKSPACE }),
    );

  const appendFact = (events: readonly Event[], streamId = STREAM) =>
    store.transaction((tx) => append(tx, WORKSPACE, [{ streamId, events: [...events] }]));

  const events = async () =>
    (await store.readStream(STREAM, { workspaceId: WORKSPACE })) as unknown as StoredEventLike[];

  const close = async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  };

  return { store, queue, model, proposals, tools, drain, reenqueueToolExec, appendFact, events, close };
}

const of = (events: StoredEventLike[], type: string) => events.filter((event) => event.type === type);

// -- the cases ------------------------------------------------------------------

test("P1 propose_team is an idempotent tool.exec: one proposal row, one proposal.created, proposalId in the result", async () => {
  const env = await boot([callResult([disposerCall("c1"), proposeCall("c2")]), textResult("Proposed.")]);
  try {
    await env.drain();
    const events = await env.events();

    const call = of(events, "tool.call").find((event) => event.payload.tool === "propose_team");
    expect(call?.payload).toMatchObject({ effect: "idempotent", callId: "c2" });

    // the model saw the declaration, and the prompt is the S7 fixture's
    expect(env.model.calls[0]!.tools.map((tool) => tool.name)).toContain("propose_team");
    expect(env.model.calls[0]!.system).toBe(FIXTURE_SYSTEM);
    expect(env.model.calls[0]!.system).toContain(DISPOSITION_INSTRUCTION);

    const completed = of(events, "tool.completed").find((event) => event.payload.callId === "c2");
    const proposalId = (completed?.payload.result as { proposalId?: string } | undefined)?.proposalId;
    expect(typeof proposalId).toBe("string");

    expect(env.proposals.rows).toHaveLength(1);
    expect(env.proposals.rows[0]).toEqual({
      sessionId: "s8a",
      toolCallId: "c2",
      kind: "team",
      proposalId,
    });

    const created = of(events, "proposal.created");
    expect(created).toHaveLength(1);
    expect(created[0]!.payload).toMatchObject({ kind: "team" });
    expect(JSON.stringify(created[0]!.payload.definition)).toContain("Dig Team");
  } finally {
    await env.close();
  }
});

test("P2 retrying the recorded tool.exec appends no second row and no second proposal.created", async () => {
  const env = await boot([callResult([disposerCall("c1"), proposeCall("c2")]), textResult("Proposed.")]);
  try {
    await env.drain();
    expect(of(await env.events(), "proposal.created")).toHaveLength(1);
    expect(env.proposals.rows).toHaveLength(1);

    await env.reenqueueToolExec(`${STREAM}:c2`);
    await env.drain();

    const events = await env.events();
    expect(of(events, "proposal.created")).toHaveLength(1);
    expect(of(events, "tool.completed").filter((event) => event.payload.callId === "c2")).toHaveLength(1);
    expect(env.proposals.rows).toHaveLength(1);
  } finally {
    await env.close();
  }
});

test("P3 a crash after the row landed but before tool.completed: the retry returns the same proposalId, no second row", async () => {
  const env = await boot([callResult([disposerCall("c1"), proposeCall("c2")]), textResult("Proposed.")]);
  try {
    // the crash state, replayed: the body's effects are durable, the completion
    // is not — the row (and its announcement) exist, no tool.completed yet.
    const first = await env.tools.run("propose_team", { name: "Dig Team", purpose: "dig", roster: ["elliot"] }, {
      callId: "c2",
      streamId: STREAM,
    } as never);
    expect(first.ok).toBe(true); // the crash state's row write succeeded
    const proposalId = (first.result as { proposalId: string }).proposalId;
    const mid = await env.events();
    expect(of(mid, "proposal.created")).toHaveLength(1);
    expect(of(mid, "tool.completed").filter((event) => event.payload.callId === "c2")).toHaveLength(0);

    // the retried job finds the tool.call and finishes the attempt
    await env.appendFact([
      {
        type: "tool.call",
        actor: "decide",
        payload: {
          tool: "propose_team",
          summary: "",
          callId: "c2",
          args: { name: "Dig Team", purpose: "dig", roster: ["elliot"] },
          effect: "idempotent",
        },
      },
    ]);
    await env.reenqueueToolExec(`${STREAM}:c2`);
    await env.drain();

    const events = await env.events();
    expect(env.proposals.rows).toHaveLength(1);
    expect(of(events, "proposal.created")).toHaveLength(1);
    const completed = of(events, "tool.completed").find((event) => event.payload.callId === "c2");
    expect((completed?.payload.result as { proposalId?: string })?.proposalId).toBe(proposalId);
  } finally {
    await env.close();
  }
});

test("P4 a decided proposal reaches the next turn's model call as a user-visible input", async () => {
  const env = await boot([
    callResult([disposerCall("c1"), proposeCall("c2")]),
    textResult("Proposed; awaiting the decision."),
    textResult("On it."),
  ]);
  try {
    await env.drain();
    expect(env.model.calls).toHaveLength(2);

    // what the decision endpoint does: the fact, then the re-decide
    await env.appendFact([{ type: "proposal.decided", actor: "api", payload: { kind: "team", decision: "approve", by: "user" } }]);
    await env.store.transaction((tx) =>
      env.queue.enqueue(tx, { type: "decide", key: `decide:${STREAM}:turn2`, streamId: STREAM, workspaceId: WORKSPACE }),
    );
    await env.drain();

    expect(env.model.calls).toHaveLength(3);
    const turn2 = env.model.calls[2]!.messages as { role: string; text?: string }[];
    const decision = turn2.find((message) => message.role === "user" && String(message.text).includes("approve"));
    expect(decision).toBeDefined();
  } finally {
    await env.close();
  }
});

test("P7 the proposing turn's disposition is propose, derived when the model records none", async () => {
  const env = await boot([callResult([proposeCall("c9")]), textResult("Proposed.")]);
  try {
    await env.drain();
    const events = await env.events();
    const dispositions = of(events, "disposition.recorded");
    expect(dispositions).toHaveLength(1);
    expect(dispositions[0]!.payload).toMatchObject({ kind: "propose", source: "derived" });
  } finally {
    await env.close();
  }
});
