// ANY-82 T17 — the listed cases K2..K10, verbatim from the card. The two new
// command routes against a real runtime store (embedded PGlite, no network):
// the wait answer rides R10's `respond` with the app identity, the
// approval-mode put folds once and appends only on change. Facts are appended
// directly where a case needs a wait; K10 runs the real worker loop over a
// scripted model port, the T14 stamp carrying the toolset.
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { fold } from "@fabric/core";
import { append, runWorker, type EventInput } from "@fabric/runtime";
import type { ModelCallRequest, ModelResult } from "@fabric/runtime";
import type { SpecialistAgent } from "@fabric/agents/session";
import { afterEach, expect, test } from "vitest";
import {
  RUNTIME_WORKSPACE,
  setSessionAgents,
  setRuntime,
  startRuntime,
  workerPorts,
  type FabricRuntime,
} from "../runtime/bootstrap";
import { sessions } from "../routes/sessions";

const app = (): Hono => new Hono().route("/api", sessions);

const call = async (method: string, path: string, body?: unknown): Promise<Response> =>
  app().request(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { "content-type": "application/json" },
  });

const postJson = (path: string, body?: unknown): Promise<Response> => call("POST", path, body);
const putJson = (path: string, body?: unknown): Promise<Response> => call("PUT", path, body);

const createSession = async (agentId = "waiter"): Promise<string> => {
  const response = await postJson("/api/sessions", { agentId });
  expect(response.status).toBe(200);
  return ((await response.json()) as { sessionId: string }).sessionId;
};

/** Poll until `run` returns a value; the worker loop's window. */
async function until<T>(run: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await run();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("condition not reached within the window");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const eventsOf = async (sessionId: string) =>
  rt!.store.readStream(`session:${sessionId}`, { workspaceId: RUNTIME_WORKSPACE });

const eventCount = async (sessionId: string): Promise<number> => (await eventsOf(sessionId)).length;

const respondedOn = async (sessionId: string) =>
  (await eventsOf(sessionId)).filter((event) => event.type === "human.responded");

const approvalWaitsOn = async (sessionId: string) =>
  (await eventsOf(sessionId)).filter(
    (event) =>
      event.type === "human.requested" &&
      (event.payload as Record<string, unknown>).kind === "approve",
  );

/** An open approval wait, appended directly: the T3 shape decide holds calls on. */
const approveWait = (
  waitId: string,
  callId: string,
  opts: { gated?: boolean; deadline?: number | null } = {},
): EventInput => ({
  type: "human.requested",
  actor: "api",
  payload: {
    waitId,
    kind: "approve",
    gated: opts.gated ?? false,
    prompt: `Allow write_file: ${callId}?`,
    deadline: opts.deadline ?? null,
    approval: { callId, tool: "write_file", args: { path: "out.txt" }, summary: "write it" },
  },
});

/** An open `ask_user` answer wait (S2): any non-empty text answers it. */
const answerWait = (waitId: string): EventInput => ({
  type: "human.requested",
  actor: "api",
  payload: { waitId, kind: "answer", gated: false, prompt: "On which day?", deadline: null },
});

const addWait = async (sessionId: string, event: EventInput): Promise<void> => {
  await rt!.store.transaction((tx) =>
    append(tx, RUNTIME_WORKSPACE, [{ streamId: `session:${sessionId}`, events: [event] }]),
  );
};

let dataDir: string | undefined;
let rt: FabricRuntime | undefined;
let workers: Promise<void>[] = [];
let workerSignal: AbortController | undefined;

const stopWorkers = async (): Promise<void> => {
  workerSignal?.abort();
  workerSignal = undefined;
  await Promise.allSettled(workers);
  workers = [];
};

afterEach(async () => {
  await stopWorkers();
  setRuntime(undefined);
  if (rt) await rt.stop();
  rt = undefined;
  if (dataDir !== undefined) {
    await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  }
});

const boot = async (env: Record<string, string> = {}): Promise<void> => {
  dataDir = await mkdtemp(path.join(tmpdir(), "fabric-t17-server-"));
  rt = await startRuntime(
    {
      RUNTIME_PGLITE_DIR: dataDir,
      MODEL_PORT: "test",
      FABRIC_MASTER_KEY_FILE: path.join(dataDir, "master.key"),
      ...env,
    },
    // the command surface only; the cases that need the loop start their own
    { worker: false },
  );
};

/** A model port with the one rule K10's turn needs: the first call of a turn
 * asks for the write, every continuation answers with text and ends it. */
const scriptedModel = () => {
  let n = 0;
  return {
    call: async (request: ModelCallRequest): Promise<ModelResult> => {
      const last = request.messages[request.messages.length - 1];
      n += 1;
      if (last?.role === "user") {
        return {
          text: "",
          toolCalls: [{ id: `c${n}`, name: "write_file", args: { path: "hello.txt", content: "kept" } }],
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
          finishReason: "tool_calls",
        };
      }
      return { text: "done", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, finishReason: "stop" };
    },
  };
};

/** The worker loop over the real ports, the model scripted (K10). */
const startWorker = (workDir: string): void => {
  if (rt === undefined) throw new Error("boot first");
  workerSignal = new AbortController();
  const ports = {
    ...workerPorts({ FABRIC_WORK_DIR: workDir }, rt.live, undefined, rt.store, rt.vault),
    model: scriptedModel(),
  };
  workers = [
    runWorker({
      store: rt.store,
      queue: rt.queue,
      ports,
      workerId: "t17-k10",
      signal: workerSignal.signal,
      pollIntervalMs: 25,
    }),
  ];
};

// -- K2 -----------------------------------------------------------------------

test(
  "K2 an open approve wait answered on the route: accepted, user/app on the fact, one decide queued",
  { timeout: 20_000 },
  async () => {
  await boot();
  const sessionId = await createSession();
  await addWait(sessionId, approveWait("approve:1:c1", "c1"));

  const response = await postJson(`/api/sessions/${sessionId}/waits/approve:1:c1`, { decision: "approve" });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ outcome: "accepted" });

  const responded = await respondedOn(sessionId);
  expect(responded).toHaveLength(1);
  expect(responded[0]!.payload).toEqual({
    waitId: "approve:1:c1",
    decision: "approve",
    by: "user",
    surface: "app",
  });

  const jobs = await rt!.store.transaction((tx) =>
    tx.query(`select id, status from jobs where stream_id = $1 and type = 'decide'`, [
      `session:${sessionId}`,
    ]),
  );
  expect(jobs).toHaveLength(1);
});

