// Live API contracts and project-identity boundaries. A running database is
// mutable: never compare its rows to a pristine fixture world or delete
// unrelated rows to make an assertion deterministic.
import { randomUUID } from "node:crypto";
import { createDb, loadRootEnv, sql } from "@fabric/db";
import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { AppEventSchema, ContextSnapshotSchema, ProjectSchema, ReportSchema, RunEventSchema, RunSchema, TaskSchema } from "@fabric/contracts";
import {
  OccurrenceSchema, ScheduleFireSchema, ScheduleInputSchema, SchedulePatchSchema, ScheduleSchema,
} from "@fabric/contracts";
import type { ContextSnapshot, Project, Registry, Report, Run, RunEvent, Schedule, Task, WeaveSnapshot } from "@fabric/contracts";
import { cors } from "hono/cors";
import { corsOrigins } from "../env";
import { chat } from "../routes/chat";
import { registry } from "../routes/registry";
import { reports } from "../routes/reports";
import { runs } from "../routes/runs";
import { stream } from "../routes/stream";
import { weave } from "../routes/weave";
import { work } from "../routes/work";

// Hermetic skip (same pattern as packages/agents memory.test.ts): this suite
// exercises live-DB contracts against DATABASE_URL. With no DATABASE_URL —
// e.g. unit CI, which must never touch the real Neon DB — everything skips.
loadRootEnv();
const hasDb = !!process.env.DATABASE_URL;
const db = hasDb ? createDb() : (undefined as unknown as ReturnType<typeof createDb>);
const suite = hasDb ? describe : describe.skip;
afterAll(async () => {
  if (hasDb) await db.close();
});

const app = new Hono()
  .use("/api/*", cors({ origin: (origin) => (corsOrigins.includes(origin) ? origin : null) }))
  .route("/api", new Hono()
    .get("/health", (c) => c.json({ ok: true }))
    .route("/", registry).route("/", work).route("/", runs).route("/", reports).route("/", weave).route("/", stream).route("/", chat));

const get = async <T>(path: string): Promise<T> => {
  const res = await app.request(path, { headers: { Origin: "app://fabric" } });
  expect(res.status, `GET ${path}`).toBe(200);
  expect(res.headers.get("access-control-allow-origin")).toBe("app://fabric");
  return (await res.json()) as T;
};

suite("contract: every DATA GET validates", () => {
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

// S14 (ANY-64): the one-response chat turn is retired; the legacy history reads stay
// so S12/S13 can render old threads read-only. The POST assertions are pure routing
// (no database); the GET assertions run against the live schema below.
describe("retired chat path (S14)", () => {
  const postChat = () =>
    app.request("/api/chat", {
      method: "POST", headers: { "content-type": "application/json", Origin: "app://fabric" },
      body: JSON.stringify({ sessionId: "c1", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
    });

  it("POST /api/chat is gone (404, not a method mismatch on a living route)", async () => {
    const res = await postChat();
    expect(res.status).toBe(404);
  });
});

// The legacy history reads, against the live schema: S12/S13 render old threads read-only.
suite("retired chat path: the legacy history reads survive", () => {
  it("GET /api/chat/sessions/:id and /messages answer 200 for an existing legacy session", async () => {
    const rows = (await db.db.execute(sql`select id from sessions order by ord limit 1`)).rows as { id: string }[];
    if (rows.length === 0) return; // nothing legacy on this database: nothing to assert
    const id = rows[0]!.id;
    for (const path of [`/api/chat/sessions/${id}`, `/api/chat/sessions/${id}/messages`]) {
      const res = await app.request(path, { headers: { Origin: "app://fabric" } });
      expect(res.status, `GET ${path}`).toBe(200);
    }
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

suite("POST /api/projects", () => {
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
