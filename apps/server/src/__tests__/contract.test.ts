// Contract tests (§4.2): every DATA GET validates against the zod schemas in @fabric/contracts,
// and on a lived-in branch the payloads equal the fixture data the mock api returns.
// Runs only when DATABASE_URL points at a branch seeded `lived-in` (seed_state row); otherwise the
// suite skips — `npm run seed` (default lived-in) makes it run.
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { ContextSnapshotSchema, ProjectSchema, ReportSchema, RunEventSchema, RunSchema, TaskSchema } from "@fabric/contracts";
import type { ContextSnapshot, Project, Registry, Report, Run, RunEvent, Task, WeaveSnapshot } from "@fabric/contracts";
import { createDb } from "@fabric/db";
import { report as reportFixture, run as run135, runEvents as events135, snapshots as snapshots135 } from "@fabric/fixtures/run";
import { projects as projectsFixture, sessions as sessionsFixture } from "@fabric/fixtures/sessions";
import { runs as runsFixture, tasks as tasksFixture } from "@fabric/fixtures/work";
import { calendarEvents, inboxSeed, presenceSeed, pulseSeed } from "@fabric/fixtures/weave";
import { communityProfiles, myProfiles } from "@fabric/fixtures/studio";
import { communityTeams, organizations as orgsFixture, studioTeams } from "@fabric/fixtures/teams";
import { corsOrigins } from "../env";
import { registry } from "../routes/registry";
import { reports } from "../routes/reports";
import { runs } from "../routes/runs";
import { stream } from "../routes/stream";
import { weave } from "../routes/weave";
import { work } from "../routes/work";

const db = createDb();
// Detected before the describes register: skipIf needs it at collection time (vitest TLA).
const profile = await (async () => {
  try {
    const rows = await db.db.execute(sql`select profile from seed_state limit 1`);
    // Earlier failing runs may have left test projects behind; keep the id-rule test deterministic.
    await db.db.execute(sql`delete from projects where id like 'engram-on-small-models%'`);
    return (rows.rows[0] as { profile: string } | undefined)?.profile;
  } catch {
    return undefined;
  }
})();


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

  it("GET /api/artifacts/:id serves the file", async () => {
    const res = await app.request("/api/artifacts/art-run-ngram-1-1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown");
    expect(await res.text()).toContain("plan");
  });

  it("GET /api/registry and /api/weave return their shapes", async () => {
    const reg = await get<Registry>("/api/registry");
    expect(reg.agents.length).toBeGreaterThan(0);
    expect(reg.personaPool).toEqual([]);
    const wv = await get<WeaveSnapshot>("/api/weave");
    expect(Array.isArray(wv.items)).toBe(true);
  });
});

// Lived-in parity: the server returns exactly what the mock api does, except where a settled
// decision adds a field (status/data.md Deviations): D3 makes Dana's handoff_to_team allowed,
// D9 labels the report and recording `illustrative`, and a running loop's durationS is "now".
describe.skipIf(profile !== "lived-in")("lived-in matches the mock world", () => {
  it("projects equal the fixtures", async () => {
    expect(await get<Project[]>("/api/projects")).toEqual(projectsFixture);
  });

  it("tasks equal the fixtures", async () => {
    expect(await get<Task[]>("/api/tasks")).toEqual(tasksFixture);
  });

  it("runs equal the fixtures (run360's durationS is now-based; run135 carries its recording)", async () => {
    const server = await get<Run[]>("/api/runs");
    expect(server.map((r) => r.id)).toEqual(runsFixture.map((r) => r.id));
    const byStart = (a: { start: number; agentId: string }, b: { start: number; agentId: string }) =>
      a.start - b.start || a.agentId.localeCompare(b.agentId);
    for (const [i, fixture] of runsFixture.entries()) {
      const got = server[i];
      // The 360M fixture groups segments per agent; derived order is start order. Compare sorted.
      const sorted = (r: Run) => ({ ...r, segments: [...r.segments].sort(byStart) });
      if (got.id === "run-ngram360-1") {
        expect(got.durationS).toBeGreaterThanOrEqual(fixture.durationS);
        expect(sorted({ ...got, durationS: fixture.durationS })).toEqual(sorted(fixture));
      } else if (got.id === run135.id) {
        expect(sorted({ ...got, recording: undefined })).toEqual(sorted({ ...fixture, recording: undefined }));
        expect(got.recording).toEqual({ key: "ngram-135m", kind: "illustrative" });
      } else {
        expect(sorted(got)).toEqual(sorted(fixture));
      }
    }
  });

  it("the 135M event log equals the fixture log exactly", async () => {
    expect(await get<RunEvent[]>("/api/runs/run-ngram-1/events")).toEqual(events135);
  });

  it("the 135M snapshots equal the fixtures exactly (idHints)", async () => {
    expect(await get<ContextSnapshot[]>("/api/runs/run-ngram-1/snapshots")).toEqual(snapshots135);
  });

  it("the 135M report equals the fixture plus the D9 label and artifact links", async () => {
    const report = await get<Report>("/api/reports/report-ngram-1");
    expect(report.artifacts.every((a) => !!a.id)).toBe(true);
    expect({ ...report, artifacts: report.artifacts.map(({ name, from }) => ({ name, from })) }).toEqual({ ...reportFixture, kind: "illustrative" });
  });

  it("weave equals the fixtures", async () => {
    expect(await get<WeaveSnapshot>("/api/weave")).toEqual({
      items: inboxSeed,
      pulse: pulseSeed,
      presence: presenceSeed,
      calendar: calendarEvents,
    });
  });

  it("the registry equals the fixtures (Dana's handoff_to_team allowed per D3)", async () => {
    const reg = await get<Registry>("/api/registry");
    const handoffAllowed = (p: (typeof myProfiles)[number]) =>
      p.agent.id === "dana"
        ? { ...p, agent: { ...p.agent, tools: p.agent.tools.map((t) => (t.name === "handoff_to_team" ? { ...t, policy: "allowed" as const } : t)) } }
        : p;
    expect(reg.agents).toEqual(myProfiles.map(handoffAllowed));
    expect(reg.communityAgents).toEqual(communityProfiles);
    expect(reg.teams).toEqual(studioTeams);
    expect(reg.communityTeams).toEqual(communityTeams);
    expect(reg.organizations).toEqual(orgsFixture);
    expect(reg.sessions).toEqual(sessionsFixture);
  });
});

describe("POST /api/projects", () => {
  it("uses the mock's id rule (slug, then slug-(count+1)) and cleans up", async () => {
    const post = (body: string) =>
      app.request("/api/projects", { method: "POST", headers: { "content-type": "application/json", Origin: "app://fabric" }, body });
    const first = await post(JSON.stringify({ name: "Engram on small models", goal: "" }));
    expect(first.status).toBe(201);
    const p1 = (await first.json()) as Project;
    expect(p1.id).toBe("engram-on-small-models");
    const second = await post(JSON.stringify({ name: "Engram on small models", goal: "" }));
    const p2 = (await second.json()) as Project;
    // The mock reads projects.length at call time: 3 seeded + 1 just inserted → 4 + 1 = 5.
    expect(p2.id).toBe("engram-on-small-models-5");
    await db.db.execute(sql`delete from projects where id in (${p1.id}, ${p2.id})`);
  });
});
