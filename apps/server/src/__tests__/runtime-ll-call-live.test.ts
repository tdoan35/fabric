// ANY-95 R15 — the server leg: live deltas survive the model call leaving the
// store transaction. `startRuntime` with the test model chunking its reply;
// a live-bus subscriber sees the deltas attributed to the `llm.requested`'s
// turn/callNo while — the probe — a bystander store transaction commits and
// the stream still holds no `llm.completed`: the call is in flight outside
// any transaction (the single-transaction handler holds PGlite's chain, and
// the commit can only land after — together with the completion). Both
// drivers, the S6 harness.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { createDb, sql, type Db } from "@fabric/db";
import { append } from "@fabric/runtime";
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
  rt.store.readStream(`session:${sessionId}`, { workspaceId: RUNTIME_WORKSPACE });

/** Poll until `run` returns a value; 20 ms steps. */
async function until(run: () => Promise<unknown>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await run()) return;
    if (Date.now() > deadline) throw new Error("condition not reached within the window");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// -- per-test backends (the S6 harness: fresh PGlite dir or fresh database) --

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

describeDrivers("C10 server: ll.call live deltas off the store transaction (ANY-95 R15)", (h) => {
  async function start(over: Partial<RuntimeEnv> = {}): Promise<FabricRuntime> {
    let env: RuntimeEnv;
    if (h.driver === "pglite") {
      state.dir ??= await mkdtemp(path.join(tmpdir(), "fabric-r15-"));
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
        const database = `fabric_r15_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
        await admin.admin.db.execute(sql.raw(`create database "${database}"`));
        const url = new URL(base);
        url.pathname = `/${database}`;
        state.url = url.toString();
      }
      env = { RUNTIME_DATABASE_URL: state.url, MODEL_PORT: "test", ...over };
    }
    return startRuntime({ ...env, MODEL_VARIANT: "chunked" });
  }

  test("C10 deltas carry the requested turn/callNo while the call runs off-transaction", async () => {
    const rt = await start();
    const sessionId = await createSession();
    const streamId = `session:${sessionId}`;
    const deltas: { turn: number; callNo: number; text: string }[] = [];
    rt.live.subscribe(streamId, {
      onAppend: () => undefined,
      onDelta: (delta) => deltas.push({ ...delta }),
    });

    const other = await createSession(); // the bystander's stream
    await postJson(`/api/sessions/${sessionId}/messages`, {
      clientMessageId: randomUUID(),
      text: "stream slowly",
    });
    await until(async () => (deltas.length >= 1 ? true : undefined));

    // While the model still streams: a bystander transaction commits, and the
    // stream holds no completion yet — the call is off any store transaction.
    let bystanderSettled = false;
    const bystander = rt.store
      .transaction((tx) =>
        append(tx, RUNTIME_WORKSPACE, [
          {
            streamId: `session:${other}`,
            events: [{ type: "run.progress", actor: "test", payload: { text: "bystander", milestone: "r15" } }],
          },
        ]),
      )
      .then(() => {
        bystanderSettled = true;
      });
    await expect.poll(() => bystanderSettled, { timeout: 2_000, interval: 10 }).toBe(true);
    const midCall = await rt.store.readStream(streamId, { workspaceId: RUNTIME_WORKSPACE });
    expect(midCall.filter((event) => event.type === "llm.completed")).toHaveLength(0);

    await until(async () =>
      (await eventsOf(rt, sessionId)).some((event) => event.type === "llm.completed") ? true : undefined,
    );
    const events = await eventsOf(rt, sessionId);
    const requested = [...events].reverse().find((event) => event.type === "llm.requested");
    expect(requested).toBeDefined();
    const { turn, callNo } = requested!.payload as { turn: number; callNo: number };

    expect(deltas.length).toBeGreaterThanOrEqual(2);
    for (const delta of deltas) {
      expect(delta.turn).toBe(turn);
      expect(delta.callNo).toBe(callNo);
    }
    for (let index = 1; index < deltas.length; index += 1) {
      expect(deltas[index]!.text.startsWith(deltas[index - 1]!.text), "cumulative delta text").toBe(true);
    }
  }, 30_000);
});
