// SCH owns this file: the tick. Every 30 s, each enabled schedule's slots in (now − 10 min, now]
// fire — a late tick still catches up. Slots older than that, unclaimed from while the server was
// down, are claimed `missed` and never run late (a 7 AM digest at noon is noise); the sweep is
// bounded by the schedule's creation, not all of history. SCHEDULER=off disables it (tests).
import { claimFire, listSchedules } from "@fabric/db";
import { env } from "../env";
import { runtime } from "./runtime";
import { runScheduleFire } from "./schedule-fire";
import { cronSlots } from "./schedule-cron";

const TICK_MS = 30_000;
/** How long after its slot a routine may still fire. */
const CATCHUP_MS = 10 * 60_000;

export interface Scheduler {
  stop(): void;
}

export function startScheduler(): Scheduler | undefined {
  if (env.SCHEDULER === "off") {
    console.log("[scheduler] disabled (SCHEDULER=off)");
    return undefined;
  }
  if (!env.DATABASE_URL) {
    console.log("[scheduler] no DATABASE_URL: not starting");
    return undefined;
  }
  const tick = async () => {
    const now = new Date();
    try {
      const { db } = runtime();
      const enabled = (await listSchedules(db)).filter((s) => s.enabled);
      for (const schedule of enabled) {
        // Fresh slots fire; stale ones are marked missed. Both claims are idempotent.
        const fresh = cronSlots(schedule.cron, schedule.tz, new Date(now.getTime() - CATCHUP_MS), now);
        const stale = cronSlots(
          schedule.cron, schedule.tz,
          new Date(Math.max(new Date(schedule.createdAt).getTime(), 0)),
          new Date(now.getTime() - CATCHUP_MS),
        );
        for (const at of [...fresh, ...stale]) {
          const fire = await claimFire(db, schedule.id, at, fresh.includes(at) ? "fired" : "missed");
          if (!fire) continue;
          if (fire.status === "missed") {
            console.log(`[scheduler] missed ${schedule.id} @ ${at.toISOString()} (server was down)`);
            continue;
          }
          console.log(`[scheduler] firing ${schedule.id} @ ${at.toISOString()}`);
          void runScheduleFire(schedule, fire);
        }
      }
    } catch (err) {
      console.error("[scheduler] tick failed:", err instanceof Error ? err.message : err);
    }
  };
  void tick(); // catch up immediately at boot, not one tick in
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
  console.log(`[scheduler] on: ${TICK_MS / 1000}s tick, ${CATCHUP_MS / 60000}min catch-up`);
  return { stop: () => clearInterval(timer) };
}
