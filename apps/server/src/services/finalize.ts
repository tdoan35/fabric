// DATA owns this file. Runs after a real finish (RunWriter.end) or a spliced one (/finalize-splice);
// idempotent (the finalized_at claim serializes concurrent calls). It sets the final status from the
// last verdict, attaches the report (copied from the recording when spliced, synthesized after a
// real finish), emits run.finished, adds the Weave result item, then calls assistant.postResultsMessage
// (DANA) and — only when FEATURE_AGENTMAIL=on — sendReportEmail (TOOLS). Stub calls log one line and
// carry on, so both paths work today (WORK-PLAN §5.3 DATA 8).
import { NotImplementedError } from "@fabric/contracts";
import type { Report, ResultItem, RunEvent } from "@fabric/contracts";
import { sendReportEmail } from "@fabric/integrations";
import { emitAt, getRunRow, listProjects, mergedEvents, readReport, readTask } from "@fabric/db";
import type { Db, RunRowLike } from "@fabric/db";
import { sql } from "drizzle-orm";
import { env } from "../env";
import { hub } from "./hub";
import { runtime } from "./runtime";

/** A stop or a block isn't a finish: nothing to attach, nothing to announce. */
const FINISHED_STATUSES = new Set(["accepted", "running"]); // running = finalize-splice on a live loop

async function lastVerdict(events: RunEvent[]): Promise<"accept" | "request_changes" | undefined> {
  for (const e of events.reverse()) {
    if (e.type === "review.verdict") return (e.payload as { verdict: "accept" | "request_changes" }).verdict;
  }
  return undefined;
}

async function insertReport(db: Db, report: Report): Promise<void> {
  await db.db.execute(sql`
    insert into reports (id, run_id, title, intro, summary, results, caveats, provenance, made_by, artifacts, emailed, setup, kind)
    values (${report.id}, ${report.runId}, ${report.title}, ${report.intro}, ${report.summary}, ${JSON.stringify(report.results)}::jsonb,
            ${JSON.stringify(report.caveats)}::jsonb, ${JSON.stringify(report.provenance)}::jsonb, ${JSON.stringify(report.madeBy)}::jsonb,
            ${JSON.stringify(report.artifacts)}::jsonb, ${report.emailed}, ${report.setup ? JSON.stringify(report.setup) : null}::jsonb, ${report.kind ?? null})`);
}

async function synthesizeReport(run: RunRowLike, events: RunEvent[], outcome: string): Promise<Report> {
  const actors = [...new Set(events.map((e) => e.actorAgentId).filter((a): a is string => !!a))];
  const artifacts = events
    .filter((e) => e.type === "artifact.created")
    .map((e) => ({ name: (e.payload as { name: string }).name, from: e.actorAgentId ?? "team" }));
  const verdict = await lastVerdict([...events]);
  return {
    id: `report-${run.id}`,
    runId: run.id,
    title: run.objective,
    intro: "The team produced this report. Findings separate what was measured from what is speculation.",
    summary: outcome,
    results: [],
    caveats: [],
    provenance: [
      { label: "Loop", value: `Loop ${run.n}` },
      { label: "Reviewer verdict", value: verdict === "request_changes" ? "Request changes" : "Accepted" },
      { label: "Dana's context", value: `${(run.assistant_tokens / 1000).toFixed(1)}k tokens` },
    ],
    madeBy: actors,
    artifacts,
    emailed: false,
    kind: "real",
  };
}

