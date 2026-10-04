// SCH unit tests: the recurrence helpers for every freq, croner expansion across the DST boundary,
// and the occurrences overlay (fires win; a skip replaces its upcoming slot; "Run now" shows
// off-pattern). Pure — no DB, no runtime.
import { describe, expect, it } from "vitest";
import { describeRecurrence, toCron } from "@fabric/contracts";
import type { Schedule } from "@fabric/contracts";
import { cronSlots, overlayOccurrences } from "../services/schedule-cron";
import type { FireLike } from "../services/schedule-cron";

describe("toCron", () => {
  it("maps every freq", () => {
    expect(toCron({ freq: "daily", time: "08:00" })).toBe("0 8 * * *");
    expect(toCron({ freq: "weekdays", time: "08:00" })).toBe("0 8 * * 1-5");
    expect(toCron({ freq: "weekly", time: "09:30", days: [1, 3, 5] })).toBe("30 9 * * 1,3,5");
    expect(toCron({ freq: "weekly", time: "09:00", days: [1] })).toBe("0 9 * * 1");
    expect(toCron({ freq: "monthly", time: "14:00", date: "2026-10-15" })).toBe("0 14 15 * *");
    expect(toCron({ freq: "once", time: "07:05", date: "2026-11-04" })).toBe("5 7 4 11 *");
  });
});

describe("describeRecurrence", () => {
  it("covers every freq", () => {
    expect(describeRecurrence({ freq: "daily", time: "08:00" })).toBe("Daily at 8:00 AM");
    expect(describeRecurrence({ freq: "weekdays", time: "08:00" })).toBe("Weekdays at 8:00 AM");
    expect(describeRecurrence({ freq: "weekly", time: "09:00", days: [1] })).toBe("Weekly on Mon at 9:00 AM");
    expect(describeRecurrence({ freq: "weekly", time: "09:00", days: [0, 2, 4] })).toBe("Weekly on Sun, Tue, Thu at 9:00 AM");
    expect(describeRecurrence({ freq: "monthly", time: "14:00", date: "2026-10-21" })).toBe("Monthly on the 21st at 2:00 PM");
    expect(describeRecurrence({ freq: "once", time: "00:15", date: "2026-11-04" })).toBe("Once on Nov 4 at 12:15 AM");
  });
});

describe("cronSlots across DST", () => {
  it("keeps 8:00 AM wall clock when Los Angeles falls back (Nov 1, 2026)", () => {
    const slots = cronSlots("0 8 * * *", "America/Los_Angeles", new Date("2026-10-30T00:00:00Z"), new Date("2026-11-04T00:00:00Z"));
    const days = slots.map((d) => d.toISOString());
    expect(days).toContain("2026-10-31T15:00:00.000Z"); // PDT (UTC-7)
    expect(days).toContain("2026-11-01T16:00:00.000Z"); // PST (UTC-8), still 8 AM local
    expect(days).toContain("2026-11-02T16:00:00.000Z");
    // Five mornings in the window (Oct 30 – Nov 3), no duplicates, no gaps across the boundary.
    expect(slots).toHaveLength(5);
  });

  it("expands a weekly cron in its own timezone", () => {
    const slots = cronSlots("0 9 * * 1", "America/Los_Angeles", new Date("2026-10-01T00:00:00Z"), new Date("2026-10-22T00:00:00Z"));
    expect(slots.map((d) => d.toISOString())).toEqual([
      "2026-10-05T16:00:00.000Z", "2026-10-12T16:00:00.000Z", "2026-10-19T16:00:00.000Z",
    ]);
  });
});

// The seeded digest, recomputed here so the test stays independent of the fixtures module.
const digest: Schedule = {
  id: "morning-digest", title: "Morning digest", kind: "assistant", agentId: "dana",
  prompt: "…", recurrence: { freq: "daily", time: "08:00" }, cron: "0 8 * * *",
  tz: "America/Los_Angeles", durationMin: 30, enabled: true, sessionId: "sched-morning-digest",
  createdAt: "2026-09-25T09:00:00-07:00",
};
const at = (day: string) => `2026-10-${day}T15:00:00.000Z`; // 8:00 AM in LA that week (PDT)
const fire = (scheduledFor: string, extra: Partial<FireLike> = {}): FireLike => ({
  id: `fire-${scheduledFor}`, scheduleId: digest.id, scheduledFor, status: "fired", ...extra,
});

describe("overlayOccurrences", () => {
  const from = new Date("2026-10-04T00:00:00Z");
  const to = new Date("2026-10-11T00:00:00Z");
  const now = new Date("2026-10-06T18:00:00.000Z"); // Tue, inside the window

  it("future slots are upcoming; past slots without a fire don't render", () => {
    const out = overlayOccurrences([digest], [], from, to, now);
    expect(out.map((o) => o.at)).toEqual([at("07"), at("08"), at("09"), at("10")]);
    expect(out.every((o) => o.state === "upcoming")).toBe(true);
    expect(out[0]).toMatchObject({ end: "2026-10-07T15:30:00.000Z", agentId: "dana", title: "Morning digest" });
  });

  it("a fire wins its slot: a posted digest replaces its upcoming block", () => {
    const out = overlayOccurrences([digest], [fire(at("07"), { status: "fired", messageId: "msg-404" })], from, to, now);
    expect(out.find((o) => o.at === at("07"))).toMatchObject({ state: "posted", messageId: "msg-404" });
  });

  it("a skip hides the upcoming occurrence and shows the slot struck through", () => {
    const out = overlayOccurrences([digest], [fire(at("08"), { status: "skipped" })], from, to, now);
    const skipped = out.filter((o) => o.at === at("08"));
    expect(skipped).toHaveLength(1); // the upcoming ghost is gone, not doubled
    expect(skipped[0]).toMatchObject({ state: "skipped" });
  });

  it("'Run now' adds an off-pattern fire that still shows", () => {
    const odd = "2026-10-06T17:42:00.000Z"; // 10:42 AM PDT, not on the 8:00 pattern
    const out = overlayOccurrences([digest], [fire(odd, { status: "fired", messageId: "msg-now" })], from, to, now);
    expect(out.find((o) => o.at === odd)).toMatchObject({ state: "posted" });
  });

  it("a team fire follows its run: accepted carries the report", () => {
    const sweep: Schedule = {
      ...digest, id: "sweep", kind: "team", agentId: "elliot", teamId: "research",
      recurrence: { freq: "weekly", time: "09:00", days: [1] }, cron: "0 9 * * 1", durationMin: 60,
    };
    const monday = "2026-10-05T16:00:00.000Z";
    const out = overlayOccurrences([sweep], [{
      ...fire(monday), scheduleId: sweep.id, runId: "run-x", taskId: "task-x", runStatus: "accepted", reportId: "report-x",
    }], from, to, now);
    expect(out.find((o) => o.at === monday)).toMatchObject({
      state: "accepted", runId: "run-x", taskId: "task-x", reportId: "report-x",
    });
  });

  it("paused schedules expand to nothing", () => {
    const paused = { ...digest, enabled: false };
    expect(overlayOccurrences([paused], [], from, to, now)).toEqual([]);
  });
});
