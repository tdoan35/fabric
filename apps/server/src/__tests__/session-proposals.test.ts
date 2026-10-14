// ANY-57 S8a — the endpoint cases P4..P6, verbatim from the card, on both store
// drivers. POST /api/sessions/:id/proposals/:pid/decision appends the
// `proposal.decided` fact (so Dana's decide runs), applies the transition's side
// effects once, and 409s a second decision. The proposal row is seeded through
// the same columns the loop's store writes; the app schema comes from the
// repo's drizzle migrations, one disposable database per case. The read model is
// driver-independent — only the event log's driver varies.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { createDb, sql, type Db } from "@fabric/db";
import { describeDrivers, postgresUrlFromEnv } from "@fabric/runtime/testing";
import { migrate } from "drizzle-orm/node-postgres/migrator";
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

const eventsOf = async (rt: FabricRuntime, sessionId: string) =>
  rt.store.readStream(`session:${sessionId}`, { workspaceId: RUNTIME_WORKSPACE });

const factsOf = async (rt: FabricRuntime, sessionId: string, type: string) =>
  (await eventsOf(rt, sessionId)).filter((event) => event.type === type);

/** A pending proposal row, the way the loop's store path leaves it. */
const seedProposal = async (
  db: Db,
  input: { id: string; sessionId: string; toolCallId: string; kind?: string; payload?: Record<string, unknown> },
): Promise<void> => {
  const payload = input.payload ?? { name: "Dig Team", purpose: "dig", roster: [] };
  await db.db.execute(sql`
    insert into proposals (id, kind, payload, status, session_id, tool_call_id)
    values (${input.id}, ${input.kind ?? "team"}, ${JSON.stringify(payload)}::jsonb, 'pending',
            ${input.sessionId}, ${input.toolCallId})`);
};

const teamCount = async (db: Db, name: string): Promise<number> => {
  const rows = await db.db.execute(sql`select count(*)::int as n from teams where name = ${name}`);
  return Number((rows.rows[0] as { n: number }).n);
};

const proposalStatuses = async (db: Db) => {
  const result = await db.db.execute(sql`select id, status from proposals order by id`);
  return result.rows as unknown as { id: string; status: string }[];
};

const MIGRATIONS = path.resolve(import.meta.dirname, "../../../../packages/db/drizzle");

// Per-test backends: a fresh PGlite dir for the event log, and fresh postgres
// databases — the event log's on the pg leg, the app schema's on both legs.
const state: {
  dir?: string;
  admin?: { admin: Db; create: (name: string) => Promise<void>; drop: (name: string) => Promise<void> };
  app?: Db;
  databases: string[];
} = { databases: [] };

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
  if (state.dir !== undefined) {
    await rm(state.dir, { recursive: true, force: true });
    state.dir = undefined;
  }
  if (state.admin !== undefined) {
    for (const name of state.databases) await state.admin.drop(name).catch(() => undefined);
    state.databases = [];
  }
};

afterEach(reset);

afterAll(() => {
  state.admin?.admin.close();
  state.admin = undefined;
});

const base = postgresUrlFromEnv();

