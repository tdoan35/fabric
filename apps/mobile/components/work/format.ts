// Formatting + small derivations shared by the Work rows and the Report screen.
// `reworkUsed` mirrors the web's `reworkOf` (apps/web/src/lib/work.ts): a bounce segment is one
// reviewer send-back, and `rework.requested` events are derived server-side into segments (RUN-7).
import type { Run } from "@fabric/contracts";

/** "$0.42" — costs are small; two decimals everywhere, tabular-nums on the caller. */
export const money = (usd: number) => `$${usd.toFixed(2)}`;

/** "9:05 AM" today, "Sep 29" otherwise — the web's `when()` without the mock clock. */
export function when(iso: string): string {
  const date = new Date(iso);
  const day = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" });
  const sameDay = day.format(date) === day.format(new Date());
  return sameDay
    ? new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(date)
    : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
}

/** Reviewer bounces used against the loop's rework budget. */
export const reworkUsed = (run: Run) => run.segments.filter((s) => s.kind === "bounce").length;

/** The wall-clock moment a running loop expects to finish, or undefined while unknown. */
export const etaAt = (run: Run): string | undefined =>
  run.status === "running" && run.etaS !== undefined
    ? new Date(new Date(run.startedAt).getTime() + run.etaS * 1000).toISOString()
    : undefined;

/** The task's latest loop: the last entry of runIds (oldest first), if it has a run at all. */
export const latestRunOf = (task: { runIds: string[] }, runsById: Map<string, Run>): Run | undefined => {
  for (let i = task.runIds.length - 1; i >= 0; i--) {
    const run = runsById.get(task.runIds[i]);
    if (run) return run;
  }
  return undefined;
};
