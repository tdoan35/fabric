// ANY-58 S8b — the listed cases H1..H6, verbatim from the card. Dana keeps the
// team handoff and the browser errand on the agent loop by bridging into the
// legacy engines through `tool.exec` with effect `once`: a retried job with no
// recorded result follows R9b's once recovery, so a crash never starts a
// second run. The legacy engines enter as stubs at their module boundary (the
// engine seams the bridge calls); fake model, embedded PGlite — no network,
// no app database.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  append,
  handleToolExecJob,
  MemoryQueue,
  openStore,
  runUntilIdle,
  type EventInput,
  type RuntimeStore,
} from "@fabric/runtime";
import { expect, test } from "vitest";
import { danaSessionDef, sessionTools, withBridges } from "../../assistant/session";

const WORKSPACE = "ws-s8b";
const STREAM = "session:s8b";

/** The user's ask, as the fixture turn carries it. */
const HANDOFF_REQUEST = "Point the launch hero at the new copy and rerun the checks.";
const ERRAND_GOAL = "Renew the studio's domain registration before Friday.";

const CRASH = "crash-after-run";

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

interface BridgeCall {
  input: Record<string, unknown>;
  io: { callId?: string; streamId?: string };
}

/** The legacy engines, stubbed at their boundary: recorded calls, fixed run ids. */
function fakeEngines() {
  const handoffCalls: BridgeCall[] = [];
  const errandCalls: BridgeCall[] = [];
  return {
    handoffCalls,
    errandCalls,
    engines: {
      handoff: async (input: Record<string, unknown>, io: BridgeCall["io"]) => {
        handoffCalls.push({ input, io });
        return { runId: "run-handoff-1" };
      },
      errand: async (input: Record<string, unknown>, io: BridgeCall["io"]) => {
        errandCalls.push({ input, io });
        return { runId: "run-errand-1" };
      },
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
  args: { kind: "agent", reason: "needs hands", considered: ["direct"] },
});

const handoffCall = (id: string, request = HANDOFF_REQUEST): Record<string, unknown> => ({
  id,
  name: "handoff_to_team",
  args: { teamId: "research-team", request },
});

const errandCall = (id: string, goal = ERRAND_GOAL): Record<string, unknown> => ({
  id,
  name: "browser_task",
  args: { goal },
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
  payload: { definition, engineVersion: "s8b", brief: "", grants: [], budgets: {}, parent: null },
});

const messageReceived = (text: string): EventInput => ({
  type: "message.received",
  actor: "user",
  payload: { text, attachments: [], surface: "app", sender: "tester", platformMessageId: "pm-1" },
});

const toolCallFact = (callId: string, tool: string, args: Record<string, unknown>): EventInput => ({
  type: "tool.call",
  actor: "decide",
  payload: { tool, summary: "", callId, args, effect: "once" },
});

interface StoredEventLike {
  type: string;
  payload: Record<string, unknown>;
  [key: string]: unknown;
}

/** Boots one session stream with the bridged definition and the bridge-carrying
 * port; `drain` runs the workers to idle. The crash harness (`crashAfterRun`)
 * and the bare `handleToolExecJob` path serve the R9b cases, exactly as the
 * runtime's own W10 does. */
async function boot(
  script: readonly FakeResult[],
  opts: { incognito?: boolean; engines?: ReturnType<typeof fakeEngines>["engines"] } = {},
) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "fabric-s8b-"));
  const store: RuntimeStore = await openStore({ driver: "pglite", dataDir });
  const queue = new MemoryQueue();
  const model = new FakeSessionModel(script);
  const engines = opts.engines ?? fakeEngines().engines;
  const definition = withBridges(danaSessionDef({ incognito: opts.incognito === true })) as unknown as Record<
    string,
    unknown
  >;
  const tools = sessionTools({ recall: async () => [], ...(opts.engines !== undefined ? { bridges: engines } : {}) });

  await store.transaction((tx) =>
    append(tx, WORKSPACE, [
      {
        streamId: STREAM,
        events: [
          sessionCreated(opts.incognito === true),
          runCreated(definition),
          messageReceived("Please take care of the launch."),
        ],
      },
    ]),
  );
  await store.transaction((tx) =>
    queue.enqueue(tx, { type: "decide", key: `decide:${STREAM}:boot`, streamId: STREAM, workspaceId: WORKSPACE }),
  );

  const drain = () =>
    runUntilIdle(
      {
        store,
        queue,
        ports: {
          model,
          tools,
          surface: { send: async () => ({}) },
        },
        workerId: "worker-s8b",
      },
      100,
    );

  const enqueueToolExec = (key: string) =>
    store.transaction((tx) =>
      queue.enqueue(tx, { type: "tool.exec", key, streamId: STREAM, workspaceId: WORKSPACE }),
    );

  const appendFact = (events: readonly EventInput[]) =>
    store.transaction((tx) => append(tx, WORKSPACE, [{ streamId: STREAM, events: [...events] }]));

  const events = async () =>
    (await store.readStream(STREAM, { workspaceId: WORKSPACE })) as unknown as StoredEventLike[];

  const close = async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  };

  return { store, queue, model, tools, drain, enqueueToolExec, appendFact, events, close };
}

