// S6 (ANY-55): the session stream — SSE with Last-Event-ID resume and live
// deltas. Eight cases, V1–V8, each named by its ID, on both store drivers via
// the runtime suite's harness. MODEL_PORT=test throughout; the chunked variant
// (V4/V5) streams the echo reply in 5 chunks 30 ms apart. The endpoint is
// exercised through the hono app exactly as a client sees it: the wire text is
// parsed back into frames with S3's `parseFrame`.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { createDb, sql, type Db } from "@fabric/db";
import { parseFrame, type SessionFrame } from "@fabric/contracts";
import { append } from "@fabric/runtime";
import { describeDrivers, postgresUrlFromEnv } from "@fabric/runtime/testing";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import {
  getRuntime,
  RUNTIME_WORKSPACE,
  setRuntime,
  startRuntime,
  type FabricRuntime,
  type RuntimeEnv,
} from "../runtime/bootstrap";
import { sessions } from "../routes/sessions";

const app = (): Hono => new Hono().route("/api", sessions);

const streamIdOf = (sessionId: string): string => `session:${sessionId}`;

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

/** A telemetry fact on the session log, the way anything can append one. */
const appendProgress = (rt: FabricRuntime, sessionId: string, text: string): Promise<unknown> =>
  rt.store.transaction((tx) =>
    append(tx, RUNTIME_WORKSPACE, [
      {
        streamId: streamIdOf(sessionId),
        events: [{ type: "run.progress", actor: "test", payload: { text, milestone: "s6" } }],
      },
    ]),
  );

const eventsOf = (rt: FabricRuntime, sessionId: string) =>
  rt.store.readStream(streamIdOf(sessionId), { workspaceId: RUNTIME_WORKSPACE });

