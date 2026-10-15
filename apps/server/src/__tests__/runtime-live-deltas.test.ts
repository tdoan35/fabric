// ANY-94 R16 — server leg: cumulative live deltas reach the SSE stream during a
// real (test-double) streamed call. MODEL_VARIANT=slow streams the echo as 20
// increments 50 ms apart (~1 s per call); the `ll.call` worker accumulates them,
// so the frames carry cumulative text. D3 posts then follows (the S12b client
// shape), D4 follows then posts, D5 bounds first-delta latency against the
// model's own emit clock, D6 joins mid-call. Both store drivers via the runtime
// suite's harness; MODEL_PORT=test throughout; no network.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { createDb, sql, type Db } from "@fabric/db";
import { parseFrame, type SessionFrame } from "@fabric/contracts";
import { describeDrivers, postgresUrlFromEnv } from "@fabric/runtime/testing";
import { afterAll, afterEach, expect, test } from "vitest";
import {
  getRuntime,
  setRuntime,
  startRuntime,
  type FabricRuntime,
  type RuntimeEnv,
} from "../runtime/bootstrap";
import { resetTestModelEmits, testModelEmits } from "../runtime/test-model";
import { sessions } from "../routes/sessions";

const app = (): Hono => new Hono().route("/api", sessions);

