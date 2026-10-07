// npm run seed -- --profile demo|lived-in [--branch <name>]
// An idempotent reset: migrations (unpooled URL), truncate, insert the profile's world, import its
// recordings, stamp seed_state. --branch resolves pooled+unpooled URLs through the neon CLI without
// printing them. Defaults: lived-in, on the .env branch. Never logs connection strings.
import { execFileSync } from "node:child_process";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import path from "node:path";
import { sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { createDb, loadRootEnv } from "./index";
import type { Db } from "./index";
import { importRecording } from "./recordings";
import * as schema from "./schema";
import { buildDemoWorld, buildLivedInWorld } from "@fabric/fixtures/profiles";
import type { SeedWorld } from "@fabric/fixtures/profiles";
import { recordings } from "@fabric/fixtures/recordings";

const NEON_PROJECT = "solitary-meadow-39146227";

/** `neon connection-string` prints the URL with credentials; capture it, never echo it. */
function branchUrls(branch: string): { pooled: string; unpooled: string } {
  const run = (args: string[]) => execFileSync("neon", args, { encoding: "utf8" }).trim().split("\n").pop()!.trim();
  return {
    pooled: run(["connection-string", "--project-id", NEON_PROJECT, "--branch", branch, "--pooled"]),
    unpooled: run(["connection-string", "--project-id", NEON_PROJECT, "--branch", branch]),
  };
}

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const profile = (flag("profile") ?? process.env.SEED_PROFILE ?? "lived-in") as "demo" | "lived-in";
if (profile !== "demo" && profile !== "lived-in") throw new Error(`unknown profile: ${profile}`);

loadRootEnv();
const branch = flag("branch") ?? process.env.NEON_BRANCH;
const urls = branch ? branchUrls(branch) : { pooled: process.env.DATABASE_URL, unpooled: process.env.DATABASE_URL_UNPOOLED };
if (!urls.pooled || !urls.unpooled) throw new Error("DATABASE_URL / DATABASE_URL_UNPOOLED missing (or pass --branch)");

const started = Date.now();

// Migrations first (unpooled), then data (pooled). Both are no-ops on an already-current branch.
{
  const u = createDb(urls.unpooled);
  await migrate(u.db, { migrationsFolder: path.resolve(import.meta.dirname, "../drizzle") });
  await u.close();
}

const db: Db = createDb(urls.pooled);

const TABLES = [
  "schedule_fires", "schedules", "weave_calendar", "weave_presence", "weave_pulse", "weave_items",
  "proposals", "dispositions", "chat_messages", "sessions",
  "reports", "artifacts", "context_snapshots", "run_events", "runs", "tasks", "projects",
  "org_handoffs", "org_slots", "organizations", "team_members", "teams", "persona_pool",
  "agent_memories", "agents", "seed_state",
  // `memories` is deliberately absent: re-seeding must not wipe the Mnemosyne import.
];
await db.db.execute(sql.raw(`truncate table ${TABLES.map((t) => `public.${t}`).join(", ")} restart identity cascade`));

const world: SeedWorld = profile === "demo" ? buildDemoWorld() : buildLivedInWorld();

// ---- registry ----
await db.db.insert(schema.agents).values(
  [...world.agents, ...world.communityAgents].map((p, i) => ({
    id: p.agent.id, ord: i, name: p.agent.name, role: p.agent.role, tagline: p.tagline,
    summary: p.agent.summary, personality: p.agent.personality, traits: p.agent.traits, tone: p.agent.tone,
    avatar: p.agent.avatar ?? null, model: p.agent.model, contextTokens: p.agent.contextTokens,
    memory: p.agent.memory, tools: p.agent.tools, greeting: p.agent.greeting, placeholder: p.agent.placeholder,
    suggestions: p.agent.suggestions ?? null, workspace: p.workspace, origin: p.origin ?? null,
    author: p.author ?? null, installs: p.installs ?? null, community: p.author != null,
    status: "active", isSeeded: true,
  })),
);
if (world.personaPool.length) await db.db.insert(schema.personaPool).values(world.personaPool.map((p, i) => ({ ...p, ord: i })));
for (const [ti, t] of [...world.teams, ...world.communityTeams].entries()) {
  await db.db.insert(schema.teams).values({
    id: t.id, ord: ti, name: t.name, tagline: t.tagline, purpose: t.purpose, status: t.status,
    origin: t.origin, author: t.author ?? null, installs: t.installs ?? null, community: t.author != null,
    workflow: t.workflow, criteria: t.criteria, reworkBudget: t.reworkBudget,
  });
  await db.db.insert(schema.teamMembers).values(t.members.map((m, mi) => ({
    teamId: t.id, agentId: m.agentId, ord: mi, duty: m.duty, lead: m.lead ?? false,
  })));
}
for (const o of world.organizations) {
  await db.db.insert(schema.organizations).values({ id: o.id, name: o.name, headId: o.headId });
  await db.db.insert(schema.orgSlots).values(o.slots.map((s, si) => ({ orgId: o.id, key: s.key, ord: si, teamId: s.teamId })));
  if (o.handoffs.length) {
    await db.db.insert(schema.orgHandoffs).values(o.handoffs.map((h, hi) => ({
      orgId: o.id, fromTeamId: h.from, toTeamId: h.to, ord: hi, question: h.question, preview: h.preview ?? false,
    })));
  }
}

// Demo seeds no tasks, loops or inbox items: drizzle rejects .values([]).
const insertAll = async <T extends PgTable>(table: T, rows: T["$inferInsert"][]) => {
  if (rows.length) await db.db.insert(table).values(rows);
};
await insertAll(schema.projects as PgTable, world.projects.map((p, i) => ({
  id: p.id, ord: i, name: p.name, goal: p.goal, archived: p.archived ?? false,
})));
await insertAll(schema.sessions as PgTable, world.sessions.map((s, i) => ({
  id: s.id, ord: i, title: s.title, href: s.href, projectId: s.projectId ?? null,
  status: s.status ?? null, agentId: s.agentId, teamId: s.teamId ?? null,
  messages: s.messages, newReplies: s.newReplies ?? null, updated: s.updated,
})));
await insertAll(schema.tasks as PgTable, world.tasks.map((t, i) => ({
  id: t.id, projectId: t.projectId, teamId: t.teamId, ord: i, title: t.title,
  proposal: t.proposal ?? null, preview: t.preview ?? false,
  recordingKey: t.recordingKey ?? null, sessionId: t.sessionId ?? null,
})));

// ---- loops (the plain ones; recordings come from their bundles) ----
for (const { run, events, snapshots } of world.runs) {
  const endedAt = run.status === "running" ? null : new Date(new Date(run.startedAt).getTime() + run.durationS * 1000);
  await db.db.insert(schema.runs).values({
    id: run.id, taskId: run.taskId, teamId: run.teamId, n: run.n, objective: run.objective,
    status: run.status, brief: run.brief, budget: run.budget, reworkBudget: run.reworkBudget,
    assistantTokens: run.assistantTokens, outcome: run.outcome ?? null, reportId: run.reportId ?? null,
    costUsd: String(run.costUsd), etaS: run.etaS != null ? String(run.etaS) : null,
    durationS: run.status === "running" ? null : String(run.durationS),
    recorded: run.recorded, startedAt: new Date(run.startedAt), startedAtText: run.startedAt, endedAt,
  });
  if (events.length) {
    await db.db.insert(schema.runEvents).values(events.map((e) => ({
      runId: run.id, seq: e.seq, t: String(e.t), type: e.type, actorAgentId: e.actorAgentId ?? null, payload: e.payload,
    })));
  }
  if (snapshots.length) {
    await db.db.insert(schema.contextSnapshots).values(snapshots.map((s, i) => ({
      id: s.id, ord: i, runId: run.id, agentId: s.agentId, step: s.step, assembledAtS: String(s.assembledAtS),
      sections: s.sections, totalTokens: s.totalTokens, tools: s.tools,
      lastDenied: s.lastDenied ?? null, notLoaded: s.notLoaded, note: s.note, sandbox: s.sandbox ?? null,
    })));
  }
}

// ---- recordings ----
for (const r of world.recordings) {
  const bundle = recordings[r.key];
  if (!bundle) throw new Error(`no recording bundle for key ${r.key}`);
  const imported = await importRecording(db, bundle, { taskId: r.attachTaskId });
  console.log(`imported recording ${r.key} → run ${imported.runId}, report ${imported.reportId}${r.attachTaskId ? ` (task ${r.attachTaskId})` : ""}`);
}

// ---- weave ----
await insertAll(schema.weaveItems as PgTable, world.weave.items.map((item, i) => ({
  id: item.id, ord: i, kind: item.kind, agentId: item.agentId, taskId: item.taskId ?? null,
  at: item.at, data: item,
})));
// Demo's pulse is empty by design (SEED-1); every weave list takes the guard.
await insertAll(schema.weavePulse as PgTable, world.weave.pulse.map((entry, i) => ({ id: entry.id, ord: i, data: entry })));
await insertAll(schema.weavePresence as PgTable, world.weave.presence.map((p, i) => ({ agentId: p.agentId, ord: i, data: p })));
await insertAll(schema.weaveCalendar as PgTable, world.weave.calendar.map((e, i) => ({ id: e.id, ord: i, data: e })));


// ---- schedules (SCH): the routines and their past fires; createdAt = the fixture's, so the
// catch-up sweep never backfills "missed" over the seeded week ----
await insertAll(schema.schedules as PgTable, world.schedules.map((s) => ({
  id: s.id, title: s.title, kind: s.kind, agentId: s.agentId, teamId: s.teamId ?? null,
  projectId: s.projectId ?? null, prompt: s.prompt, recurrence: s.recurrence, cron: s.cron,
  tz: s.tz, durationMin: s.durationMin, enabled: s.enabled, sessionId: s.sessionId,
  createdAt: new Date(s.createdAt),
})));
await insertAll(schema.scheduleFires as PgTable, world.scheduleFires.map((f) => ({
  id: f.id, scheduleId: f.scheduleId, scheduledFor: new Date(f.scheduledFor),
  firedAt: f.firedAt ? new Date(f.firedAt) : null, status: f.status,
  runId: f.runId ?? null, taskId: f.taskId ?? null, messageId: f.messageId ?? null, error: f.error ?? null,
})));
await db.db.insert(schema.seedState).values({ profile });
await db.close();
console.log(`seeded profile ${profile}${branch ? ` on branch ${branch}` : ""} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
