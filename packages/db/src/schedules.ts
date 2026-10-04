// Schedule persistence (SCH): routines and their fires. Claiming is `insert … on conflict do
// nothing returning` on the unique (schedule_id, scheduled_for), so two processes racing a slot
// both insert and exactly one sees a row — the loser reads undefined and moves on.
import { sql } from "drizzle-orm";
import type { RunStatus, Schedule, ScheduleFire, ScheduleFireStatus, SchedulePatch } from "@fabric/contracts";
import type { Db } from "./db";
import { slugId } from "./writer";

/** A fire with its run joined in, so the occurrence overlay can state the block without another
 *  round trip: a team fire's state follows its run, and accepted carries the report. */
export interface FireWithRun extends ScheduleFire {
  runStatus?: RunStatus;
  reportId?: string;
}

const iso = (d: Date | string | null | undefined) => (d == null ? undefined : new Date(d).toISOString());

function scheduleFromRow(r: Record<string, unknown>): Schedule {
  return {
    id: r.id as string,
    title: r.title as string,
    kind: r.kind as "team" | "assistant",
    agentId: r.agent_id as string,
    teamId: (r.team_id as string | null) ?? undefined,
    projectId: (r.project_id as string | null) ?? undefined,
    prompt: r.prompt as string,
    recurrence: r.recurrence as Schedule["recurrence"],
    cron: r.cron as string,
    tz: r.tz as string,
    durationMin: r.duration_min as number,
    enabled: r.enabled as boolean,
    sessionId: r.session_id as string,
    createdAt: iso(r.created_at as Date)!,
  };
}

export async function listSchedules(db: Db): Promise<Schedule[]> {
  const rows = await db.db.execute(sql`select * from schedules order by created_at asc, id asc`);
  return rows.rows.map(scheduleFromRow);
}

export async function getSchedule(db: Db, id: string): Promise<Schedule | undefined> {
  const rows = await db.db.execute(sql`select * from schedules where id = ${id}`);
  return rows.rows[0] ? scheduleFromRow(rows.rows[0]) : undefined;
}

/** The fields the route resolves before insert: agentId, cron, sessionId (and createdAt for seed). */
export type NewSchedule = Omit<Schedule, "id" | "createdAt"> & { id?: string; createdAt?: Date };

