// SCH owns this file. The routines CRUD (thread created with the routine), run-now and skip
// (claims on the slot), and the occurrences read model the calendar draws: cron expansion with
// fires overlaid — a fire wins its slot, and an off-pattern fire ("Run now") still shows.
import { Hono } from "hono";
import { ensureSession } from "@fabric/agents/assistant";
import { ScheduleInputSchema, SchedulePatchSchema, toCron } from "@fabric/contracts";
import type { SchedulePatch } from "@fabric/contracts";
import {
  claimFire, deleteSchedule, getSchedule, insertSchedule, listFires, listSchedules, readRegistry,
  slugId, updateSchedule,
} from "@fabric/db";
import { hub } from "../services/hub";
import { runtime } from "../services/runtime";
import { overlayOccurrences } from "../services/schedule-cron";
import { runScheduleFire } from "../services/schedule-fire";

/** Who fronts a routine: Dana for assistant jobs, the team's lead for team jobs. */
async function agentFor(kind: "team" | "assistant", teamId: string | undefined): Promise<string> {
  if (kind === "assistant" || !teamId) return "dana";
  const registry = await readRegistry(runtime().db);
  const team = registry.teams.find((t) => t.id === teamId);
  if (!team) throw new Error(`unknown team: ${teamId}`);
  return team.members.find((m) => m.lead)?.agentId ?? team.members[0]!.agentId;
}

export const schedules = new Hono()
  .get("/schedules", async (c) => c.json(await listSchedules(runtime().db)))
  .get("/schedules/occurrences", async (c) => {
    const from = new Date(c.req.query("from") ?? "");
    const to = new Date(c.req.query("to") ?? "");
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
      return c.json({ error: "from and to must be ISO dates with to after from" }, 400);
    }
    const { db } = runtime();
    const [all, fires] = await Promise.all([listSchedules(db), listFires(db, from, to)]);
    return c.json(overlayOccurrences(all, fires, from, to));
  })
  .post("/schedules", async (c) => {
    const parsed = ScheduleInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid schedule" }, 400);
    const input = parsed.data;
    if (input.kind === "team" && !input.teamId) return c.json({ error: "team jobs need a team" }, 400);
    const { db } = runtime();

    let agentId: string;
    try {
      agentId = await agentFor(input.kind, input.teamId);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "invalid team" }, 400);
    }
    const sessionId = `sched-${slugId(input.title)}-${Date.now().toString(36)}`;
    const schedule = await insertSchedule(db, {
      title: input.title,
      kind: input.kind,
      agentId,
      teamId: input.teamId,
      projectId: input.projectId,
      prompt: input.prompt,
      recurrence: input.recurrence,
      cron: toCron(input.recurrence),
      tz: input.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      durationMin: input.durationMin ?? 30,
      enabled: true,
      sessionId,
    });
    // The routine's own thread, so the sidebar shows it next to its first fire.
    if (await ensureSession(db, sessionId, schedule.title)) hub.publishApp({ type: "registry.changed" });
    hub.publishApp({ type: "schedule.changed" });
    return c.json(schedule, 201);
  })
  .patch("/schedules/:id", async (c) => {
    const parsed = SchedulePatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid patch" }, 400);
    const { db } = runtime();
    const existing = await getSchedule(db, c.req.param("id"));
    if (!existing) return c.json({ error: "schedule not found" }, 404);
    const patch = parsed.data as SchedulePatch;

    let agentId: string | undefined;
    const teamId = patch.teamId ?? existing.teamId;
    if (patch.kind || patch.teamId) {
      try {
        agentId = await agentFor(patch.kind ?? existing.kind, teamId);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : "invalid team" }, 400);
      }
    }
    const recurrence = patch.recurrence ?? existing.recurrence;
    const schedule = await updateSchedule(db, existing.id, { ...patch, agentId, cron: toCron(recurrence) });
    hub.publishApp({ type: "schedule.changed" });
    return schedule ? c.json(schedule) : c.json({ error: "schedule not found" }, 404);
  })
  .delete("/schedules/:id", async (c) => {
    const { db } = runtime();
    const gone = await deleteSchedule(db, c.req.param("id"));
    if (!gone) return c.json({ error: "schedule not found" }, 404);
    hub.publishApp({ type: "schedule.changed" });
    return c.json({ ok: true });
  })
  /** Fires now: a fire claimed at `now`, then the job runs in the background. */
  .post("/schedules/:id/run", async (c) => {
    const { db } = runtime();
    const schedule = await getSchedule(db, c.req.param("id"));
    if (!schedule) return c.json({ error: "schedule not found" }, 404);
    const fire = await claimFire(db, schedule.id, new Date());
    if (!fire) return c.json({ error: "this slot is already claimed" }, 409);
    void runScheduleFire(schedule, fire);
    return c.json(fire, 201);
  })
  /** Pre-claims one occurrence as skipped: the block stays, struck through. */
  .post("/schedules/:id/skip", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { at?: string };
    const at = new Date(body.at ?? "");
    if (Number.isNaN(at.getTime())) return c.json({ error: "at must be an ISO date" }, 400);
    const { db } = runtime();
    const schedule = await getSchedule(db, c.req.param("id"));
    if (!schedule) return c.json({ error: "schedule not found" }, 404);
    const fire = await claimFire(db, schedule.id, at, "skipped");
    if (!fire) return c.json({ error: "that occurrence is already claimed" }, 409);
    hub.publishApp({ type: "schedule.changed" });
    return c.json(fire, 201);
  });
