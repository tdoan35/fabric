/**
 * Time helpers mirrored from apps/web/src/components/weave/format.ts, on the real clock: the
 * server serves live ISO stamps (no WEAVE_NOW mock clock on mobile), so "now" is the device.
 */

const timeFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const shortDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

export const fmtTime = (iso: string) => timeFmt.format(new Date(iso));

/** Compact age, Linear-style: "now", "12m", "3h", "Sep 29". */
export function age(iso: string, now: Date = new Date()) {
  const mins = Math.round((now.getTime() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  if (mins < 24 * 60) return `${Math.floor(mins / 60)}h`;
  return shortDate.format(new Date(iso));
}

/** Spelled-out age for detail headers: "just now", "12 min ago", "3 h ago", "Sep 29". */
export function ago(iso: string, now: Date = new Date()) {
  const a = age(iso, now);
  if (a === "now") return "just now";
  return /^\d+[mh]$/.test(a) ? `${a.slice(0, -1)} ${a.endsWith("m") ? "min" : "h"} ago` : a;
}

/** "12 min", "1 h 5 min": how long work has been waiting. */
export function waited(iso: string, now: Date = new Date()) {
  const mins = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