/** The store, with every transaction crashing after its work ran — the
 * at-least-once state: side effects happened, nothing was recorded. Two-phase
 * tool.exec (ANY-80 R14) runs the tool between the read and the record, so
 * the first transaction (the read) passes and the record crashes: the tool
 * ran, the appends and the lease completion rolled back. */
const crashAfterRun = (store: RuntimeStore): RuntimeStore => {
  let seen = 0;
  return {
    transaction: (fn) =>
      store.transaction(async (tx) => {
        const index = seen;
        seen += 1;
        const value = await fn(tx);
        if (index >= 1) throw new Error(CRASH); // the appends and the lease completion roll back
        return value;
      }),
    readStream: (streamId, options) => store.readStream(streamId, options),
    close: () => store.close(),
  };
};

const of = (events: StoredEventLike[], type: string) => events.filter((event) => event.type === type);

// -- the cases ------------------------------------------------------------------

test("H1 handoff_to_team is a once tool.exec: the legacy handoff runs once with the brief, the result carries the run id", async () => {
  const fake = fakeEngines();
  const env = await boot([callResult([disposerCall("c1"), handoffCall("c2")]), textResult("Handed off.")], {
    engines: fake.engines,
  });
  try {
    await env.drain();
    const events = await env.events();

    const call = of(events, "tool.call").find((event) => event.payload.tool === "handoff_to_team");
    expect(call?.payload).toMatchObject({ effect: "once", callId: "c2" });

    expect(fake.handoffCalls).toHaveLength(1);
    expect(fake.handoffCalls[0]!.input).toMatchObject({ teamId: "research-team", request: HANDOFF_REQUEST });

    const completed = of(events, "tool.completed").find((event) => event.payload.callId === "c2");
    expect(completed?.payload).toMatchObject({ ok: true, result: { runId: "run-handoff-1" } });
  } finally {
    await env.close();
  }
});

test("H2 a retried handoff tool.exec with no recorded result starts no second handoff: interrupted, then a human asked", async () => {
  const fake = fakeEngines();
  const env = await boot([], { engines: fake.engines });
  try {
    await env.appendFact([toolCallFact("c2", "handoff_to_team", { teamId: "research-team", request: HANDOFF_REQUEST })]);
    await env.enqueueToolExec(`${STREAM}:c2`);
    const lease = await env.queue.claim("worker-1", ["tool.exec"], 0);
    if (lease === null) throw new Error("expected a claimable tool.exec job");

    await expect(
      handleToolExecJob(lease, {
        store: crashAfterRun(env.store),
        queue: env.queue,
        tools: env.tools,
        now: () => 0,
      }),
    ).rejects.toThrow(CRASH);
    expect(fake.handoffCalls).toHaveLength(1); // the crashed attempt ran it; nothing was recorded

    const retried = await env.queue.claim("worker-2", ["tool.exec"], 30_000); // past the backoff
    expect(retried?.attempt).toBe(2);
    await handleToolExecJob(retried!, { store: env.store, queue: env.queue, tools: env.tools, now: () => 0 });

    expect(fake.handoffCalls).toHaveLength(1); // no second handoff: the run is once
    const events = await env.events();
    const interrupted = of(events, "tool.interrupted");
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]!.payload).toMatchObject({ callId: "c2", effect: "once" });
    const requested = of(events, "human.requested");
    expect(requested).toHaveLength(1);
    expect(requested[0]!.payload).toMatchObject({ prompt: "check whether this happened", gated: false });
    expect(of(events, "tool.completed").filter((event) => event.payload.callId === "c2")).toHaveLength(0);
  } finally {
    await env.close();
  }
});