/** Poll until `run` returns a value; 20 ms steps to land inside a turn. */
async function until<T>(run: () => Promise<T | undefined>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await run();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("condition not reached within the window");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// -- the wire ----------------------------------------------------------------

type Stream = ReturnType<typeof sse>;

/** Reads one SSE frame off the response body, `parseFrame`-parsed. */
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

const openStream = async (
  sessionId: string,
  resume: { header?: string; query?: string } = {},
): Promise<Stream> => {
  const headers: Record<string, string> = {};
  if (resume.header !== undefined) headers["Last-Event-ID"] = resume.header;
  const suffix = resume.query !== undefined ? `?after=${resume.query}` : "";
  const response = await app().request(`/api/sessions/${sessionId}/stream${suffix}`, { headers });
  expect(response.status, `stream status for ${sessionId}`).toBe(200);
  return sse(response);
};

type EventFrame = Extract<SessionFrame, { event: "event" }>;

const readEvent = async (stream: Stream, timeoutMs?: number): Promise<EventFrame> => {
  const frame = await stream.next(timeoutMs);
  expect(frame, "the next frame").toBeDefined();
  expect(frame?.event, `frame kind, got ${String(frame?.event)}`).toBe("event");
  return frame as EventFrame;
};

/** The live bus, structurally — the runtime carries it from S6 on. */
type StreamBus = {
  current(streamId: string): { turn: number; callNo: number; text: string } | null;
};
const liveOf = (rt: FabricRuntime): StreamBus => {
  const live = (rt as unknown as { live?: StreamBus }).live;
  expect(live, "the runtime exposes the live bus").toBeDefined();
  return live!;
};

// -- per-test backends (the S5 harness: fresh PGlite dir or fresh database) --

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

let current: FabricRuntime | undefined;

const remember = (rt: FabricRuntime): FabricRuntime => {
  current = rt;
  return rt;
};

afterAll(async () => {
  await admin?.admin.close().catch(() => undefined);
  admin = undefined;
  current = undefined;
});

describeDrivers("S6 server: the session stream (ANY-55)", (h) => {
  /** A runtime on this test's own backend, MODEL_PORT=test, worker per flag. */
  async function start(
    worker: boolean,
    over: Partial<RuntimeEnv> & { MODEL_VARIANT?: "chunked" } = {},
  ): Promise<FabricRuntime> {
    let env: RuntimeEnv;
    if (h.driver === "pglite") {
      state.dir ??= await mkdtemp(path.join(tmpdir(), "fabric-s6-"));
      env = { RUNTIME_PGLITE_DIR: state.dir, MODEL_PORT: "test", ...over };
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
        const database = `fabric_s6_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
        await admin.admin.db.execute(sql.raw(`create database "${database}"`));
        const url = new URL(base);
        url.pathname = `/${database}`;
        state.url = url.toString();
      }
      env = { RUNTIME_DATABASE_URL: state.url, MODEL_PORT: "test", ...over };
    }
    return remember(await startRuntime(env, { worker }));
  }

  test("V1: no resume point replays every event in seq order, then a new post's events live; id is the seq", async () => {
    const rt = await start(true);
    const sessionId = await createSession();
    await postJson(`/api/sessions/${sessionId}/messages`, {
      clientMessageId: randomUUID(),
      text: "first",
    });
    await until(async () =>
      (await eventsOf(rt, sessionId)).some((event) => event.type === "agent.message") ? true : undefined,
    );
    const backlog = (await eventsOf(rt, sessionId)).map((event) => event.seq).sort((a, b) => a - b);
    expect(backlog.length).toBeGreaterThan(2);

    const stream = await openStream(sessionId);
    const seen: number[] = [];
    for (let index = 0; index < backlog.length; index += 1) {
      const frame = await readEvent(stream);
      expect(frame.id, `event frame id at ${index}`).toBe(frame.data.seq);
      seen.push(frame.id);
    }
    // Every pre-existing event, in seq order, exactly once.
    expect(seen).toEqual(backlog);

    // A second post, on the same connection: its events arrive live.
    const secondId = randomUUID();
    await postJson(`/api/sessions/${sessionId}/messages`, {
      clientMessageId: secondId,
      text: "second",
    });
    for (;;) {
      const frame = await readEvent(stream);
      expect(frame.id).toBe(frame.data.seq);
      seen.push(frame.id);
      const payload = frame.data.payload as { platformMessageId?: string };
      if (frame.data.type === "message.received" && payload.platformMessageId === secondId) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    stream.cancel();
  }, 30_000);

  test("V2: Last-Event-ID: 3 and ?after=3 both resume at seq 4 and stay live", async () => {
    const rt = await start(false);
    const sessionId = await createSession();
    await postJson(`/api/sessions/${sessionId}/messages`, { clientMessageId: randomUUID(), text: "one" });
    await postJson(`/api/sessions/${sessionId}/messages`, { clientMessageId: randomUUID(), text: "two" });
    // Workerless: the log is exactly seq 1..4.
    const seqs = (await eventsOf(rt, sessionId)).map((event) => event.seq).sort((a, b) => a - b);
    expect(seqs).toEqual([1, 2, 3, 4]);

    for (const resume of [{ header: "3" }, { query: "3" }]) {
      const stream = await openStream(sessionId, resume);
      const first = await readEvent(stream);
      expect(first.id, "the first frame after the resume point").toBe(4);
      // Live past the resume point, and strictly ascending: nothing at or
      // below 3 is ever repeated. The appended event arrives without a
      // reconnect, and anything the drain still held back follows in order.
      await appendProgress(rt, sessionId, "third");
      const seen = [first.id];
      for (;;) {
        const frame = await readEvent(stream);
        expect(frame.id).toBe(frame.data.seq);
        expect(seen[seen.length - 1]!).toBeLessThan(frame.id);
        seen.push(frame.id);
        if (frame.data.type === "run.progress") break; // the appended one
      }
      stream.cancel();
    }
  }, 20_000);

  test("V3: no gaps or duplicates when events land while the backlog streams", async () => {
    const rt = await start(false);
    const sessionId = await createSession();
    const streamPromise = openStream(sessionId);
    const appends = Promise.all(
      Array.from({ length: 50 }, (_, index) => appendProgress(rt, sessionId, `progress ${index}`)),
    );
    const [stream] = await Promise.all([streamPromise, appends]);
    const total = (await eventsOf(rt, sessionId)).length;

    const seen: number[] = [];
    for (let index = 0; index < total; index += 1) {
      const frame = await readEvent(stream, 15_000);
      expect(frame.id).toBe(frame.data.seq);
      seen.push(frame.id);
    }
    // Exactly seq 1..N, each once, in order: no gap, no duplicate.
    expect(seen).toEqual(Array.from({ length: total }, (_, index) => index + 1));
    stream.cancel();
  }, 30_000);

  test("V4: deltas grow during the turn, at most one per 100 ms, the last equals ll.completed", async () => {
    const rt = await start(true, { MODEL_VARIANT: "chunked" });
    const sessionId = await createSession();
    const stream = await openStream(sessionId);
    await readEvent(stream); // session.created
    await readEvent(stream); // run.created

    const postedAt = Date.now();
    await postJson(`/api/sessions/${sessionId}/messages`, {
      clientMessageId: randomUUID(),
      text: "stream slowly",
    });
    const deltas: { at: number; text: string }[] = [];
    let firstDeltaMs = -1;
    let completed: string | undefined;
    for (;;) {
      const frame = await stream.next(10_000);
      const at = Date.now();
      if (frame.event === "delta") {
        if (firstDeltaMs < 0) firstDeltaMs = at - postedAt;
        deltas.push({ at, text: frame.data.text });
      } else if (frame.event === "event") {
        expect(frame.id).toBe(frame.data.seq);
        if (frame.data.type === "llm.completed") {
          completed = (frame.data.payload as { text: string }).text;
          break;
        }
      }
    }
    // The final batch lands within a window of the completion; keep collecting.
    const quietAt = Date.now() + 600;
    while (Date.now() < quietAt) {
      try {
        const frame = await stream.next(quietAt - Date.now());
        if (frame.event === "delta") deltas.push({ at: Date.now(), text: frame.data.text });
      } catch {
        break;
      }
    }

    // Latency report for the PR description (not a gate; the S7 target is real-model).
    console.log(`[latency] ${h.driver}: post -> first delta frame ${firstDeltaMs} ms`);
    expect(firstDeltaMs).toBeGreaterThan(0);
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    for (let index = 1; index < deltas.length; index += 1) {
      const previous = deltas[index - 1]!;
      const current = deltas[index]!;
      expect(current.text.startsWith(previous.text), "cumulative delta text").toBe(true);
      expect(current.at - previous.at).toBeGreaterThanOrEqual(90); // one per 100 ms window
      expect(current.text.length).toBeGreaterThan(previous.text.length); // growing
    }
    expect(deltas[deltas.length - 1]!.text).toBe(completed);
    stream.cancel();
  }, 30_000);

  test("V5: joining mid-call, the first frame after the backlog is the delta so far", async () => {
    const rt = await start(true, { MODEL_VARIANT: "chunked" });
    liveOf(rt);
    const sessionId = await createSession();
    await postJson(`/api/sessions/${sessionId}/messages`, {
      clientMessageId: randomUUID(),
      text: "join me",
    });
    await until(async () => {
      const events = await eventsOf(rt, sessionId);
      // Join while the turn is in flight: the subscribe lands before the
      // llm.call's transaction does on the serialized driver, so the deltas
      // reach this connection from the first chunk on.
      const requested = events.some((event) => event.type === "llm.requested");
      const done = events.some((event) => event.type === "llm.completed");
      return requested && !done ? true : undefined;
    });

    const stream = await openStream(sessionId);
    for (;;) {
      const frame = await stream.next(10_000);
      if (frame.event === "event") continue; // the backlog
      if (frame.event !== "delta") throw new Error(`expected delta, got ${frame.event}`);
      expect(frame.data.text.length).toBeGreaterThan(0); // the text so far
      break;
    }
    stream.cancel();
  }, 30_000);

  test("V6: disconnect, reconnect at the last seen id: nothing lost, nothing repeated", async () => {
    const rt = await start(false);
    const sessionId = await createSession();
    await postJson(`/api/sessions/${sessionId}/messages`, { clientMessageId: randomUUID(), text: "one" });
    await postJson(`/api/sessions/${sessionId}/messages`, { clientMessageId: randomUUID(), text: "two" });

    const first = await openStream(sessionId);
    const a = await readEvent(first);
    const b = await readEvent(first);
    expect([a.id, b.id]).toEqual([1, 2]);
    await first.cancel();

    // An event lands while nobody is connected; the resume must carry it.
    await appendProgress(rt, sessionId, "while away");

    const second = await openStream(sessionId, { header: String(b.id) });
    const c = await readEvent(second);
    const d = await readEvent(second);
    const e = await readEvent(second);
    expect([c.id, d.id, e.id]).toEqual([3, 4, 5]);
    const everywhere = [a.id, b.id, c.id, d.id, e.id];
    expect(new Set(everywhere).size).toBe(everywhere.length);
    await second.cancel();
  }, 20_000);

  test("V7: ping on the idle stream; the bus subscription ends with the client", async () => {
    const rt = await start(false);
    const sessionId = await createSession();
    const bus = liveOf(rt) as StreamBus & { count?(streamId: string): number };
    const streamId = streamIdOf(sessionId);

    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const stream = await openStream(sessionId);
      await readEvent(stream); // session.created
      await readEvent(stream); // run.created — then idle
      // The stream arms its timers once the backlog is drained; wait for that
      // before winding the clock, so the ping window starts here.
      await until(async () => (vi.getTimerCount() > 0 ? true : undefined), 5_000);

      const pending = stream.next(10_000);
      vi.advanceTimersByTime(15_000);
      const frame = await pending;
      expect(frame.event).toBe("ping");

      expect(bus.count?.(streamId), "one subscription while connected").toBe(1);
      await stream.cancel();
      expect(bus.count?.(streamId), "the subscription is removed on abort").toBe(0);
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  test("V8: an unknown session is a 404 before any stream opens", async () => {
    await start(false);
    const response = await app().request(`/api/sessions/${randomUUID()}/stream`);
    expect(response.status).toBe(404);
    // The route's own 404, not the router's fallback: the body names the miss.
    expect(await response.text()).toContain("session not found");
  });
});
