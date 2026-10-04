// TEAM's parallel steps call saveSnapshot / saveArtifact concurrently; ids derive from counts, so
// they must be stamped under the per-run advisory lock. DB-gated: skips without DATABASE_URL.
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createRunWriterWith, loadRootEnv } from "../index";
import type { Db } from "../index";
import type { ContextSnapshot } from "@fabric/contracts";

loadRootEnv(); // the suite is DB-gated; .env supplies DATABASE_URL
const maybeDb = process.env.DATABASE_URL ? createDb() : undefined;

describe.skipIf(!maybeDb)("RunWriter id stamping under concurrency", () => {
  const db = maybeDb!;
  const writer = createRunWriterWith(db);
  const taskId = `race-test-${process.pid}`;

  beforeAll(async () => {
    await db.db.execute(sql`
      insert into tasks (id, project_id, team_id, title) values (${taskId}, 'engram', 'research', 'race test')`);
  });

  afterAll(async () => {
    // Full cleanup so the lived-in parity suites never see this run.
    await db.db.execute(sql`delete from run_events where run_id like ${`run-${taskId}%`}`);
    await db.db.execute(sql`delete from context_snapshots where run_id like ${`run-${taskId}%`}`);
    await db.db.execute(sql`delete from artifacts where run_id like ${`run-${taskId}%`}`);
    await db.db.execute(sql`delete from runs where task_id = ${taskId}`);
    await db.db.execute(sql`delete from tasks where id = ${taskId}`);
    await db.close();
  });

  it("~10 concurrent saveSnapshot and saveArtifact calls get distinct, gap-free ids", async () => {
    const run = await writer.startRun(taskId, {
      tokens: 10, objective: "race test", constraints: [], criteria: [], preferences: [], stayed: [],
    }, { costUsd: 1, timeS: 60, rework: 2 });

    const snapshot = (i: number): Omit<ContextSnapshot, "id"> => ({
      runId: run.id, agentId: ["megan", "jonah", "sana"][i % 3], step: `Step ${i}`, assembledAtS: i,
      sections: [{ label: "Soul / identity", source: "SOUL.md", tokens: i }],
      totalTokens: i, tools: [], notLoaded: "", note: `snapshot ${i}`,
    });
    const results = await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => writer.saveSnapshot(snapshot(i))),
      ...Array.from({ length: 10 }, (_, i) => writer.saveArtifact(run.id, { name: `artifact-${i}.md`, by: "jonah", content: `file ${i}` })),
    ]);
    const snapshots = results.filter((r): r is ContextSnapshot => "sections" in r);
    const artifacts = results.filter((r): r is { id: string } => !("sections" in r));

    expect(new Set(snapshots.map((s) => s.id)).size).toBe(10);
    expect(new Set(artifacts.map((a) => a.id)).size).toBe(10);
    const snapNs = snapshots.map((s) => Number(s.id.split("-").pop())).sort((a, b) => a - b);
    expect(snapNs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const events = await db.db.execute(sql`select seq from run_events where run_id = ${run.id} order by seq`);
    expect(new Set((events.rows as { seq: number }[]).map((r) => r.seq)).size).toBe(events.rows.length);
  }, 20_000);
});
