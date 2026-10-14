// S11 (ANY-61) — incognito on the server: the thread list hides incognito
// sessions (I4), the purge job shadows the last activity by
// INCOGNITO_PURGE_HOURS (I5, I7), its firing redacts text but keeps the audit
// facts (I6), and a purged session's reads answer 410 Gone (I8). Every runtime
// boots with MODEL_PORT=test and no workers: the purge is driven by hand, on
// the injected clock, the way the claim API allows.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { createDb, sql, type Db } from "@fabric/db";
import { describeDrivers, postgresUrlFromEnv } from "@fabric/runtime/testing";
import { afterAll, afterEach, expect, test } from "vitest";
import { handleSessionPurgeJob } from "../runtime/purge";
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

const postJson = async (path: string, body: unknown): Promise<Response> =>
  app().request(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

const getJson = async (path: string): Promise<Response> => app().request(path);

/** The session's events, any class. */
const eventsOf = async (rt: FabricRuntime, sessionId: string) =>
  rt.store.readStream(`session:${sessionId}`, { workspaceId: RUNTIME_WORKSPACE });

/** The live purge job of a session, if the board carries one. */
const purgeJob = async (
  rt: FabricRuntime,
  sessionId: string
): Promise<{ id: string; runAt: number; status: string } | undefined> => {
  const rows = await rt.store.transaction((tx) =>
    tx.query(`select id, run_at, status from jobs where key = $1 order by seq desc limit 1`, [
      `session:${sessionId}:purge`,
    ])
  );
  const row = rows[0];
  return row === undefined
    ? undefined
    : { id: String(row.id), runAt: Number(row.run_at), status: String(row.status) };
};

const HOUR_MS = 60 * 60 * 1000;
const PURGE_MS = 24 * HOUR_MS;

const longText = "x".repeat(80);

// Per-test backends: a fresh PGlite dir, or a fresh per-test database on the
// leg's server (the drivers' own pattern — trust auth, no passwords in repo).
const state: { dir?: string; url?: string } = {};
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

describeDrivers("S11 server: incognito sessions, thread list and purge (ANY-61)", (h) => {
  /** A runtime on this test's own backend, MODEL_PORT=test, no workers. */
  async function start(): Promise<FabricRuntime> {
    let env: RuntimeEnv;
    if (h.driver === "pglite") {
      state.dir ??= await mkdtemp(path.join(tmpdir(), "fabric-s11-"));
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
        const database = `fabric_s11_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
        await admin.admin.db.execute(sql.raw(`create database "${database}"`));
        const url = new URL(base);
        url.pathname = `/${database}`;
        state.url = url.toString();
      }
      env = { RUNTIME_DATABASE_URL: state.url, MODEL_PORT: "test" };
    }
    const rt = await startRuntime(env, { worker: false });
    setRuntime(rt);
    return rt;
  }

  const createSession = async (incognito: boolean): Promise<string> => {
    const response = await postJson("/api/sessions", { agentId: "dana", incognito });
    expect(response.status).toBe(200);
    return ((await response.json()) as { sessionId: string }).sessionId;
  };

  const postMessage = async (sessionId: string, text: string): Promise<void> => {
    const response = await postJson(`/api/sessions/${sessionId}/messages`, {
      clientMessageId: randomUUID(),
      text,
    });
    expect(response.status).toBe(200);
  };

  /** The purge's firing, by hand: claim on the injected clock, run the handler. */
  const firePurge = async (rt: FabricRuntime, sessionId: string, now: number): Promise<void> => {
    const lease = await rt.queue.claim("purge-test", ["session.purge"], now);
    expect(lease).not.toBeNull();
    expect(lease!.type).toBe("session.purge");
    await handleSessionPurgeJob(lease!, {
      store: rt.store,
      queue: rt.queue,
      now: () => now,
    });
  };

  /** Turns a session into a full shape, post-message: the turn's audit trail. */
  const seedTurn = async (rt: FabricRuntime, sessionId: string): Promise<void> => {
    const streamId = `session:${sessionId}`;
    const head = await rt.store.transaction((tx) => tx.query(`select head from streams where id = $1`, [streamId]));
    const base = Number(head[0]!.head);
    const insert = (seq: number, type: string, actor: string, payload: unknown): Promise<unknown> =>
      rt.store.transaction((tx) =>
        tx.query(
          `insert into events (id, workspace_id, stream_id, seq, type, class, v, actor, causation, ts, payload)
           values ($1, $2, $3, $4, $5, $6, 1, $7, null, now(), $8::jsonb)`,
          [randomUUID(), RUNTIME_WORKSPACE, streamId, seq, type, "fact", actor, JSON.stringify(payload)]
        )
      );
    await insert(
      base + 1,
      "llm.completed",
      "agent",
      {
        turn: 1,
        callNo: 1,
        text: "all done",
        toolCalls: [{ callId: "c1", args: { path: "notes.md" } }],
        usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.1 },
        finishReason: "stop",
        model: "test",
      },
    );
    // A disposition, the audit row the purge must keep (kind and source intact).
    await insert(base + 2, "disposition.recorded", "agent", {
      kind: "direct",
      target: null,
      reason: "simple answer, no routing",
      considered: ["agent-a", "team-b"],
      source: "model",
      turn: 1,
    });
  };

  test("I4: GET /api/sessions lists normal sessions with title and updatedAt, and omits incognito ones", async () => {
    const rt = await start();
    const plain = await createSession(false);
    const hidden = await createSession(true);
    const long = await createSession(false);
    await postMessage(plain, "Hello from the thread");
    await postMessage(hidden, "Incognito chatter");
    await postMessage(long, longText);

    const response = await getJson("/api/sessions");
    expect(response.status).toBe(200);
    const summaries = (await response.json()) as {
      sessionId: string;
      agentId: string;
      title: string;
      updatedAt: string;
      incognito: boolean;
    }[];

    const byId = new Map(summaries.map((summary) => [summary.sessionId, summary]));
    expect(byId.has(hidden)).toBe(false);
    const plainRow = byId.get(plain);
    expect(plainRow).toBeDefined();
    expect(plainRow!.agentId).toBe("dana");
    expect(plainRow!.incognito).toBe(false);
    expect(plainRow!.title).toBe("Hello from the thread");
    const plainEvents = await eventsOf(rt, plain);
    expect(plainRow!.updatedAt).toBe(plainEvents[plainEvents.length - 1]!.ts);

    // The title is the first user message, truncated to 60 chars.
    const longRow = byId.get(long);
    expect(longRow!.title).toBe(longText.slice(0, 60));
  });

  test("I5: an incognito message queues session.purge at +24 h; a second message moves it to +24 h from the new message", async () => {
    const rt = await start();
    const sessionId = await createSession(true);

    await postMessage(sessionId, "first");
    const first = await purgeJob(rt, sessionId);
    expect(first).toBeDefined();
    expect(first!.status).toBe("pending");
    const firstEvents = await eventsOf(rt, sessionId);
    const firstMessage = firstEvents.find((event) => event.type === "message.received");
    expect(first!.runAt).toBe(Date.parse(firstMessage!.ts) + PURGE_MS);

    await postMessage(sessionId, "second");
    const second = await purgeJob(rt, sessionId);
    expect(second).toBeDefined();
    const bothEvents = await eventsOf(rt, sessionId);
    const messages = bothEvents.filter((event) => event.type === "message.received");
    expect(messages).toHaveLength(2);
    expect(second!.runAt).toBe(Date.parse(messages[1]!.ts) + PURGE_MS);
    expect(second!.runAt).not.toBe(first!.runAt);
  });

  test("I6: purge firing after 24 h of quiet erases the text and keeps the disposition audit", async () => {
    const rt = await start();
    const sessionId = await createSession(true);
    await postMessage(sessionId, "trace me please");
    await seedTurn(rt, sessionId);
    const before = await eventsOf(rt, sessionId);
    const messageBefore = before.find((event) => event.type === "message.received")!;
    const runAt = Date.parse(messageBefore.ts) + PURGE_MS;

    await firePurge(rt, sessionId, runAt + 1_000);

    const after = await eventsOf(rt, sessionId);
    // Same events, one appended marker; seqs and types never move.
    expect(after.map((event) => event.seq)).toEqual([...before.map((event) => event.seq), before.length + 1]);

    const payloadOf = (type: string): Record<string, unknown> =>
      after.find((event) => event.type === type)!.payload as Record<string, unknown>;
    const received = payloadOf("message.received");
    expect(received.text).toBe("[erased]");
    expect(received.attachments).toEqual([]);
    const completed = payloadOf("llm.completed") as Record<string, unknown>;
    expect(completed.text).toBe("[erased]");

    // Dispositions survive with their audit fields; only the text goes.
    const disposition = payloadOf("disposition.recorded") as Record<string, unknown>;
    expect(disposition.kind).toBe("direct");
    expect(disposition.source).toBe("model");
    expect(disposition.reason).toBe("[erased]");
    expect(disposition.considered).toEqual([]);

    const marker = after.find((event) => event.type === "content.erased");
    expect(marker).toBeDefined();
    expect(marker!.payload).toEqual({ contentRef: `session:${sessionId}`, reason: "incognito", by: "system" });

    const job = await purgeJob(rt, sessionId);
    expect(job!.status).toBe("completed");
  });

  test("I7: purge firing early, because activity moved the deadline, redacts nothing and re-queues", async () => {
    const rt = await start();
    const sessionId = await createSession(true);
    await postMessage(sessionId, "first");
    await seedTurn(rt, sessionId);
    const before = await eventsOf(rt, sessionId);
    const firstMessage = before.find((event) => event.type === "message.received")!;
    const firstDeadline = Date.parse(firstMessage.ts) + PURGE_MS;

    // Claim the job against the first deadline, then activity lands late.
    const lease = await rt.queue.claim("purge-test", ["session.purge"], firstDeadline + 1_000);
    expect(lease).not.toBeNull();
    await postMessage(sessionId, "second");

    // The handler runs on the first deadline's clock: newer activity exists, so
    // the deadline moved — nothing may be redacted and the job re-queues.
    await handleSessionPurgeJob(lease!, {
      store: rt.store,
      queue: rt.queue,
      now: () => firstDeadline + 1_000,
    });

    const after = await eventsOf(rt, sessionId);
    expect(after).toHaveLength(before.length + 1); // only the second message
    expect(after.some((event) => event.type === "content.erased")).toBe(false);
    const stillThere = after.find((event) => event.type === "llm.completed")!.payload as Record<string, unknown>;
    expect(stillThere.text).toBe("all done");

    const job = await purgeJob(rt, sessionId);
    expect(job!.status).toBe("pending");
    const messages = after.filter((event) => event.type === "message.received");
    expect(job!.runAt).toBe(Date.parse(messages[1]!.ts) + PURGE_MS);
  });

  test("I8: after the purge, GET .../events and .../stream answer 410 Gone", async () => {
    const rt = await start();
    const sessionId = await createSession(true);
    await postMessage(sessionId, "gone soon");
    await firePurge(rt, sessionId, Date.now() + PURGE_MS + 1_000);

    const events = await getJson(`/api/sessions/${sessionId}/events`);
    expect(events.status).toBe(410);
    const stream = await getJson(`/api/sessions/${sessionId}/stream`);
    expect(stream.status).toBe(410);
  });
});