// -- K3 -----------------------------------------------------------------------

test(
  "K3 answering the same wait again: 409 already_answered, nothing appended",
  { timeout: 20_000 },
  async () => {
  await boot();
  const sessionId = await createSession();
  await addWait(sessionId, approveWait("approve:1:c1", "c1"));
  const first = await postJson(`/api/sessions/${sessionId}/waits/approve:1:c1`, { decision: "approve" });
  expect(first.status).toBe(200);

  const before = await eventCount(sessionId);
  const second = await postJson(`/api/sessions/${sessionId}/waits/approve:1:c1`, { decision: "approve" });
  expect(second.status).toBe(409);
  expect(await second.json()).toEqual({ outcome: "refused", reason: "already_answered" });
  expect(await eventCount(sessionId)).toBe(before);
});

// -- K4 -----------------------------------------------------------------------

test("K4 a wait whose deadline has passed: 409 expired", { timeout: 20_000 }, async () => {
  await boot();
  const sessionId = await createSession();
  await addWait(
    sessionId,
    approveWait("approve:1:c1", "c1", { deadline: Date.now() - 1_000 }),
  );

  const before = await eventCount(sessionId);
  const response = await postJson(`/api/sessions/${sessionId}/waits/approve:1:c1`, { decision: "approve" });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ outcome: "refused", reason: "expired" });
  expect(await eventCount(sessionId)).toBe(before);
});

// -- K5 -----------------------------------------------------------------------

test(
  "K5 a gated approve wait answered through the route: accepted — the app may answer gated waits",
  { timeout: 20_000 },
  async () => {
  await boot();
  const sessionId = await createSession();
  await addWait(sessionId, approveWait("approve:1:c1", "c1", { gated: true }));

  const response = await postJson(`/api/sessions/${sessionId}/waits/approve:1:c1`, { decision: "approve" });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ outcome: "accepted" });
  expect(await respondedOn(sessionId)).toHaveLength(1);
});

// -- K6 -----------------------------------------------------------------------

test("K6 an approve wait answered with a non approve/deny word: 400, nothing appended", { timeout: 20_000 }, async () => {
  await boot();
  const sessionId = await createSession();
  await addWait(sessionId, approveWait("approve:1:c1", "c1"));

  const before = await eventCount(sessionId);
  const response = await postJson(`/api/sessions/${sessionId}/waits/approve:1:c1`, { decision: "yes" });
  expect(response.status).toBe(400);
  expect(await eventCount(sessionId)).toBe(before);
  expect(await respondedOn(sessionId)).toHaveLength(0);
});

// -- K7 -----------------------------------------------------------------------

test("K7 an ask_user answer wait takes any text: 200, the fact carries it", { timeout: 20_000 }, async () => {
  await boot();
  const sessionId = await createSession();
  await addWait(sessionId, answerWait("wait:1:c1"));

  const response = await postJson(`/api/sessions/${sessionId}/waits/wait:1:c1`, { decision: "Tuesday" });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ outcome: "accepted" });

  const responded = await respondedOn(sessionId);
  expect(responded).toHaveLength(1);
  expect((responded[0]!.payload as Record<string, unknown>).decision).toBe("Tuesday");
});

// -- K8 -----------------------------------------------------------------------