describeDrivers("S8a server: the proposal-decision endpoint (ANY-57)", (h) => {
  if (!base) return; // no postgres to host the app schema: nothing to run here

  /** The runtime on this case's own backends plus a migrated app database; the
   * read-model gateway rides the runtime object, exactly as production wires it. */
  async function start(): Promise<{ rt: FabricRuntime; appDb: Db }> {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
    const url = (name: string): string => {
      const parsed = new URL(base!);
      parsed.pathname = `/${name}`;
      return parsed.toString();
    };
    const registry = await admin();
    const appDbName = `fabric_s8a_app_${suffix}`;
    state.databases.push(appDbName);
    await registry.create(appDbName);

    const env: RuntimeEnv & { DATABASE_URL?: string } =
      h.driver === "pglite"
        ? {
            RUNTIME_PGLITE_DIR: (state.dir = await mkdtemp(path.join(tmpdir(), "fabric-s8a-"))),
            MODEL_PORT: "test",
          }
        : {};
    if (h.driver !== "pglite") {
      const runtimeDb = `fabric_s8a_rt_${suffix}`;
      state.databases.push(runtimeDb);
      await registry.create(runtimeDb);
      env.RUNTIME_DATABASE_URL = url(runtimeDb);
    }
    env.MODEL_PORT = "test";

    const appDb = createDb(url(appDbName));
    state.app = appDb;
    await migrate(appDb.db, { migrationsFolder: MIGRATIONS });

    env.DATABASE_URL = url(appDbName);
    const rt = await startRuntime(env);
    setRuntime(rt);
    return { rt, appDb };
  }

  const session = async (): Promise<string> => {
    const response = await postJson("/api/sessions", { agentId: "dana" });
    expect(response.status).toBe(200);
    return ((await response.json()) as { sessionId: string }).sessionId;
  };

  test("P4 the decision endpoint appends proposal.decided, runs the transition's side effect once, and marks the row approved", async () => {
    const { rt, appDb } = await start();
    const sessionId = await session();
    await seedProposal(appDb, { id: "prop-1", sessionId, toolCallId: "c1" });
    expect(await teamCount(appDb, "Dig Team")).toBe(0);

    const decided = await postJson(`/api/sessions/${sessionId}/proposals/prop-1/decision`, { decision: "approve" });
    expect(decided.status).toBe(200);

    const decidedFacts = await factsOf(rt, sessionId, "proposal.decided");
    expect(decidedFacts).toHaveLength(1);
    expect(decidedFacts[0]!.payload).toEqual({ kind: "team", decision: "approve", by: "user" });

    const status = await appDb.db.execute(sql`select status from proposals where id = 'prop-1'`);
    expect((status.rows[0] as { status: string }).status).toBe("approved");
    expect(await teamCount(appDb, "Dig Team")).toBe(1); // the transition's side effect, once
  }, 30_000);

  test("P5 a second decision is a 409 and appends nothing", async () => {
    const { rt, appDb } = await start();
    const sessionId = await session();
    await seedProposal(appDb, { id: "prop-1", sessionId, toolCallId: "c1" });

    expect(
      (await postJson(`/api/sessions/${sessionId}/proposals/prop-1/decision`, { decision: "approve" })).status,
    ).toBe(200);
    const before = (await eventsOf(rt, sessionId)).length;

    const second = await postJson(`/api/sessions/${sessionId}/proposals/prop-1/decision`, { decision: "decline" });
    expect(second.status).toBe(409);
    expect((await eventsOf(rt, sessionId)).length).toBe(before); // nothing appended
    expect(await teamCount(appDb, "Dig Team")).toBe(1); // and no second side effect
  }, 30_000);

  test("P6 decline and discuss each append their decision; discuss leaves the row open", async () => {
    const { rt, appDb } = await start();
    const sessionId = await session();
    await seedProposal(appDb, { id: "prop-2", sessionId, toolCallId: "c2" });
    await seedProposal(appDb, { id: "prop-3", sessionId, toolCallId: "c3" });

    expect(
      (await postJson(`/api/sessions/${sessionId}/proposals/prop-2/decision`, { decision: "decline" })).status,
    ).toBe(200);
    expect(
      (await postJson(`/api/sessions/${sessionId}/proposals/prop-3/decision`, { decision: "discuss" })).status,
    ).toBe(200);

    const facts = await factsOf(rt, sessionId, "proposal.decided");
    expect(facts.map((fact) => fact.payload)).toEqual([
      { kind: "team", decision: "decline", by: "user" },
      { kind: "team", decision: "discuss", by: "user" },
    ]);

    expect(await proposalStatuses(appDb)).toEqual([
      { id: "prop-2", status: "declined" },
      { id: "prop-3", status: "pending" }, // discuss: the read model stays open
    ]);
    expect(await teamCount(appDb, "Dig Team")).toBe(0); // a decline creates nothing
  }, 30_000);
});
