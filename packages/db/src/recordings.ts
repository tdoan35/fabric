// Recording bundles: import makes a run (recorded = true, no task unless attached), export turns a
// real run into a bundle for scripts/export-recording.ts (WORK-PLAN §5.3 DATA 6).
import { sql } from "drizzle-orm";
import { parseRunEventPayload } from "@fabric/contracts";
import type { RecordingBundle } from "@fabric/fixtures/recordings";
import type { Db } from "./db";
import { getRunRow, listSnapshots, listStoredEvents, readReport } from "./read";

export interface ImportedRecording {
  runId: string;
  reportId: string;
}

const TABLES = ["runs", "reports", "context_snapshots"] as const;

const freeId = async (db: Db, table: (typeof TABLES)[number], id: string): Promise<boolean> => {
  const res = await db.db.execute(sql`select 1 from ${sql.identifier(table)} where id = ${id} limit 1`);
  return res.rows.length === 0;
};

/** Idempotent: a bundle maps to one recorded run per branch; re-import returns the existing ids. */
export async function importRecording(db: Db, bundle: RecordingBundle, opts: { taskId?: string } = {}): Promise<ImportedRecording> {
  const existing = await db.db.execute(sql`select id, report_id from runs where recorded and recording_key = ${bundle.key} limit 1`);
  const prior = existing.rows[0] as { id: string; report_id: string | null } | undefined;
  if (prior) return { runId: prior.id, reportId: prior.report_id ?? "" };

  const runId = (await freeId(db, "runs", bundle.run.idHint)) ? bundle.run.idHint : `rec-${bundle.key}`;
  const reportId = (await freeId(db, "reports", bundle.report.idHint)) ? bundle.report.idHint : `report-${runId}`;
  const n = opts.taskId
    ? Number(((await db.db.execute(sql`select coalesce(max(n), 0) + 1 as n from runs where task_id = ${opts.taskId}`)).rows[0] as { n: string }).n)
    : 1;
  const endedAt = new Date(new Date(bundle.run.startedAt).getTime() + bundle.run.durationS * 1000);

  await db.db.execute(sql`
    insert into runs (id, task_id, team_id, n, objective, status, brief, budget, rework_budget, assistant_tokens,
                      outcome, report_id, cost_usd, duration_s, recorded, recording_key, recording_kind,
                      started_at, started_at_text, ended_at)
    values (${runId}, ${opts.taskId ?? null}, 'research', ${n}, ${bundle.run.objective}, ${bundle.run.status},
            ${JSON.stringify(bundle.run.brief)}::jsonb, ${JSON.stringify(bundle.run.budget)}::jsonb, ${bundle.run.reworkBudget},
            ${bundle.run.assistantTokens}, ${bundle.run.outcome ?? null}, ${reportId}, ${bundle.run.costUsd},
            ${bundle.run.durationS}, true, ${bundle.key}, ${bundle.kind}, ${bundle.run.startedAt}, ${bundle.run.startedAt}, ${endedAt.toISOString()})`);

  const usedSeqs = new Set<number>();
  for (const [i, e] of bundle.events.entries()) {
    const seq = !usedSeqs.has(e.seqHint) ? (usedSeqs.add(e.seqHint), e.seqHint) : i + 1;
    const payload = parseRunEventPayload(e.type, e.payload) as Record<string, unknown>;
    await db.db.execute(sql`
      insert into run_events (run_id, seq, t, type, actor_agent_id, payload)
      values (${runId}, ${seq}, ${e.t}, ${e.type}, ${e.actorAgentId ?? null}, ${JSON.stringify(payload)}::jsonb)`);
  }
  let ord = 0;
  for (const s of bundle.snapshots) {
    ord += 1;
    const id = (await freeId(db, "context_snapshots", s.idHint)) ? s.idHint : `snap-${runId}-${ord}`;
    await db.db.execute(sql`
      insert into context_snapshots (id, ord, run_id, agent_id, step, assembled_at_s, sections, total_tokens, tools, last_denied, not_loaded, note, sandbox)
      values (${id}, ${ord}, ${runId}, ${s.agentId}, ${s.step}, ${s.assembledAtS}, ${JSON.stringify(s.sections)}::jsonb,
              ${s.totalTokens}, ${JSON.stringify(s.tools)}::jsonb, ${s.lastDenied ?? null}, ${s.notLoaded}, ${s.note}, ${s.sandbox ?? null})`);
  }
  let aord = 0;
  const artifactIds = new Map<string, string>();
  for (const a of bundle.artifacts) {
    aord += 1;
    const artifactId = `art-${runId}-${aord}`;
    artifactIds.set(a.name, artifactId);
    await db.db.execute(sql`
      insert into artifacts (id, run_id, name, by, ord, content_type, content)
      values (${artifactId}, ${runId}, ${a.name}, ${a.by}, ${aord}, ${a.contentType}, ${a.content})`);
  }
  const { idHint: _idHint, ...reportBody } = bundle.report;
  // The stored report carries the artifact ids, so /api/reports serves links straight from data.
  const reportArtifacts = reportBody.artifacts.map((a) => {
    const id = artifactIds.get(a.name);
    return id ? { ...a, id } : a;
  });
  await db.db.execute(sql`
    insert into reports (id, run_id, title, intro, summary, results, caveats, provenance, made_by, artifacts, emailed, setup, kind)
    values (${reportId}, ${runId}, ${reportBody.title}, ${reportBody.intro}, ${reportBody.summary}, ${JSON.stringify(reportBody.results)}::jsonb,
            ${JSON.stringify(reportBody.caveats)}::jsonb, ${JSON.stringify(reportBody.provenance)}::jsonb, ${JSON.stringify(reportBody.madeBy)}::jsonb,
            ${JSON.stringify(reportArtifacts)}::jsonb, ${reportBody.emailed}, ${reportBody.setup ? JSON.stringify(reportBody.setup) : null}::jsonb, ${reportBody.kind ?? null})`);
  return { runId, reportId };
}