test("K8 an unknown session: 404 on both routes", { timeout: 20_000 }, async () => {
  await boot();

  const post = await postJson("/api/sessions/nope/waits/approve:1:c1", { decision: "approve" });
  expect(post.status).toBe(404);
  expect(await post.json()).toEqual({ error: "session not found" });

  const put = await putJson("/api/sessions/nope/approval-mode", { mode: "ask" });
  expect(put.status).toBe(404);
  expect(await put.json()).toEqual({ error: "session not found" });
});

// -- K9 -----------------------------------------------------------------------

test(
  "K9 the approval-mode put: one fact on change, none on the same mode, fold carries it; bad mode 400",
  { timeout: 20_000 },
  async () => {
  await boot();
  const sessionId = await createSession();
  const streamId = `session:${sessionId}`;
  const modeSets = async () =>
    (await eventsOf(sessionId)).filter((event) => event.type === "session.approval_mode_set");

  const first = await putJson(`/api/sessions/${sessionId}/approval-mode`, { mode: "auto_edits" });
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ mode: "auto_edits" });
  const sets = await modeSets();
  expect(sets).toHaveLength(1);
  expect(sets[0]!.payload).toEqual({ mode: "auto_edits" });
  const folded = fold(await rt!.store.readStream(streamId, { workspaceId: RUNTIME_WORKSPACE }));
  expect(folded.approvalMode).toBe("auto_edits");

  // the same mode: 200, nothing appended
  const again = await putJson(`/api/sessions/${sessionId}/approval-mode`, { mode: "auto_edits" });
  expect(again.status).toBe(200);
  expect(await again.json()).toEqual({ mode: "auto_edits" });
  expect(await modeSets()).toHaveLength(1);

  const bad = await putJson(`/api/sessions/${sessionId}/approval-mode`, { mode: "yolo" });
  expect(bad.status).toBe(400);
  expect(await modeSets()).toHaveLength(1);
});

// -- K10 ----------------------------------------------------------------------

test(
  "K10 workers on: the held call resumes on the route's answer, and deny completes declined",
  { timeout: 30_000 },
  async () => {
    const MAKER: SpecialistAgent = {
      id: "maker",
      name: "Maker",
      tools: [{ name: "write_file", policy: "approval" }],
    };
    setSessionAgents([MAKER]);
    dataDir = await mkdtemp(path.join(tmpdir(), "fabric-t17-k10-"));
    const workDir = path.join(dataDir, "work");
    rt = await startRuntime(
      {
        RUNTIME_PGLITE_DIR: dataDir,
        FABRIC_WORK_DIR: workDir,
        FABRIC_MASTER_KEY_FILE: path.join(dataDir, "master.key"),
      },
      { worker: false },
    );
    startWorker(workDir);

    // -- session A: the approval answers, the held call runs -------------------
    const a = await createSession("maker");
    const postedA = await postJson(`/api/sessions/${a}/messages`, {
      clientMessageId: randomUUID(),
      text: "write the file",
    });
    expect(postedA.status).toBe(200);

    const askA = await until(async () => (await approvalWaitsOn(a))[0]);
    const callA = ((askA!.payload as Record<string, unknown>).approval as Record<string, unknown>)
      .callId;
    expect(typeof callA).toBe("string");

    const answerA = await postJson(`/api/sessions/${a}/waits/${(askA!.payload as Record<string, unknown>).waitId as string}`, {
      decision: "approve",
    });
    expect(answerA.status).toBe(200);

    const callEvent = await until(async () =>
      (await eventsOf(a)).find(
        (event) => event.type === "tool.call" && (event.payload as Record<string, unknown>).callId === callA,
      ),
    );
    expect((callEvent!.payload as Record<string, unknown>).tool).toBe("write_file");

    const doneA = await until(async () =>
      (await eventsOf(a)).find(
        (event) =>
          event.type === "tool.completed" && (event.payload as Record<string, unknown>).callId === callA,
      ),
    );
    expect(doneA!.payload).toMatchObject({ ok: true });
    expect(await readFile(path.join(workDir, "agents", "maker", "hello.txt"), "utf8")).toBe("kept");

    // -- session B: the denial completes declined, no call runs ---------------
    const b = await createSession("maker");
    const postedB = await postJson(`/api/sessions/${b}/messages`, {
      clientMessageId: randomUUID(),
      text: "write the file too",
    });
    expect(postedB.status).toBe(200);

    const askB = await until(async () => (await approvalWaitsOn(b)).at(-1));
    const callB = ((askB!.payload as Record<string, unknown>).approval as Record<string, unknown>)
      .callId;
    const answerB = await postJson(
      `/api/sessions/${b}/waits/${(askB!.payload as Record<string, unknown>).waitId as string}`,
      { decision: "deny" },
    );
    expect(answerB.status).toBe(200);

    const doneB = await until(async () =>
      (await eventsOf(b)).find(
        (event) =>
          event.type === "tool.completed" && (event.payload as Record<string, unknown>).callId === callB,
      ),
    );
    expect(doneB!.payload).toEqual({ callId: callB, ok: false, error: "declined by the user" });
    expect((await eventsOf(b)).some((event) => event.type === "tool.call")).toBe(false);
  },
);
