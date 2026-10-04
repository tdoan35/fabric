// SCH owns this file: firing one claimed slot, one function per job kind. Team jobs go through the
// same starter the dev route uses (startTeamJob) — brief from the routine's prompt plus the team's
// criteria — so finalizeRun still posts the results into the routine's thread for free. Assistant
// jobs are Dana's scheduled turn (assistant.runScheduled). Every outcome lands on the fire and
import type { Schedule, ScheduleFire } from "@fabric/contracts";
import { finishFire, readRegistry, sql } from "@fabric/db";
import type { Db } from "@fabric/db";
import { hub } from "./hub";
import { runtime } from "./runtime";
import { startTeamJob } from "./dev-team";
import { STAYED } from "./dev-team";

/** The fire-and-forget entry the route and the scheduler call: runs the job, records the outcome. */
export async function runScheduleFire(schedule: Schedule, fire: ScheduleFire): Promise<void> {
  const { db } = runtime();
  try {
    if (schedule.kind === "team") await fireTeamJob(schedule, fire);
    else await fireAssistantJob(schedule, fire);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[schedule] fire ${fire.id} failed:`, error);
    await finishFire(db, fire.id, { status: "failed", error });
  } finally {
    hub.publishApp({ type: "schedule.changed" });
  }
}

/** The default project for routines, created on first use (same id rule as POST /api/projects). */
async function routinesProjectId(db: Db): Promise<string> {
  const exists = await db.db.execute(sql`select id from projects where id = 'routines'`);
  if (exists.rows.length) return "routines";
  await db.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('projects', 0))`);
    await tx.execute(sql`
      insert into projects (id, ord, name, goal)
      values ('routines', (select coalesce(max(ord), -1) + 1 from projects), 'Routines',
              'What the teams run on their own schedule.')
      on conflict do nothing`);
  });
  return "routines";
}

/** "<title> · Mon Oct 5": which routine, which visit. */
const fireTitle = (schedule: Schedule, fire: ScheduleFire): string => {
  const day = new Intl.DateTimeFormat("en-US", { timeZone: schedule.tz, weekday: "short", month: "short", day: "numeric" }).format(new Date(fire.scheduledFor));
  return `${schedule.title} · ${day}`;
};

async function fireTeamJob(schedule: Schedule, fire: ScheduleFire): Promise<void> {
  const { db, writer, team } = runtime();
  const teamRuntime = team();
  if (!teamRuntime) throw new Error("TEAM runtime not available");

  const registry = await readRegistry(db);
  const definition = registry.teams.find((t) => t.id === schedule.teamId);
  if (!definition) throw new Error(`team ${schedule.teamId} no longer exists`);

  const projectId = schedule.projectId ?? (await routinesProjectId(db));
  const { taskId, runId } = await startTeamJob(writer, teamRuntime, {
    teamId: definition.id,
    projectId,
    title: fireTitle(schedule, fire),
    objective: schedule.prompt,
    criteria: definition.criteria,
    stayed: [...STAYED],
    sessionId: schedule.sessionId,
  });

  await finishFire(db, fire.id, { runId, taskId });
  hub.publishApp({ type: "task.changed", taskId });
  hub.publishApp({ type: "run.changed", runId });
}

async function fireAssistantJob(schedule: Schedule, fire: ScheduleFire): Promise<void> {
  const assistant = runtime().assistant();
  if (!assistant) throw new Error("DANA not available");

  const { messageId } = await assistant.runScheduled({
    sessionId: schedule.sessionId,
    title: schedule.title,
    prompt: schedule.prompt,
  });
  await finishFire(runtime().db, fire.id, { messageId });
  hub.publishApp({ type: "session.message", sessionId: schedule.sessionId, messageId });
  hub.publishApp({ type: "registry.changed" }); // the thread's row: count and unread state
}
