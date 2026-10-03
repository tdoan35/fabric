// Read models: project rows into the exact shapes apps/web/src/lib/api returns today.
// `GET /runs/:id/events` returns the merged log once a run was spliced (D5), and Run.segments
// always derive from step events (RUN-7) — never stored.
import { asc, desc, eq, sql } from "drizzle-orm";
import type {
  ContextSnapshot, Organization, PersonaPoolEntry, Project, Registry, Report, Run, RunEvent,
  Session, StudioProfile, StudioTeam, Task, WeaveSnapshot,
} from "@fabric/contracts";
import type { Db } from "./db";
import { agents, artifacts, contextSnapshots, organizations, orgHandoffs, orgSlots, personaPool, projects, reports, runEvents, runs, sessions, tasks, teams, teamMembers, weaveCalendar, weaveItems, weavePresence, weavePulse } from "./schema";
import { rowToRun } from "./writer";

export interface RunRowLike {
  id: string; task_id: string | null; team_id: string; n: number | string;
  objective: string; status: string; brief: Run["brief"]; budget: Run["budget"];
  rework_budget: number; assistant_tokens: number; outcome: string | null; report_id: string | null;
  cost_usd: string; eta_s: string | null; duration_s: string | null; recorded: boolean;
  recording_key: string | null; recording_kind: string | null; spliced_from_run_id: string | null;
  splice_t: string | null; finalized_at: Date | null; started_at: Date; started_at_text: string | null; ended_at: Date | null;
}

const eventFromRow = (r: { runId: string; seq: number; t: string; type: RunEvent["type"]; actorAgentId: string | null; payload: Record<string, unknown> }): RunEvent => ({
  runId: r.runId, seq: Number(r.seq), t: Number(r.t), type: r.type, actorAgentId: r.actorAgentId ?? undefined, payload: r.payload,
});

/** The mock's order (sortEvents): by t, then by the source seq. */
export async function listStoredEvents(db: Db, runId: string): Promise<RunEvent[]> {
  const rows = await db.db.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(asc(runEvents.t), asc(runEvents.seq));
  return rows.map(eventFromRow);
}

/** The merged log: live events up to splice_t, then the recording's events after it, re-stamped
 *  with the live run's id and continuing seqs; the recording's own run.finished is dropped in
 *  favour of the live finalize's, which always lands last. */
export async function mergedEvents(db: Db, run: RunRowLike): Promise<RunEvent[]> {
  if (!run.spliced_from_run_id) return listStoredEvents(db, run.id);
  const live = await listStoredEvents(db, run.id);
  const spliceT = Number(run.splice_t ?? 0);
  const rec = (await listStoredEvents(db, run.spliced_from_run_id))
    .filter((e) => e.t > spliceT && e.type !== "run.finished")
    .map((e) => ({ ...e, runId: run.id }));
  // Second line of defence: only finalize's run.finished may follow the splice point; a late live
  // emit that slipped past the RunClosedError guard never reaches the merged log.
  const head = live.filter((e) => e.t <= spliceT);
  const tail = live.filter((e) => e.t > spliceT && e.type === "run.finished");
  // Re-stamp the whole log 1..N so seqs stay contiguous however t order and seq order interleaved.
  return [head, rec, tail]
    .flat()
    .map((e, i) => ({ ...e, runId: run.id, seq: i + 1 }));
}

export async function getRunRow(db: Db, runId: string): Promise<RunRowLike | undefined> {
  // Raw SQL: RunRowLike mirrors the snake_case columns node-postgres returns.
  const rows = await db.db.execute(sql`select * from runs where id = ${runId} limit 1`);
  return rows.rows[0] as unknown as RunRowLike | undefined;
}

export async function readRun(db: Db, runId: string): Promise<Run | undefined> {
  const row = await getRunRow(db, runId);
  if (!row) return undefined;
  const events = await mergedEvents(db, row);
  return rowToRun(row, events, Date.now());
}

