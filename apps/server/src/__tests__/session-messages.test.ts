// ANY-60 S10 — system messages on the session stream: a finished run's results
// (finalize) and a scheduled digest (schedule-fire) land as `agent.message`
// telemetry on `session:<id>` when the session lives on the log, and legacy
// chat threads keep the chat_messages insert plus the `session.message`
// AppEvent, exactly as on main. Five cases, R1–R5, each named by its ID, on
// both store drivers via the runtime suite's harness. The app-side singleton
// (`services/runtime.ts`) is env-built, so the test seams it at the module:
// its db is the case's real migrated app database and its assistant the spy
// standing in for the legacy insert.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type { AppEvent, Schedule, ScheduleFire } from "@fabric/contracts";
import type { Assistant } from "@fabric/agents/assistant";
import { createDb, sql, type Db } from "@fabric/db";
import { describeDrivers, postgresUrlFromEnv } from "@fabric/runtime/testing";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import { finalizeRun } from "../services/finalize";
import { hub } from "../services/hub";
import { runScheduleFire } from "../services/schedule-fire";
import type { Runtime } from "../services/runtime";
import {
  getRuntime,
  RUNTIME_WORKSPACE,
  setRuntime,
  startRuntime,
  type FabricRuntime,
  type RuntimeEnv,
} from "../runtime/bootstrap";
import { sessions } from "../routes/sessions";

// The app-runtime seam: finalize and schedule-fire resolve their database and
// the legacy assistant through `runtime()`; the stub is installed per case,
// before any of them runs.
const appRuntime = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("../services/runtime", () => ({
  runtime: () => {
    if (appRuntime.current === undefined) throw new Error("S10: the app-runtime stub is not installed");
    return appRuntime.current;
  },
}));

const app = (): Hono => new Hono().route("/api", sessions);

const streamOf = (rt: FabricRuntime, sessionId: string) =>
  rt.store.readStream(`session:${sessionId}`, { workspaceId: RUNTIME_WORKSPACE });

const agentMessages = async (rt: FabricRuntime, sessionId: string) =>
  (await streamOf(rt, sessionId)).filter((event) => event.type === "agent.message");

// -- the legacy assistant, spied ------------------------------------------------

const makeAssistantStub = () => ({
  // The legacy insert: one chat_messages row; the id the ping carries.
  postResultsMessage: vi.fn(async () => ({ messageId: "legacy-msg-1" })),
  // The scheduled turn: the digest lands in the thread, id returned.
  runScheduled: vi.fn(async () => ({ messageId: DIGEST_ID })),
});
type AssistantStub = ReturnType<typeof makeAssistantStub>;
let assistant: AssistantStub;

// The digest a scheduled turn leaves in the thread (the row the real
// `runScheduled` writes); the fire's read-back must find it by id.
const DIGEST_ID = "digest-1";
const DIGEST_PARTS = [
  { type: "text", text: "Morning brief · Tue Oct 14" },
  { type: "text", text: "Three things happened; none need you." },
] as const;
const DIGEST_TEXT = DIGEST_PARTS.map((part) => part.text).join("\n\n");

let appEvents: AppEvent[] = [];
let unsubscribe: (() => void) | undefined;

beforeEach(() => {
  assistant = makeAssistantStub();
  appEvents = [];
  unsubscribe = hub.subscribeApp((event) => appEvents.push(event));
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = undefined;
});

const sessionMessages = () =>
  appEvents.filter((event): event is Extract<AppEvent, { type: "session.message" }> => event.type === "session.message");

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// -- per-case backends (the S8a harness: fresh PGlite dir, fresh databases) ----

const MIGRATIONS = path.resolve(import.meta.dirname, "../../../../packages/db/drizzle");

const state: {
  dir?: string;
  admin?: { admin: Db; create: (name: string) => Promise<void>; drop: (name: string) => Promise<void> };
  app?: Db;
  databases: string[];
} = { databases: [] };

let base: string | undefined;

const admin = async (): Promise<NonNullable<typeof state.admin>> => {
  if (state.admin) return state.admin;
  const adminUrl = new URL(base!);
  adminUrl.pathname = "/postgres";
  const db = createDb(adminUrl.toString());
  state.admin = {
    admin: db,
    create: (name) => db.db.execute(sql.raw(`create database "${name}"`)).then(() => undefined),
    drop: (name) =>
      db.db.execute(sql.raw(`drop database if exists "${name}" with (force)`)).then(() => undefined),
  };
  return state.admin;
};

