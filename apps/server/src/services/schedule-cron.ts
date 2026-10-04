// SCH owns this file: the pure planning math behind both the occurrences endpoint and the
// scheduler tick — cron slots in a window, and the overlay that turns slots + fires into the
// calendar's blocks. No DB, no runtime: unit-tested directly (schedule.test.ts).
import { Cron } from "croner";
import type { Occurrence, OccurrenceState, RunStatus, Schedule, ScheduleFire } from "@fabric/contracts";

/** A fire with its run joined in (listFires shape; tests build them by hand). */
export type FireLike = ScheduleFire & { runStatus?: RunStatus; reportId?: string };

/** Slots of one cron in [from, to), in the cron's own timezone. Capped: a runaway pattern can't
 *  spin forever. */
export function cronSlots(cron: string, tz: string, from: Date, to: Date, cap = 1000): Date[] {
  const pattern = new Cron(cron, { timezone: tz });
  const out: Date[] = [];
  let cursor: Date | null = from;
  for (let i = 0; i < cap && cursor !== null; i++) {
    const next = pattern.nextRun(cursor);
    if (!next || next >= to) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

const slotKey = (scheduleId: string, at: string | Date | number) => `${scheduleId}@${new Date(at).getTime()}`;

/** A fired slot's state: skipped/missed/failed say themselves; a team fire follows its run
 *  (accepted carries the report); an assistant fire is posted once its message lands. */
function stateOf(fire: FireLike, schedule: Schedule): OccurrenceState {
  if (fire.status === "skipped") return "skipped";
  if (fire.status === "missed") return "missed";
  if (fire.status === "failed") return "failed";
  if (schedule.kind === "team") return fire.runStatus ?? "running";
  return fire.messageId ? "posted" : "running";
}

/**
 * The calendar's blocks for [from, to): every enabled schedule's slots, with fires overlaid — a
 * fire wins its slot, and a fire outside the pattern ("Run now") still shows. Future slots without
 * a fire are `upcoming`; past slots without one don't render (nothing ran there).
 */
export function overlayOccurrences(
  schedules: Schedule[],
  fires: FireLike[],
  from: Date,
  to: Date,
  now: Date = new Date(),
): Occurrence[] {
  const fired = new Map<string, FireLike>();
  for (const f of fires) fired.set(slotKey(f.scheduleId, f.scheduledFor), f);
  const out: Occurrence[] = [];
  for (const s of schedules) {
    if (!s.enabled) continue;
    const planned = cronSlots(s.cron, s.tz, from, to).map((d) => d.getTime());
    const plannedSet = new Set(planned);
    // Off-pattern fires in the window (Run now) show alongside the planned slots.
    const extra = fires
      .filter((f) => f.scheduleId === s.id)
      .map((f) => new Date(f.scheduledFor).getTime())
      .filter((t) => t >= from.getTime() && t < to.getTime() && !plannedSet.has(t));
    for (const t of [...planned, ...extra].sort((a, b) => a - b)) {
      const fire = fired.get(slotKey(s.id, t));
      if (!fire && t <= now.getTime()) continue; // past and nothing ran: no block
      const at = new Date(t);
      out.push({
        scheduleId: s.id,
        at: at.toISOString(),
        end: new Date(t + s.durationMin * 60_000).toISOString(),
        agentId: s.agentId,
        title: s.title,
        kind: s.kind,
        state: fire ? stateOf(fire, s) : "upcoming",
        runId: fire?.runId,
        taskId: fire?.taskId,
        reportId: fire?.reportId,
        sessionId: s.sessionId,
        messageId: fire?.messageId,
      });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