export async function listRuns(db: Db): Promise<Run[]> {
  const rows = (await db.db.execute(sql`
    select r.* from runs r join tasks t on t.id = r.task_id
    order by t.ord asc, r.n asc`)).rows as unknown as RunRowLike[];
  const out: Run[] = [];
  for (const row of rows) out.push(rowToRun(row, await mergedEvents(db, row), Date.now()));
  return out;
}

export async function listTasks(db: Db): Promise<Task[]> {
  const rows = await db.db.select().from(tasks).orderBy(asc(tasks.ord), asc(tasks.createdAt));
  const loops = await db.db.select({ taskId: runs.taskId, id: runs.id, n: runs.n }).from(runs);
  return rows.map((t) => ({
    id: t.id, projectId: t.projectId, teamId: t.teamId, title: t.title,
    runIds: loops.filter((r) => r.taskId === t.id).sort((a, b) => a.n - b.n).map((r) => r.id),
    proposal: t.proposal ?? undefined, preview: t.preview || undefined,
    recordingKey: t.recordingKey ?? undefined, sessionId: t.sessionId ?? undefined,
  }));
}

export async function readTask(db: Db, id: string): Promise<Task | undefined> {
  return (await listTasks(db)).find((t) => t.id === id);
}

export async function listProjects(db: Db): Promise<Project[]> {
  const rows = await db.db.select().from(projects).orderBy(asc(projects.ord), asc(projects.createdAt));
  return rows.map((p) => ({ id: p.id, name: p.name, goal: p.goal, archived: p.archived || undefined }));
}

export async function listSnapshots(db: Db, runId: string): Promise<ContextSnapshot[]> {
  const rows = await db.db.select().from(contextSnapshots).where(eq(contextSnapshots.runId, runId)).orderBy(asc(contextSnapshots.ord));
  return rows.map((s) => ({
    id: s.id, runId: s.runId, agentId: s.agentId, step: s.step, assembledAtS: Number(s.assembledAtS),
    sections: s.sections, totalTokens: s.totalTokens, tools: s.tools,
    lastDenied: s.lastDenied ?? undefined, notLoaded: s.notLoaded, note: s.note, sandbox: s.sandbox ?? undefined,
  }));
}

export async function readReport(db: Db, id: string): Promise<Report | undefined> {
  const rows = await db.db.select().from(reports).where(eq(reports.id, id)).limit(1);
  const r = rows[0];
  if (!r) return undefined;
  return { id: r.id, runId: r.runId, title: r.title, intro: r.intro, summary: r.summary, results: r.results, caveats: r.caveats, provenance: r.provenance, madeBy: r.madeBy, artifacts: r.artifacts, emailed: r.emailed, setup: r.setup ?? undefined, kind: (r.kind ?? undefined) as Report["kind"] };
}

export async function readArtifact(db: Db, id: string): Promise<{ name: string; contentType: string; body: Buffer } | undefined> {
  const rows = await db.db.select().from(artifacts).where(eq(artifacts.id, id)).limit(1);
  const a = rows[0];
  if (!a) return undefined;
  const body = a.contentType === "application/octet-stream" ? Buffer.from(a.content, "base64") : Buffer.from(a.content, "utf8");
  return { name: a.name, contentType: a.contentType, body };
}

export async function latestRecordingRun(db: Db, key: string): Promise<RunRowLike | undefined> {
  const rows = await db.db.execute(sql`select * from runs where recorded and recording_key = ${key} order by started_at desc limit 1`);
  return rows.rows[0] as unknown as RunRowLike | undefined;
}

// ---- Registry ----

const profileFromRow = (r: typeof agents.$inferSelect): StudioProfile => ({
  agent: {
    id: r.id, name: r.name, role: r.role, avatar: r.avatar ?? undefined, tone: r.tone, summary: r.summary,
    personality: r.personality, traits: r.traits, model: r.model, contextTokens: r.contextTokens, memory: r.memory,
    tools: r.tools, greeting: r.greeting, placeholder: r.placeholder, suggestions: r.suggestions ?? undefined,
  },
  tagline: r.tagline, workspace: r.workspace, origin: r.origin ?? undefined,
  author: r.author ?? undefined, installs: r.installs ?? undefined,
});

