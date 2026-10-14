// S5 (ANY-54): the server hosts the runtime in-process and chat sessions become
// commands on a `session:` stream. Seven cases, B1–B7, each named by its ID, run
// on both store drivers via the runtime suite's harness — every runtime in this
// file boots with MODEL_PORT=test, the fixed echo double (RUNTIME §13: the
// client posts the message, then follows the stream).
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { createDb, sql, type Db } from "@fabric/db";
import { describeDrivers, postgresUrlFromEnv } from "@fabric/runtime/testing";
import { afterAll, afterEach, expect, test } from "vitest";
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

const postJson = (path: string, body: unknown): Promise<Response> =>
  app().request(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

const getJson = (path: string): Promise<Response> => app().request(path);

/** Poll until `run` returns a value, the B4 window: 5 s. */
async function until<T>(run: () => Promise<T | undefined>, ms = 5_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await run();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("condition not reached within the window");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const eventsOf = async (rt: FabricRuntime, sessionId: string) =>
  rt.store.readStream(`session:${sessionId}`, { workspaceId: RUNTIME_WORKSPACE });

const messagesOn = (events: { type: string }[]) => events.filter((event) => event.type === "message.received");

// Per-test backends: a fresh PGlite dir, or a fresh per-test database on the
// leg's server (the drivers' own pattern — trust auth, no passwords in repo).
const state: { dir?: string; admin?: Db; url?: string } = {};

let admin: { admin: Db; drop: (name: string) => Promise<void> } | undefined;

afterEach(async () => {
  const rt = getRuntime();
  setRuntime(undefined);
  if (rt) await rt.stop();
  if (state.dir !== undefined) {
    await rm(state.dir, { recursive: true, force: true });
    state.dir = undefined;
  }
  if (state.url !== undefined && admin !== undefined) {
    const database = new URL(state.url).pathname.slice(1);
    await admin.drop(database).catch(() => undefined);
    state.url = undefined;
  }
});

afterAll(async () => {
  admin?.admin.close();
  admin = undefined;
});

describeDrivers("S5 server: runtime bootstrap and session commands (ANY-54)", (h) => {
  /** A runtime on this test's own backend, MODEL_PORT=test, worker per `worker`. */
  async function start(worker = true, over: Partial<RuntimeEnv> = {}): Promise<FabricRuntime> {
    let env: RuntimeEnv;
    if (h.driver === "pglite") {
      state.dir = await mkdtemp(path.join(tmpdir(), "fabric-s5-"));
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
      const database = `fabric_s5_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
      await admin.admin.db.execute(sql.raw(`create database "${database}"`));
      const url = new URL(base);
      url.pathname = `/${database}`;
      state.url = url.toString();
      env = { RUNTIME_DATABASE_URL: state.url, MODEL_PORT: "test", ...over };
    }
    const rt = await startRuntime(env, { worker });
    setRuntime(rt);
    return rt;
  }

  test("B1: POST /api/sessions appends session.created first, with the posted agentId and incognito", async () => {
    const rt = await start();
    const response = await postJson("/api/sessions", { agentId: "dana", incognito: true });
    expect(response.status).toBe(200);
    const { sessionId } = (await response.json()) as { sessionId: string };
    expect(sessionId).toMatch(/[0-9a-f-]{36}/);

    const events = await eventsOf(rt, sessionId);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.type).toBe("session.created");
    expect(events[0]!.payload).toMatchObject({ agentId: "dana", incognito: true });
  });

  test("B2: the posted message lands at the returned seq as message.received, app surface, id carried", async () => {
    const rt = await start();
    const session = await (await postJson("/api/sessions", { agentId: "dana" })).json();
    const clientMessageId = randomUUID();

    const posted = await postJson(`/api/sessions/${session.sessionId}/messages`, {
      clientMessageId,
      text: "hello",
    });
    expect(posted.status).toBe(200);
    const { seq } = (await posted.json()) as { seq: number };
    expect(Number.isInteger(seq)).toBe(true);

    const events = await eventsOf(rt, session.sessionId);
    const received = events.find((event) => event.seq === seq);
    expect(received?.type).toBe("message.received");
    expect(received?.payload).toMatchObject({
      text: "hello",
      surface: "app",
      sender: "user",
      platformMessageId: clientMessageId,
    });
  });

  test("B3: reposting the same clientMessageId returns the original seq and appends nothing", async () => {
    const rt = await start();
    const session = await (await postJson("/api/sessions", { agentId: "dana" })).json();
    const clientMessageId = randomUUID();
    const body = { clientMessageId, text: "once" };

    const first = await postJson(`/api/sessions/${session.sessionId}/messages`, body);
    const second = await postJson(`/api/sessions/${session.sessionId}/messages`, body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(((await second.json()) as { seq: number }).seq).toBe(((await first.json()) as { seq: number }).seq);

    const events = await eventsOf(rt, session.sessionId);
    expect(messagesOn(events)).toHaveLength(1);
  });

  test("B4: with the worker up, the turn ends in agent.message echo and a derived disposition within 5 s", async () => {
    const rt = await start();
    const session = await (await postJson("/api/sessions", { agentId: "dana" })).json();
    await postJson(`/api/sessions/${session.sessionId}/messages`, {
      clientMessageId: randomUUID(),
      text: "ping the turn",
    });

    const events = await until(async () => {
      const all = await eventsOf(rt, session.sessionId);
      const agentMessage = all.find((event) => event.type === "agent.message");
      const disposition = all.find((event) => event.type === "disposition.recorded");
      if (agentMessage === undefined || disposition === undefined) return undefined;
      return { all, agentMessage, disposition };
    });
    expect((events.agentMessage.payload as { text: string }).text).toBe("echo: ping the turn");
    expect((events.disposition.payload as { source: string }).source).toBe("derived");
  });

  test("B5: a turn posted while the worker is down completes after the runtime restarts on the same store", async () => {
    const stopped = await start(false);
    const session = await (await postJson("/api/sessions", { agentId: "dana" })).json();
    await postJson(`/api/sessions/${session.sessionId}/messages`, {
      clientMessageId: randomUUID(),
      text: "survive the restart",
    });
    await stopped.stop();
    setRuntime(undefined);
    const before = await eventsOf(stopped, session.sessionId);
    expect(before.some((event) => event.type === "agent.message")).toBe(false);

    const restarted = await start();
    const events = await until(async () => {
      const all = await eventsOf(restarted, session.sessionId);
      const agentMessage = all.find((event) => event.type === "agent.message");
      const disposition = all.find((event) => event.type === "disposition.recorded");
      if (agentMessage === undefined || disposition === undefined) return undefined;
      return { all, agentMessage };
    });
    expect((events.agentMessage.payload as { text: string }).text).toBe("echo: survive the restart");
    expect(events.all.filter((event) => event.type === "llm.completed")).toHaveLength(1);
  });

  test("B6: unknown sessions 404; bodies off the contract 400", async () => {
    await start();
    const missing = randomUUID();
    expect((await postJson(`/api/sessions/${missing}/messages`, { clientMessageId: randomUUID(), text: "x" })).status).toBe(404);
    expect((await getJson(`/api/sessions/${missing}/events`)).status).toBe(404);

    expect((await postJson("/api/sessions", {})).status).toBe(400);
    expect((await postJson("/api/sessions", { agentId: 42 })).status).toBe(400);
    expect(
      (await postJson("/api/sessions", { agentId: "dana", extra: true })).status
    ).toBe(400);
    const session = await (await postJson("/api/sessions", { agentId: "dana" })).json();
    expect(
      (await postJson(`/api/sessions/${session.sessionId}/messages`, { clientMessageId: "not-a-uuid", text: "x" })).status
    ).toBe(400);
    expect(
      (await postJson(`/api/sessions/${session.sessionId}/messages`, { clientMessageId: randomUUID(), text: "" })).status
    ).toBe(400);
  });

  test("B7: MODEL_PORT=test refuses to start when NODE_ENV=production, naming the variable", async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await expect(startRuntime({ MODEL_PORT: "test" })).rejects.toThrow(/MODEL_PORT/);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });
});