const reset = async (): Promise<void> => {
  const rt = getRuntime();
  setRuntime(undefined);
  if (rt) await rt.stop();
  await state.app?.close();
  state.app = undefined;
  appRuntime.current = undefined;
  if (state.dir !== undefined) {
    await rm(state.dir, { recursive: true, force: true });
    state.dir = undefined;
  }
  if (state.admin !== undefined) {
    for (const name of state.databases) await dropQuiesced(name);
    state.databases = [];
  }
};

/** Wait until no live backend holds the database, then drop (see S8a: a forced
 * drop racing a closing pool surfaces as a late socket error). */
const dropQuiesced = async (name: string): Promise<void> => {
  if (state.admin === undefined) return;
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      const live = await state.admin.admin.db.execute(
        sql`select 1 from pg_stat_activity where datname = ${name}`,
      );
      if (live.rows.length === 0 || Date.now() > deadline) break;
    } catch {
      break; // the probe is best-effort; the drop's own guard handles the rest
    }
    await sleep(10);
  }
  await state.admin.drop(name).catch(() => undefined);
};

afterEach(reset);

afterAll(() => {
  state.admin?.admin.close();
  state.admin = undefined;
});

// -- the seeded run: a task pointing at the case's session, an unfinished run --

const seedRun = async (
  db: Db,
  input: { runId: string; taskId: string; sessionId: string },
): Promise<void> => {
  await db.db.execute(sql`
    insert into tasks (id, project_id, team_id, ord, title, session_id)
    values (${input.taskId}, 'proj-s10', 'team-s10', 0, 'The run', ${input.sessionId})`);
  await db.db.execute(sql`
    insert into runs (id, task_id, team_id, n, objective, status, brief, budget, started_at, ended_at)
    values (${input.runId}, ${input.taskId}, 'team-s10', 1, 'Check the stream', 'accepted',
            '{}'::jsonb, '{}'::jsonb, now(), now())`);
};

const seedDigest = async (db: Db, sessionId: string): Promise<void> => {
  await db.db.execute(sql`
    insert into chat_messages (id, session_id, role, content)
    values (${DIGEST_ID}, ${sessionId}, 'assistant', ${JSON.stringify(DIGEST_PARTS)}::jsonb)`);
};

const suffix = (): string => randomUUID().replace(/-/g, "").slice(0, 8);