const teamFromRow = (r: typeof teams.$inferSelect, members: (typeof teamMembers.$inferSelect)[]): StudioTeam => ({
  id: r.id, name: r.name, tagline: r.tagline, purpose: r.purpose,
  status: r.status as StudioTeam["status"], origin: r.origin,
  author: r.author ?? undefined, installs: r.installs ?? undefined,
  members: members.map((m) => ({ agentId: m.agentId, duty: m.duty, lead: m.lead || undefined })),
  workflow: r.workflow, reworkBudget: r.reworkBudget, criteria: r.criteria,
});

export async function readRegistry(db: Db): Promise<Registry> {
  const [agentRows, teamRows, memberRows, orgRows, slotRows, handoffRows, projectRows, sessionRows, poolRows] = await Promise.all([
    db.db.select().from(agents).where(sql`status = 'active'`).orderBy(asc(agents.ord)),
    db.db.select().from(teams).orderBy(asc(teams.ord)),
    db.db.select().from(teamMembers).orderBy(asc(teamMembers.ord)),
    db.db.select().from(organizations),
    db.db.select().from(orgSlots).orderBy(asc(orgSlots.ord)),
    db.db.select().from(orgHandoffs).orderBy(asc(orgHandoffs.ord)),
    listProjects(db),
    db.db.select().from(sessions).orderBy(asc(sessions.ord)),
    db.db.select().from(personaPool).orderBy(asc(personaPool.ord)),
  ]);
  const orgList: Organization[] = orgRows.map((o) => ({
    id: o.id, name: o.name, headId: o.headId,
    slots: slotRows.filter((s) => s.orgId === o.id).map((s) => ({ key: s.key, teamId: s.teamId })),
    handoffs: handoffRows.filter((h) => h.orgId === o.id).map((h) => ({ from: h.fromTeamId, to: h.toTeamId, question: h.question, preview: h.preview || undefined })),
  }));
  const sessionList: Session[] = sessionRows.map((s) => ({
    id: s.id, title: s.title, href: s.href, projectId: s.projectId ?? undefined,
    status: (s.status ?? undefined) as Session["status"], agentId: s.agentId, teamId: s.teamId ?? undefined,
    messages: s.messages, newReplies: s.newReplies ?? undefined, updated: s.updated,
  }));
  const poolList: PersonaPoolEntry[] = poolRows.map((p) => ({ id: p.id, name: p.name, role: p.role, avatar: p.avatar }));
  return {
    agents: agentRows.filter((a) => !a.community).map(profileFromRow),
    communityAgents: agentRows.filter((a) => a.community).map(profileFromRow),
    teams: teamRows.filter((t) => !t.community).map((t) => teamFromRow(t, memberRows.filter((m) => m.teamId === t.id))),
    communityTeams: teamRows.filter((t) => t.community).map((t) => teamFromRow(t, memberRows.filter((m) => m.teamId === t.id))),
    organizations: orgList,
    projects: projectRows,
    sessions: sessionList,
    personaPool: poolList,
  };
}

// ---- Weave ----

export async function readWeave(db: Db): Promise<WeaveSnapshot> {
  const [itemRows, pulseRows, presenceRows, calendarRows] = await Promise.all([
    db.db.select().from(weaveItems).orderBy(asc(weaveItems.ord)),
    db.db.select().from(weavePulse).orderBy(asc(weavePulse.ord)),
    db.db.select().from(weavePresence).orderBy(asc(weavePresence.ord)),
    db.db.select().from(weaveCalendar).orderBy(asc(weaveCalendar.ord)),
  ]);
  return {
    items: itemRows.map((i) => i.data),
    pulse: pulseRows.map((p) => p.data),
    presence: presenceRows.map((p) => p.data),
    calendar: calendarRows.map((c) => c.data),
  };
}