export async function finalizeRun(runId: string): Promise<{ reportId: string } | null> {
  const { db } = runtime();
  const run = await getRunRow(db, runId);
  if (!run || run.finalized_at) return run?.report_id ? { reportId: run.report_id } : null;

  const events = await mergedEvents(db, run);
  const status =
    run.status !== "running" ? run.status
    : (await lastVerdict([...events])) === "request_changes" ? "blocked"
    : "accepted";

  if (!FINISHED_STATUSES.has(status)) {
    // stopped / blocked: claim finality so a later retry doesn't resurrect the run.
    await db.db.execute(sql`update runs set finalized_at = now() where id = ${runId} and finalized_at is null`);
    return null;
  }

  const claimed = await db.db.execute(sql`update runs set finalized_at = now() where id = ${runId} and finalized_at is null returning id`);
  if (claimed.rows.length !== 1) return run.report_id ? { reportId: run.report_id } : null;

  // ---- report: copied from the recording when spliced, synthesized after a real finish ----
  let reportId = run.report_id;
  if (!reportId) {
    if (run.spliced_from_run_id) {
      const rec = await getRunRow(db, run.spliced_from_run_id);
      const source = rec?.report_id ? await readReport(db, rec.report_id) : undefined;
      if (source) {
        reportId = `report-${runId}`;
        await insertReport(db, { ...source, id: reportId, runId, emailed: false });
      }
    }
    if (!reportId) {
      const verdictText = [...events].reverse().find((e) => e.type === "review.verdict")?.payload as { text?: string } | undefined;
      const outcome = run.outcome ?? verdictText?.text ?? "Finished.";
      const report = await synthesizeReport(run, events, outcome);
      reportId = report.id;
      await insertReport(db, report);
    }
  }

  const outcome = run.outcome ?? "Accepted.";
  const endedAt = run.ended_at ?? new Date();
  const durationS = run.duration_s != null ? Number(run.duration_s) : (endedAt.getTime() - new Date(run.started_at).getTime()) / 1000;
  await db.db.execute(sql`
    update runs set status = ${status}, ended_at = ${endedAt.toISOString()}, duration_s = ${durationS},
                     report_id = ${reportId}, outcome = ${outcome}
    where id = ${runId}`);

  // run.finished lands at the merged timeline's end, after the re-stamped recording events.
  await emitAt(db, runId, "run.finished", undefined, { reportId }, durationS, { onEvent: (e) => hub.publishRun(e) });

  // ---- the Weave result item ----
  const task = run.task_id ? await readTask(db, run.task_id) : undefined;
  const project = task ? (await listProjects(db)).find((p) => p.id === task.projectId) : undefined;
  const report = await readReport(db, reportId);
  const itemId = `result-${reportId}`;
  if (task && report) {
    const item: ResultItem = {
      id: itemId, kind: "result", agentId: "dana",
      project: project?.name ?? "Fabric",
      taskId: task.id,
      run: { label: task.title, href: `/work/${task.id}` },
      title: `Results are ready: ${report.title}`,
      brief: "the report",
      at: endedAt.toISOString(),
      unread: true,
      reportId,
      why: "You asked to hear when the run finished. The reviewer accepted it after one rework.",
      actions: [
        { id: "open", label: "Open report", variant: "primary", href: `/reports/${reportId}` },
        { id: "run", label: "View loop", variant: "outline", href: `/work/${task.id}` },
      ],
    };
    const ord = await db.db.execute(sql`select coalesce(max(ord), 0) + 1 as ord from weave_items`);
    await db.db.execute(sql`
      insert into weave_items (id, ord, kind, agent_id, task_id, at, data)
      values (${itemId}, ${(ord.rows[0] as { ord: string }).ord}, 'result', 'dana', ${task.id}, ${endedAt.toISOString()}, ${JSON.stringify(item)}::jsonb)`);
  }

  // ---- Dana's results message (CHAT-14); the DANA stub logs one line and we still announce ----
  const sessionId = task?.sessionId;
  if (sessionId && report) {
    const assistant = runtime().assistant();
    if (assistant) {
      try {
        await assistant.postResultsMessage(sessionId, {
          reportId, runId, taskId: task!.id, title: report.title, summary: report.summary, rows: report.results,
        });
      } catch (err) {
        console.log(`[finalize] postResultsMessage unavailable: ${err instanceof NotImplementedError ? err.message : String(err)}`);
      }
    } else {
      console.log("[finalize] DANA not implemented yet; skipping postResultsMessage");
    }
    hub.publishApp({ type: "session.message", sessionId, messageId: `results-${reportId}` });
  }

  // ---- the report email (P1-1): only when AgentMail is explicitly on ----
  if (env.FEATURE_AGENTMAIL === "on" && env.OWNER_EMAIL && report) {
    try {
      await sendReportEmail(report, env.OWNER_EMAIL);
      await db.db.execute(sql`update reports set emailed = true where id = ${reportId}`);
    } catch (err) {
      console.log(`[finalize] sendReportEmail failed, report stays in chat: ${err instanceof NotImplementedError ? err.message : String(err)}`);
    }
  }

  hub.publishApp({ type: "run.changed", runId });
  if (task) hub.publishApp({ type: "task.changed", taskId: task.id });
  hub.publishApp({ type: "weave.changed" });
  return { reportId };
}
