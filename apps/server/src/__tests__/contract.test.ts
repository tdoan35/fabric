// Live API contracts and project-identity boundaries. A running database is
// mutable: never compare its rows to a pristine fixture world or delete
// unrelated rows to make an assertion deterministic.
import { randomUUID } from "node:crypto";
import { createDb, sql } from "@fabric/db";
import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { AppEventSchema, ContextSnapshotSchema, ProjectSchema, ReportSchema, RunEventSchema, RunSchema, TaskSchema } from "@fabric/contracts";
import {
  OccurrenceSchema, ScheduleFireSchema, ScheduleInputSchema, SchedulePatchSchema, ScheduleSchema,
} from "@fabric/contracts";
import type { ContextSnapshot, Project, Registry, Report, Run, RunEvent, Schedule, Task, WeaveSnapshot } from "@fabric/contracts";
import { cors } from "hono/cors";
import { corsOrigins } from "../env";
import { registry } from "../routes/registry";
import { reports } from "../routes/reports";
import { runs } from "../routes/runs";
import { stream } from "../routes/stream";
import { weave } from "../routes/weave";
import { work } from "../routes/work";

const db = createDb();
afterAll(async () => {
  await db.close();
});

const app = new Hono()
  .use("/api/*", cors({ origin: (origin) => (corsOrigins.includes(origin) ? origin : null) }))
  .route("/api", new Hono()
    .get("/health", (c) => c.json({ ok: true }))
    .route("/", registry).route("/", work).route("/", runs).route("/", reports).route("/", weave).route("/", stream));

const get = async <T>(path: string): Promise<T> => {
  const res = await app.request(path, { headers: { Origin: "app://fabric" } });
  expect(res.status, `GET ${path}`).toBe(200);
  expect(res.headers.get("access-control-allow-origin")).toBe("app://fabric");
  return (await res.json()) as T;
};

describe("contract: every DATA GET validates", () => {
  it("GET /api/health", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("GET /api/projects returns Project[]", async () => {
    for (const p of await get<Project[]>("/api/projects")) expect(ProjectSchema.parse(p)).toBeTruthy();
  });

  it("GET /api/tasks returns Task[]", async () => {
    for (const t of await get<Task[]>("/api/tasks")) expect(TaskSchema.parse(t)).toBeTruthy();
  });

  it("GET /api/runs returns Run[] with derived segments", async () => {
    for (const r of await get<Run[]>("/api/runs")) expect(RunSchema.parse(r)).toBeTruthy();
  });

  it("GET /api/runs/:id/events returns RunEvent[]", async () => {
    for (const e of await get<RunEvent[]>("/api/runs/run-ngram-1/events")) expect(RunEventSchema.parse(e)).toBeTruthy();
  });

  it("GET /api/runs/:id/snapshots returns ContextSnapshot[]", async () => {
    for (const s of await get<ContextSnapshot[]>("/api/runs/run-ngram-1/snapshots")) {
      expect(ContextSnapshotSchema.parse(s)).toBeTruthy();
    }
  });

  it("GET /api/reports/:id returns Report", async () => {
    expect(ReportSchema.parse(await get<Report>("/api/reports/report-ngram-1"))).toBeTruthy();
  });

  it("rejects a non-image artifact at the screenshot endpoint", async () => {
    const res = await app.request("/api/artifacts/art-run-ngram-1-1/screenshot");
    expect(res.status).toBe(415);
  });

});

// Schedule (SCH, additive under contracts-v1): the new schemas and the event member. Pure — no DB.
describe("contract: schedule schemas", () => {
  const recurrence = { freq: "weekdays" as const, time: "08:00" };
  const schedule: Schedule = {
    id: "morning-digest", title: "Morning digest", kind: "assistant", agentId: "dana",
    prompt: "Summarize what changed since yesterday.", recurrence, cron: "0 8 * * 1-5",
    tz: "America/Los_Angeles", durationMin: 30, enabled: true, sessionId: "sched-morning-digest",
    createdAt: "2026-10-02T11:20:00-07:00",
  };

  it("ScheduleSchema, ScheduleFireSchema and OccurrenceSchema parse their shapes", () => {
    expect(ScheduleSchema.parse(schedule)).toBeTruthy();
    expect(ScheduleFireSchema.parse({
      id: "fire-1", scheduleId: schedule.id, scheduledFor: "2026-10-05T08:00:00-07:00",
      firedAt: "2026-10-05T08:00:03-07:00", status: "fired", messageId: "msg-9",
    })).toBeTruthy();
    expect(OccurrenceSchema.parse({
      scheduleId: schedule.id, at: "2026-10-05T08:00:00-07:00", end: "2026-10-05T08:30:00-07:00",
      agentId: "dana", title: schedule.title, kind: "assistant", state: "posted",
      sessionId: schedule.sessionId, messageId: "msg-9",
    })).toBeTruthy();
  });

  it("ScheduleInputSchema validates create; SchedulePatchSchema takes any subset", () => {
    expect(ScheduleInputSchema.parse({
      title: "Weekly literature sweep", kind: "team", teamId: "research",
      prompt: "Sweep the literature.", recurrence: { freq: "weekly", time: "09:00", days: [1] },
    })).toBeTruthy();
    expect(() => ScheduleInputSchema.parse({ title: "x", kind: "team", prompt: "", recurrence })).toThrow();
    expect(SchedulePatchSchema.parse({ enabled: false })).toBeTruthy();
    expect(SchedulePatchSchema.parse({ durationMin: 60 })).toBeTruthy();
  });

  it("AppEventSchema parses schedule.changed", () => {
    expect(AppEventSchema.parse({ type: "schedule.changed" })).toEqual({ type: "schedule.changed" });
  });
});

describe("POST /api/projects", () => {
  it("keeps project identities distinct when display names collide", async () => {
    const name = `contract-collision-${randomUUID()}`;
    const post = () => app.request("/api/projects", {
      method: "POST", headers: { "content-type": "application/json", Origin: "app://fabric" },
      body: JSON.stringify({ name, goal: "Isolated identity collision check" }),
    });
    try {
      const first = await post();
      expect(first.status).toBe(201);
      const p1 = ProjectSchema.parse(await first.json());
      const second = await post();
      expect(second.status).toBe(201);
      const p2 = ProjectSchema.parse(await second.json());
      expect(p2.id).not.toBe(p1.id);
    } finally {
      await db.db.execute(sql`delete from projects where name = ${name}`);
    }
  });
});