export async function insertSchedule(db: Db, s: NewSchedule): Promise<Schedule> {
  // Same id rule as tasks/projects: the slug, or slug-(count+1), stamped under the table lock.
  const id = await db.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('schedules', 0))`);
    const base = s.id ?? slugId(s.title);
    const counts = await tx.execute(sql`
      select count(*) filter (where id = ${base}) as taken, count(*) as total from schedules`);
    const { taken, total } = counts.rows[0] as { taken: string; total: string };
    const chosen = Number(taken) > 0 ? `${base}-${Number(total) + 1}` : base;
    await tx.execute(sql`
      insert into schedules (id, title, kind, agent_id, team_id, project_id, prompt, recurrence, cron, tz,
                             duration_min, enabled, session_id, created_at)
      values (${chosen}, ${s.title}, ${s.kind}, ${s.agentId}, ${s.teamId ?? null}, ${s.projectId ?? null},
              ${s.prompt}, ${JSON.stringify(s.recurrence)}::jsonb, ${s.cron}, ${s.tz},
              ${s.durationMin}, ${s.enabled}, ${s.sessionId}, ${s.createdAt ?? sql`now()`})`);
    return chosen;
  });
  return (await getSchedule(db, id))!;
}

/** PATCH: only the given columns move; `cron` is re-derived when `recurrence` changes (route). */
export async function updateSchedule(
  db: Db,
  id: string,
  patch: SchedulePatch & { agentId?: string; cron?: string },
): Promise<Schedule | undefined> {
  const sets = {
    title: patch.title,
    kind: patch.kind,
    agent_id: patch.agentId,
    team_id: patch.teamId,
    project_id: patch.projectId,
    prompt: patch.prompt,
    recurrence: patch.recurrence ? JSON.stringify(patch.recurrence) : undefined,
    cron: patch.cron,
    tz: patch.tz,
    duration_min: patch.durationMin,
    enabled: patch.enabled,
  };
  const columns = Object.entries(sets).filter(([, v]) => v !== undefined).map(([k, v]) => k);
  if (!columns.length) return getSchedule(db, id);
  await db.db.execute(sql`
    update schedules set ${sql.join(
      columns.map((c) => {
        const raw = (sets as Record<string, unknown>)[c];
        const value = c === "recurrence" ? sql`${raw}::jsonb` : sql`${raw}`;
        return sql`${sql.identifier(c)} = ${value}`;
      }),
      sql`, `,
    )} where id = ${id}`);
  return getSchedule(db, id);
}

/** Deletes the routine and its fires: gone means gone (pause keeps history; delete doesn't). */
export async function deleteSchedule(db: Db, id: string): Promise<boolean> {
  const rows = await db.db.execute(sql`delete from schedules where id = ${id} returning id`);
  if (!rows.rows.length) return false;
  await db.db.execute(sql`delete from schedule_fires where schedule_id = ${id}`);
  return true;
}

const fireId = (scheduleId: string, scheduledFor: Date) =>
  `fire-${scheduleId}-${scheduledFor.toISOString().replace(/[-:]/g, "").slice(0, 12)}`;

/**
 * Claims one slot. Returns the new fire, or undefined when the slot is already taken — that is the
 * race loser, or the slot was claimed earlier (skip, miss, prior run).
 */
export async function claimFire(
  db: Db,
  scheduleId: string,
  scheduledFor: Date,
  status: "fired" | "skipped" | "missed" = "fired",
): Promise<ScheduleFire | undefined> {
  const rows = await db.db.execute(sql`
    insert into schedule_fires (id, schedule_id, scheduled_for, fired_at, status)
    values (${fireId(scheduleId, scheduledFor)}, ${scheduleId}, ${scheduledFor}, now(), ${status})
    on conflict do nothing
    returning id, schedule_id, scheduled_for, fired_at, status`);
  const r = rows.rows[0];
  if (!r) return undefined;
  return {
    id: r.id as string,
    scheduleId: r.schedule_id as string,
    scheduledFor: iso(r.scheduled_for as Date)!,
    firedAt: iso(r.fired_at as Date),
    status: r.status as ScheduleFireStatus,
  };
}

/** Fills in what the fire's work produced; `status` moves to failed on error. */
export async function finishFire(
  db: Db,
  id: string,
  patch: { status?: ScheduleFireStatus; runId?: string; taskId?: string; messageId?: string; error?: string },
): Promise<void> {
  await db.db.execute(sql`
    update schedule_fires set
      status = coalesce(${patch.status ?? null}, status),
      run_id = coalesce(${patch.runId ?? null}, run_id),
      task_id = coalesce(${patch.taskId ?? null}, task_id),
      message_id = coalesce(${patch.messageId ?? null}, message_id),
      error = ${patch.error ?? null}
    where id = ${id}`);
}

/** Fires in [from, to), with each fire's run status and report joined in. */
export async function listFires(db: Db, from: Date, to: Date): Promise<FireWithRun[]> {
  const rows = await db.db.execute(sql`
    select f.id, f.schedule_id, f.scheduled_for, f.fired_at, f.status, f.run_id, f.task_id, f.message_id, f.error,
           r.status as run_status, r.report_id
    from schedule_fires f left join runs r on r.id = f.run_id
    where f.scheduled_for >= ${from} and f.scheduled_for < ${to}
    order by f.scheduled_for asc`);
  return rows.rows.map((r) => ({
    id: r.id as string,
    scheduleId: r.schedule_id as string,
    scheduledFor: iso(r.scheduled_for as Date)!,
    firedAt: iso(r.fired_at as Date),
    status: r.status as ScheduleFireStatus,
    runId: (r.run_id as string | null) ?? undefined,
    taskId: (r.task_id as string | null) ?? undefined,
    messageId: (r.message_id as string | null) ?? undefined,
    error: (r.error as string | null) ?? undefined,
    runStatus: (r.run_status as RunStatus | null) ?? undefined,
    reportId: (r.report_id as string | null) ?? undefined,
  }));
}