/** Exports a stored run (a real recording) as a bundle. Throws on unknown runs. */
export async function exportRecording(db: Db, runId: string, meta: { key: string; kind: "real" | "illustrative" }): Promise<RecordingBundle> {
  const run = await getRunRow(db, runId);
  if (!run) throw new Error(`run ${runId} not found`);
  const [events, snapshots, reportRow, artifactRows] = await Promise.all([
    listStoredEvents(db, runId),
    listSnapshots(db, runId),
    readReport(db, run.report_id ?? ""),
    db.db.execute(sql`select * from artifacts where run_id = ${runId} order by ord`),
  ]);
  if (!reportRow) throw new Error(`run ${runId} has no report to export`);
  const artifacts = (artifactRows.rows as unknown as { name: string; by: string; content_type: string; content: string }[]).map((a) => ({
    name: a.name, by: a.by, contentType: a.content_type, content: a.content,
  }));
  const { id: _rid, runId: _rr, ...report } = reportRow;
  return {
    key: meta.key,
    kind: meta.kind,
    exportedAt: new Date().toISOString(),
    run: {
      idHint: run.id, objective: run.objective, status: run.status as RecordingBundle["run"]["status"],
      startedAt: new Date(run.started_at).toISOString(), durationS: Number(run.duration_s ?? 0),
      costUsd: Number(run.cost_usd), budget: run.budget, reworkBudget: run.rework_budget,
      assistantTokens: run.assistant_tokens, brief: run.brief, outcome: run.outcome ?? undefined,
    },
    events: events.map(({ runId: _r, seq, ...e }) => ({ ...e, seqHint: seq })),
    snapshots: snapshots.map(({ id, runId: _rr2, ...s }) => ({ ...s, idHint: id })),
    artifacts,
    report: { ...report, idHint: reportRow.id },
  };
}
