// RunWriter (WORK-PLAN §4.6): the only way anything writes to a run.
// Stamps `seq` (atomic per run: advisory lock + max(seq)+1, safe under TEAM's parallel steps) and
// `t` (seconds since runs.started_at). Cost accumulates from budget.update events.
import { sql } from "drizzle-orm";
import { parseRunEventPayload } from "@fabric/contracts";
import type { ContextSnapshot, RecordingKind, Run, RunEvent, RunEventPayloads, RunEventType, Task } from "@fabric/contracts";
import type { Db } from "./db";
import { deriveSegments } from "./derive";
import type { RunWriter, RunWriterHooks } from "./index";
import type { RunRowLike } from "./read";
import { RunClosedError } from "./errors";

export function slugId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
}

async function emitRow(
  db: Db,
  hooks: RunWriterHooks,
  runId: string,
  type: RunEventType,
  actorAgentId: string | undefined,
  payload: Record<string, unknown>,
  tOverride?: number,
  allowClosed = false,
): Promise<RunEvent> {
  const parsed = parseRunEventPayload(type, payload) as Record<string, unknown>;
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.db.transaction(async (tx) => {
        // Serialize concurrent emits for the same run (TEAM's parallel steps).
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${runId}, 0))`);
        const state = await tx.execute(sql`
          select (spliced_from_run_id is not null) as spliced, (finalized_at is not null) as finalized,
                 round(extract(epoch from (now() - started_at))::numeric, 2) as t
          from runs where id = ${runId}`);
        const s = state.rows[0] as { spliced: boolean; finalized: boolean; t: string | null } | undefined;
        if (!s || s.t == null) throw new Error(`run ${runId} not found`);
        if (!allowClosed && (s.spliced || s.finalized)) throw new RunClosedError(runId, s.spliced ? "spliced" : "finalized");
        const next = await tx.execute(sql`select coalesce(max(seq), 0) + 1 as seq from run_events where run_id = ${runId}`);
        const seq = Number((next.rows[0] as { seq: string | number }).seq);
        const t = tOverride ?? Number(s.t);
        await tx.execute(sql`
          insert into run_events (run_id, seq, t, type, actor_agent_id, payload)
          values (${runId}, ${seq}, ${t}, ${type}, ${actorAgentId ?? null}, ${JSON.stringify(parsed)}::jsonb)`);
        if (type === "budget.update" && typeof payload.costUsd === "number") {
          await tx.execute(sql`update runs set cost_usd = greatest(cost_usd, ${payload.costUsd}) where id = ${runId}`);
        }
        const event: RunEvent = { runId, seq, t, type, actorAgentId, payload: parsed };
        hooks.onEvent?.(event);
        return event;
      });
    } catch (err) {
      if (err instanceof RunClosedError) throw err;
      const notFound = err instanceof Error && /not found/i.test(err.message);
      if (attempt >= 5 || notFound) throw err;
      // Executor form, not Promise.withResolvers: consumers type-check this source under ES2023 libs.
      await new Promise<void>((resolve) => setTimeout(resolve, 25 * attempt));
    }
  }
}

export function createRunWriterWith(db: Db, hooks: RunWriterHooks = {}): RunWriter {
  return {
    async createTask(i) {
      // Ids derive from counts: stamp under the tasks advisory lock so parallel creates can't collide.
      return db.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('tasks', 0))`);
        const base = slugId(i.title);
        const counts = await tx.execute(sql`
          select count(*) filter (where id = ${base}) as taken, count(*) as total from tasks`);
        const { taken, total } = counts.rows[0] as { taken: string; total: string };
        const id = Number(taken) > 0 ? `${base}-${Number(total) + 1}` : base;
        await tx.execute(sql`
          insert into tasks (id, project_id, team_id, title, recording_key, session_id)
          values (${id}, ${i.projectId}, ${i.teamId}, ${i.title}, ${i.recordingKey ?? null}, ${i.sessionId ?? null})`);
        const task: Task = { id, projectId: i.projectId, teamId: i.teamId, title: i.title, runIds: [], recordingKey: i.recordingKey, sessionId: i.sessionId };
        return task;
      });
    },

    async startRun(taskId, brief, budget) {
      const runId = await db.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`task:${taskId}`}, 0))`);
        const taskRow = await tx.execute(sql`select team_id from tasks where id = ${taskId}`);
        const teamId = (taskRow.rows[0] as { team_id: string } | undefined)?.team_id;
        if (!teamId) throw new Error(`task ${taskId} not found`);
        const next = await tx.execute(sql`select coalesce(max(n), 0) + 1 as n from runs where task_id = ${taskId}`);
        const n = Number((next.rows[0] as { n: string | number }).n);
        const id = `run-${taskId}-${n}`;
        await tx.execute(sql`
          insert into runs (id, task_id, team_id, n, objective, status, brief, budget, rework_budget, assistant_tokens, started_at)
          values (${id}, ${taskId}, ${teamId}, ${n}, ${brief.objective}, 'running', ${JSON.stringify(brief)}::jsonb,
                  ${JSON.stringify(budget)}::jsonb, ${budget.rework}, ${brief.tokens}, now())`);
        return id;
      });
      await emitRow(db, hooks, runId, "run.started", undefined, { objective: brief.objective });
      const run = await db.db.execute(sql`select * from runs where id = ${runId}`);
      return rowToRun(run.rows[0] as unknown as RunRowLike, [], Date.now());
    },

    emit: (runId, type, actor, payload) =>
      emitRow(db, hooks, runId, type, actor, payload as Record<string, unknown>),

    async saveSnapshot(s) {
      // Same per-run lock as emitRow: parallel steps (TEAM) must not derive the same snapshot id/ord.
      const id = await db.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${s.runId}, 0))`);
        const state = await tx.execute(sql`select (spliced_from_run_id is not null) as spliced, (finalized_at is not null) as finalized from runs where id = ${s.runId}`);
        const st = state.rows[0] as { spliced: boolean; finalized: boolean } | undefined;
        if (!st) throw new Error(`run ${s.runId} not found`);
        if (st.spliced || st.finalized) throw new RunClosedError(s.runId, st.spliced ? "spliced" : "finalized");
        const count = await tx.execute(sql`select count(*) as n from context_snapshots where run_id = ${s.runId}`);
        const n = Number((count.rows[0] as { n: string }).n) + 1;
        const snapshotId = `snap-${s.runId}-${n}`;
        await tx.execute(sql`
          insert into context_snapshots (id, ord, run_id, agent_id, step, assembled_at_s, sections, total_tokens, tools, last_denied, not_loaded, note, sandbox)
          values (${snapshotId}, ${n}, ${s.runId}, ${s.agentId}, ${s.step}, ${s.assembledAtS}, ${JSON.stringify(s.sections)}::jsonb,
                  ${s.totalTokens}, ${JSON.stringify(s.tools)}::jsonb, ${s.lastDenied ?? null}, ${s.notLoaded}, ${s.note}, ${s.sandbox ?? null})`);
        return snapshotId;
      });
      const snapshot: ContextSnapshot = { ...s, id };
      await emitRow(db, hooks, s.runId, "context.snapshot", s.agentId, { snapshotId: id }, s.assembledAtS);
      return snapshot;
    },

    async saveArtifact(runId, a) {
      const id = await db.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${runId}, 0))`);
        const state = await tx.execute(sql`select (spliced_from_run_id is not null) as spliced, (finalized_at is not null) as finalized from runs where id = ${runId}`);
        const st = state.rows[0] as { spliced: boolean; finalized: boolean } | undefined;
        if (!st) throw new Error(`run ${runId} not found`);
        if (st.spliced || st.finalized) throw new RunClosedError(runId, st.spliced ? "spliced" : "finalized");
        const count = await tx.execute(sql`select count(*) as n from artifacts where run_id = ${runId}`);
        const n = Number((count.rows[0] as { n: string }).n) + 1;
        const artifactId = `art-${runId}-${n}`;
        const isBinary = typeof a.content !== "string";
        await tx.execute(sql`
          insert into artifacts (id, run_id, name, by, ord, content_type, content)
          values (${artifactId}, ${runId}, ${a.name}, ${a.by}, ${n}, ${isBinary ? "application/octet-stream" : "text/plain"},
                  ${isBinary ? Buffer.from(a.content as Uint8Array).toString("base64") : (a.content as string)})`);
        return artifactId;
      });
      await emitRow(db, hooks, runId, "artifact.created", a.by, { name: a.name, artifactId: id });
      return { id };
    },

    async end(runId, status, outcome) {
      const updated = await db.db.execute(sql`
        update runs set status = ${status}, ended_at = now(),
          duration_s = coalesce(duration_s, round(extract(epoch from (now() - started_at))::numeric, 2)),
          outcome = coalesce(${outcome ?? null}, outcome)
        where id = ${runId} and finalized_at is null
        returning id`);
      if (updated.rows.length !== 1) return; // already finalized: end() is a no-op
      await hooks.onEnd?.(runId, status);
    },
  };
}

/** Emit with an explicit `t`: import playback and finalize's run.finished at the merged timeline
 *  end. Exempt from the closed-run guard — closing a run is exactly what emits run.finished. */
export function emitAt(db: Db, runId: string, type: RunEventType, actor: string | undefined, payload: RunEventPayloads[RunEventType], t: number, hooks: RunWriterHooks = {}): Promise<RunEvent> {
  return emitRow(db, hooks, runId, type, actor, payload as Record<string, unknown>, t, true);
}

/** Maps one runs row to the contract Run; segments derive from the given (merged) event log. */
export function rowToRun(row: RunRowLike, events: Parameters<typeof deriveSegments>[0], nowMs: number): Run {
  const startedMs = new Date(row.started_at).getTime();
  const maxEventT = events.reduce((m, e) => Math.max(m, e.t), 0);
  const durationS =
    row.duration_s != null ? Number(row.duration_s)
    : row.ended_at ? (new Date(row.ended_at).getTime() - startedMs) / 1000
    : Math.max(maxEventT, (nowMs - startedMs) / 1000);
  return {
    id: row.id,
    taskId: row.task_id ?? "",
    teamId: row.team_id,
    n: Number(row.n),
    objective: row.objective,
    status: row.status as Run["status"],
    startedAt: row.started_at_text ?? new Date(row.started_at).toISOString(),
    recorded: row.recorded,
    durationS: Math.round(durationS),
    etaS: row.eta_s != null ? Number(row.eta_s) : undefined,
    costUsd: Number(row.cost_usd),
    budget: row.budget,
    reworkBudget: row.rework_budget,
    assistantTokens: row.assistant_tokens,
    brief: row.brief,
    segments: deriveSegments(events, durationS),
    outcome: row.outcome ?? undefined,
    reportId: row.report_id ?? undefined,
    recording: row.recording_key
      ? { key: row.recording_key, kind: (row.recording_kind ?? "illustrative") as RecordingKind, spliceT: row.splice_t != null ? Number(row.splice_t) : undefined }
      : undefined,
  };
}