describeDrivers("S10 server: system messages on the session stream (ANY-60)", (h) => {
  base = postgresUrlFromEnv();
  if (!base) return; // no postgres to host the app schema: nothing to run here

  /** The runtime on this case's own backends plus a migrated app database; the
   * app singleton rides the module stub, exactly the seam finalize uses. */
  async function start(): Promise<{ rt: FabricRuntime; appDb: Db }> {
    const url = (name: string): string => {
      const parsed = new URL(base!);
      parsed.pathname = `/${name}`;
      return parsed.toString();
    };
    const registry = await admin();
    const appDbName = `fabric_s10_app_${suffix()}`;
    state.databases.push(appDbName);
    await registry.create(appDbName);

    const env: RuntimeEnv & { DATABASE_URL?: string } =
      h.driver === "pglite"
        ? { RUNTIME_PGLITE_DIR: (state.dir = await mkdtemp(path.join(tmpdir(), "fabric-s10-"))), MODEL_PORT: "test" }
        : {};
    if (h.driver !== "pglite") {
      const runtimeDb = `fabric_s10_rt_${suffix()}`;
      state.databases.push(runtimeDb);
      await registry.create(runtimeDb);
      env.RUNTIME_DATABASE_URL = url(runtimeDb);
    }
    env.MODEL_PORT = "test";

    const appDb = createDb(url(appDbName));
    state.app = appDb;
    await migrate(appDb.db, { migrationsFolder: MIGRATIONS });

    // The app singleton the mocked module hands out: the case's real database,
    // the stubbed assistant for the legacy path.
    appRuntime.current = {
      db: appDb,
      writer: {},
      team: () => undefined,
      assistant: () => assistant as unknown as Assistant,
    } as unknown as Runtime;

    const rt = await startRuntime(env);
    setRuntime(rt);
    return { rt, appDb };
  }

  /** A log session, the way any client makes one. */
  async function createLogSession(): Promise<string> {
    const response = await app().request("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ agentId: "dana" }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { sessionId: string }).sessionId;
  }

  const finalizeSeededRun = async (appDb: Db, sessionId: string): Promise<string> => {
    const runId = `run-${suffix()}`;
    await seedRun(appDb, { runId, taskId: `task-${suffix()}`, sessionId });
    await finalizeRun(runId);
    return runId;
  };

  const scheduleOf = (sessionId: string): { schedule: Schedule; fire: ScheduleFire; slot: string } => {
    const slot = "2026-10-14T09:00:00.000Z";
    const schedule = {
      id: "sched-s10",
      kind: "assistant",
      title: "Morning brief",
      prompt: "The brief, please.",
      sessionId,
      tz: "UTC",
      enabled: true,
      createdAt: new Date().toISOString(),
    } as unknown as Schedule;
    const fire = { id: "fire-s10", scheduleId: "sched-s10", scheduledFor: slot, status: "fired" } as unknown as ScheduleFire;
    return { schedule, fire, slot };
  };

  test("R1: a log session's finalized run appends one agent.message id results:<runId>; the legacy insert is skipped", async () => {
    const { rt, appDb } = await start();
    const sessionId = await createLogSession();
    const runId = await finalizeSeededRun(appDb, sessionId);

    const messages = await agentMessages(rt, sessionId);
    expect(messages, "the results event on the stream").toHaveLength(1);
    expect(messages[0]!.causation).toBe(`results:${runId}`);
    expect(typeof (messages[0]!.payload as { text: string }).text).toBe("string");
    expect(assistant.postResultsMessage, "the legacy insert").not.toHaveBeenCalled();
    expect(sessionMessages(), "no ping for a stream session").toHaveLength(0);
  });

  test("R2: finalizing the same run twice still leaves one results event", async () => {
    const { rt, appDb } = await start();
    const sessionId = await createLogSession();
    const runId = await finalizeSeededRun(appDb, sessionId);
    await finalizeRun(runId); // the idempotent second pass

    expect(await agentMessages(rt, sessionId)).toHaveLength(1);
    expect(assistant.postResultsMessage).not.toHaveBeenCalled();
  });

  test("R3: a legacy session keeps the chat insert and the session.message ping; the store stays untouched", async () => {
    const { rt, appDb } = await start();
    const legacyId = `legacy-${suffix()}`; // a thread with no stream anywhere
    await finalizeSeededRun(appDb, legacyId);

    expect(assistant.postResultsMessage).toHaveBeenCalledTimes(1);
    expect(assistant.postResultsMessage).toHaveBeenCalledWith(
      legacyId,
      expect.objectContaining({ reportId: expect.stringContaining("report-") }),
    );
    const pings = sessionMessages();
    expect(pings).toHaveLength(1);
    expect(pings[0]).toMatchObject({ sessionId: legacyId, messageId: "legacy-msg-1" });
    expect(await streamOf(rt, legacyId)).toHaveLength(0);

    // The stream/legacy selector itself: a missing stream posts nothing and
    // reports the legacy path, which is what keeps finalize on the code above.
    const { postSystemMessage } = await import("../runtime/session-messages");
    const missing = `missing-${suffix()}`;
    expect(await postSystemMessage(rt, missing, { id: "probe:none", text: "x" })).toBe(false);
    expect(await streamOf(rt, missing)).toHaveLength(0);
  });

  test("R4: a schedule fire on a log session appends one digest event schedule:<id>:<slot>; a refired slot is a no-op", async () => {
    const { rt, appDb } = await start();
    const sessionId = await createLogSession();
    await seedDigest(appDb, sessionId);
    const { schedule, fire, slot } = scheduleOf(sessionId);
    await appDb.db.execute(sql`
      insert into schedule_fires (id, schedule_id, scheduled_for)
      values (${fire.id}, ${schedule.id}, ${slot})`);

    await runScheduleFire(schedule, fire);

    const messages = await agentMessages(rt, sessionId);
    expect(messages, "the digest event on the stream").toHaveLength(1);
    expect(messages[0]!.causation).toBe(`schedule:${schedule.id}:${slot}`);
    expect((messages[0]!.payload as { text: string }).text).toBe(DIGEST_TEXT);
    expect(sessionMessages(), "no ping for a stream session").toHaveLength(0);

    await runScheduleFire(schedule, fire); // the same slot, once more
    expect(await agentMessages(rt, sessionId)).toHaveLength(1);
  });

  test("R5: the results event is telemetry — the session's decide never starts a turn", async () => {
    const { rt, appDb } = await start(); // workers on: a wrong enqueue would turn
    const sessionId = await createLogSession();
    await finalizeSeededRun(appDb, sessionId);

    expect(await agentMessages(rt, sessionId)).toHaveLength(1);
    await sleep(300); // long enough for a wrongly planned decide to have run
    const events = await streamOf(rt, sessionId);
    expect(events.filter((event) => event.type === "llm.requested")).toHaveLength(0);
  });
});