test("H3 browser_task bridges the errand once: the legacy errand gets the goal, the result carries the run id", async () => {
  const fake = fakeEngines();
  const env = await boot([callResult([disposerCall("c1"), errandCall("c2")]), textResult("Watching it.")], {
    engines: fake.engines,
  });
  try {
    await env.drain();
    const events = await env.events();

    const call = of(events, "tool.call").find((event) => event.payload.tool === "browser_task");
    expect(call?.payload).toMatchObject({ effect: "once", callId: "c2" });

    expect(fake.errandCalls).toHaveLength(1);
    expect(fake.errandCalls[0]!.input).toMatchObject({ goal: ERRAND_GOAL });

    const completed = of(events, "tool.completed").find((event) => event.payload.callId === "c2");
    expect(completed?.payload).toMatchObject({ ok: true, result: { runId: "run-errand-1" } });
  } finally {
    await env.close();
  }
});

test("H4 a retried browser_task with no recorded result starts no second errand: interrupted, then a human asked", async () => {
  const fake = fakeEngines();
  const env = await boot([], { engines: fake.engines });
  try {
    await env.appendFact([toolCallFact("c2", "browser_task", { goal: ERRAND_GOAL })]);
    await env.enqueueToolExec(`${STREAM}:c2`);
    const lease = await env.queue.claim("worker-1", ["tool.exec"], 0);
    if (lease === null) throw new Error("expected a claimable tool.exec job");

    await expect(
      handleToolExecJob(lease, {
        store: crashAfterRun(env.store),
        queue: env.queue,
        tools: env.tools,
        now: () => 0,
      }),
    ).rejects.toThrow(CRASH);
    expect(fake.errandCalls).toHaveLength(1);

    const retried = await env.queue.claim("worker-2", ["tool.exec"], 30_000);
    expect(retried?.attempt).toBe(2);
    await handleToolExecJob(retried!, { store: env.store, queue: env.queue, tools: env.tools, now: () => 0 });

    expect(fake.errandCalls).toHaveLength(1); // no second errand
    const events = await env.events();
    expect(of(events, "tool.interrupted")).toHaveLength(1);
    expect(of(events, "human.requested")).toHaveLength(1);
    expect(of(events, "tool.completed").filter((event) => event.payload.callId === "c2")).toHaveLength(0);
  } finally {
    await env.close();
  }
});

test("H5 the handoff turn's disposition is team with the team id; the errand turn's is agent targeting browser", async () => {
  const fake = fakeEngines();
  const handoff = await boot([callResult([handoffCall("c2")]), textResult("Handed off.")], {
    engines: fake.engines,
  });
  try {
    await handoff.drain();
    const dispositions = of(await handoff.events(), "disposition.recorded");
    expect(dispositions).toHaveLength(1);
    expect(dispositions[0]!.payload).toMatchObject({ kind: "team", target: "research-team", source: "derived" });
  } finally {
    await handoff.close();
  }

  const errand = await boot([callResult([errandCall("c2")]), textResult("Watching it.")], {
    engines: fakeEngines().engines,
  });
  try {
    await errand.drain();
    const dispositions = of(await errand.events(), "disposition.recorded");
    expect(dispositions).toHaveLength(1);
    expect(dispositions[0]!.payload).toMatchObject({ kind: "agent", target: "browser", source: "derived" });
  } finally {
    await errand.close();
  }
});

test("H6 incognito: both bridge tools are still offered, and the engines receive the user's text verbatim", async () => {
  const handoffFake = fakeEngines();
  const handoff = await boot([callResult([disposerCall("c1"), handoffCall("c2")]), textResult("Handed off.")], {
    engines: handoffFake.engines,
    incognito: true,
  });
  try {
    await handoff.drain();
    const offered = handoff.model.calls[0]!.tools.map((tool) => tool.name);
    expect(offered).toContain("handoff_to_team");
    expect(offered).toContain("browser_task");
    expect(offered).not.toContain("recall"); // incognito drops only the memory path
    expect(handoffFake.handoffCalls[0]!.input.request).toBe(HANDOFF_REQUEST); // verbatim, no enrichment
  } finally {
    await handoff.close();
  }

  const errandFake = fakeEngines();
  const errand = await boot([callResult([disposerCall("c1"), errandCall("c2")]), textResult("Watching it.")], {
    engines: errandFake.engines,
    incognito: true,
  });
  try {
    await errand.drain();
    const offered = errand.model.calls[0]!.tools.map((tool) => tool.name);
    expect(offered).toContain("handoff_to_team");
    expect(offered).toContain("browser_task");
    expect(errandFake.errandCalls[0]!.input.goal).toBe(ERRAND_GOAL); // verbatim, no enrichment
  } finally {
    await errand.close();
  }
});