const postJson = async (path: string, body: unknown): Promise<Response> =>
  app().request(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

const createSession = async (): Promise<string> => {
  const response = await postJson("/api/sessions", { agentId: "dana" });
  expect(response.status).toBe(200);
  return ((await response.json()) as { sessionId: string }).sessionId;
};

const eventsOf = (rt: FabricRuntime, sessionId: string) =>
  rt.store.readStream(`session:${sessionId}`, { workspaceId: "local" });

/** Poll until `run` returns a value; 20 ms steps. */
async function until<T>(run: () => Promise<T | undefined>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await run();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("condition not reached within the window");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// -- the wire (the S6 harness shape) -------------------------------------------

type Stream = ReturnType<typeof sse>;

function sse(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const next = async (timeoutMs = 10_000): Promise<SessionFrame> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end >= 0) {
        const frame = parseFrame(buffer.slice(0, end + 2));
        buffer = buffer.slice(end + 2);
        return frame;
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no frame within ${timeoutMs} ms; tail: ${buffer}`);
      const chunk = await Promise.race([
        reader.read(),
        new Promise<"stall">((resolve) => setTimeout(resolve, left, "stall")),
      ]);
      if (chunk === "stall") throw new Error(`no frame within ${timeoutMs} ms; tail: ${buffer}`);
      if (chunk.done) throw new Error("stream ended");
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };
  return {
    next,
    cancel: () => reader.cancel(),
  };
}

const openStream = async (sessionId: string): Promise<Stream> => {
  const response = await app().request(`/api/sessions/${sessionId}/stream`);
  expect(response.status, "stream status").toBe(200);
  return sse(response);
};

type DeltaFrame = Extract<SessionFrame, { event: "delta" }>;
type EventFrame = Extract<SessionFrame, { event: "event" }>;
const isDelta = (frame: SessionFrame): frame is DeltaFrame => frame.event === "delta";

/** Collects delta frames until the reply call's `llm.completed` event frame
 * passes; returns the deltas with their read timestamps and that frame. */
async function deltasUntilCompleted(stream: Stream) {
  const deltas: { at: number; text: string }[] = [];
  let completed: string | undefined;
  for (;;) {
    const frame = await stream.next(15_000);
    const at = Date.now();
    if (isDelta(frame)) {
      deltas.push({ at, text: frame.data.text });
    } else if (frame.event === "event") {
      if ((frame as EventFrame).data.type === "llm.completed") {
        completed = ((frame as EventFrame).data.payload as { text: string }).text;
        break;
      }
    }
  }
  return { deltas, completed: completed ?? "" };
}

// -- per-test backends (the S6 harness: fresh PGlite dir or fresh database) ----

const state: { dir?: string; url?: string } = {};
let admin: { admin: Db; drop: (name: string) => Promise<void> } | undefined;

afterEach(async () => {
  const rt = getRuntime();
  setRuntime(undefined);
  if (rt) await rt.stop().catch(() => undefined);
  if (state.dir !== undefined) {
    await rm(state.dir, { recursive: true, force: true }).catch(() => undefined);
    state.dir = undefined;
  }
  if (state.url !== undefined && admin !== undefined) {
    const database = new URL(state.url).pathname.slice(1);
    await admin.drop(database).catch(() => undefined);
    state.url = undefined;
  }
});

afterAll(async () => {
  await admin?.admin.close().catch(() => undefined);
  admin = undefined;
});

describeDrivers("R16 server: live deltas on the session stream (ANY-94)", (h) => {
  /** A runtime on this test's own backend, MODEL_PORT=test, the slow variant. */
  async function start(): Promise<FabricRuntime> {
    let env: RuntimeEnv;
    if (h.driver === "pglite") {
      state.dir ??= await mkdtemp(path.join(tmpdir(), "fabric-r16-"));
      env = { RUNTIME_PGLITE_DIR: state.dir, MODEL_PORT: "test" };
    } else {
      const base = postgresUrlFromEnv();
      if (base === undefined) throw new Error("pg driver leg without RUNTIME_TEST_DATABASE_URL");
      admin ??= await (async () => {
        const adminUrl = new URL(base);
        adminUrl.pathname = "/postgres";
        const db = createDb(adminUrl.toString());
        return {
          admin: db,
          drop: (name: string) =>
            db.db.execute(sql.raw(`drop database if exists "${name}" with (force)`)).then(() => undefined),
        };
      })();
      if (state.url === undefined) {
        const database = `fabric_r16_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
        await admin.admin.db.execute(sql.raw(`create database "${database}"`));
        const url = new URL(base);
        url.pathname = `/${database}`;
        state.url = url.toString();
      }
      env = { RUNTIME_DATABASE_URL: state.url, MODEL_PORT: "test" };
    }
    resetTestModelEmits();
    return startRuntime({ ...env, MODEL_VARIANT: "slow" }, { worker: true });
  }

  test("D3: post then follow — delta frames arrive before llm.completed, each a growing prefix of the reply", async () => {
    const rt = await start();
    const sessionId = await createSession();
    await postJson(`/api/sessions/${sessionId}/messages`, {
      clientMessageId: randomUUID(),
      text: "stream slowly",
    });
    const stream = await openStream(sessionId);

    const { deltas, completed } = await deltasUntilCompleted(stream);
    expect(completed).toBe(`echo: stream slowly`);
    // the reply streamed while the call ran: a batch of frames, not one
    expect(deltas.length, "delta frames before llm.completed").toBeGreaterThanOrEqual(5);
    for (let index = 1; index < deltas.length; index += 1) {
      const previous = deltas[index - 1]!;
      const current = deltas[index]!;
      expect(current.text.startsWith(previous.text), "cumulative delta text").toBe(true);
      expect(current.text.length, "strictly growing").toBeGreaterThan(previous.text.length);
      expect(completed.startsWith(current.text), "a prefix of the completed text").toBe(true);
    }
    expect(deltas[deltas.length - 1]!.text).toBe(completed);
    stream.cancel();
  }, 45_000);

  test("D4: follow then post — the same assertions with the stream opened first", async () => {
    const rt = await start();
    const sessionId = await createSession();
    const stream = await openStream(sessionId);
    await postJson(`/api/sessions/${sessionId}/messages`, {
      clientMessageId: randomUUID(),
      text: "stream slowly",
    });

    const { deltas, completed } = await deltasUntilCompleted(stream);
    expect(completed).toBe(`echo: stream slowly`);
    expect(deltas.length, "delta frames before llm.completed").toBeGreaterThanOrEqual(5);
    for (let index = 1; index < deltas.length; index += 1) {
      const previous = deltas[index - 1]!;
      const current = deltas[index]!;
      expect(current.text.startsWith(previous.text), "cumulative delta text").toBe(true);
      expect(current.text.length, "strictly growing").toBeGreaterThan(previous.text.length);
      expect(completed.startsWith(current.text), "a prefix of the completed text").toBe(true);
    }
    expect(deltas[deltas.length - 1]!.text).toBe(completed);
    stream.cancel();
  }, 45_000);

  test("D5: the first delta frame lands within 200 ms of the model's first increment", async () => {
    const rt = await start();
    const sessionId = await createSession();
    const stream = await openStream(sessionId);
    const postedAt = Date.now();
    await postJson(`/api/sessions/${sessionId}/messages`, {
      clientMessageId: randomUUID(),
      text: "latency probe",
    });

    let firstDeltaAt = -1;
    for (;;) {
      const frame = await stream.next(15_000);
      const at = Date.now();
      if (isDelta(frame)) {
        firstDeltaAt = at;
        break;
      }
      if (frame.event === "event" && (frame as EventFrame).data.type === "llm.completed") {
        throw new Error("the call completed before any delta frame");
      }
    }

    const emits = testModelEmits();
    expect(emits.length, "the model recorded its emits").toBeGreaterThan(0);
    const firstEmit = emits[0]!.at;
    const latency = firstDeltaAt - firstEmit;
    // the D5 report for the PR description (the gate is the bound itself)
    console.log(`[r16 D5] ${h.driver}: first delta frame ${latency} ms after the first increment emit`);
    expect(latency, "first frame within 200 ms of the first emit").toBeLessThanOrEqual(200);
    expect(postedAt).toBeLessThan(firstDeltaAt);
    stream.cancel();
  }, 45_000);

  test("D6: joining mid-call, the first frame after the backlog is the increments so far, and frames keep growing", async () => {
    const rt = await start();
    const sessionId = await createSession();
    await postJson(`/api/sessions/${sessionId}/messages`, {
      clientMessageId: randomUUID(),
      text: "join me",
    });
    await until(async () => {
      const events = await eventsOf(rt, sessionId);
      const requested = events.some((event) => event.type === "llm.requested");
      const done = events.some((event) => event.type === "llm.completed");
      // enough increments emitted to have a backlog worth joining
      return requested && !done && testModelEmits().length >= 5 ? true : undefined;
    });

    const stream = await openStream(sessionId);
    // the first frame after the backlog: events are skipped, the first delta wins
    const readFirstDelta = async (): Promise<string> => {
      for (;;) {
        const frame = await stream.next(15_000);
        if (isDelta(frame)) return frame.data.text;
        if (frame.event === "event") continue;
        throw new Error(`expected delta, got ${String(frame.event)}`);
      }
    };
    const first = await readFirstDelta();

    const emits = testModelEmits();
    const echo = "echo: join me";
    // the join text is exactly some prefix of whole increments — at least five
    const five = emits.slice(0, 5).map((emit) => emit.text).join("");
    expect(echo.startsWith(first), "the join text is made of whole increments").toBe(true);
    expect(first.length, "at least the first five increments' worth").toBeGreaterThanOrEqual(five.length);

    // later frames keep growing, up to the completion
    let previous = first;
    for (;;) {
      const frame = await stream.next(15_000);
      if (isDelta(frame)) {
        expect(frame.data.text.startsWith(previous), "still cumulative").toBe(true);
        expect(frame.data.text.length).toBeGreaterThan(previous.length);
        previous = frame.data.text;
      } else if (frame.event === "event" && (frame as EventFrame).data.type === "llm.completed") {
        break;
      }
    }
    expect(previous).toBe(echo);
    stream.cancel();
  }, 45_000);
});
