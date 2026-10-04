// Splice (D5, RUN-2): POST /splice {t} finds the recording through the task's recordingKey,
// cancels the live team runtime (a TEAM stub logs one line and we carry on), then stamps
// spliced_from_run_id / splice_t. From then on GET events returns the merged log and the run
// carries `recording`. The WHERE guard makes a double splice a 409, even under races.
import { NotImplementedError } from "@fabric/contracts";
import type { SpliceResponse } from "@fabric/contracts";
import { getRunRow, latestRecordingRun, mergedEvents, readRun, readTask, rowToRun, sql } from "@fabric/db";
import { hub } from "./hub";
import { runtime } from "./runtime";

export type SpliceResult = { ok: true; body: SpliceResponse } | { ok: false; status: 404 | 409; error: string };

export async function spliceRun(runId: string, t: number): Promise<SpliceResult> {
  const { db } = runtime();
  const run = await getRunRow(db, runId);
  if (!run) return { ok: false, status: 404, error: `run ${runId} not found` };
  if (run.recorded) return { ok: false, status: 409, error: `${runId} is itself a recording` };
  if (run.spliced_from_run_id) return { ok: false, status: 409, error: `${runId} was already spliced` };

  const task = run.task_id ? await readTask(db, run.task_id) : undefined;
  const key = task?.recordingKey;
  if (!key) return { ok: false, status: 409, error: `task ${run.task_id} has no recordingKey to splice into` };
  const recording = await latestRecordingRun(db, key);
  if (!recording) return { ok: false, status: 404, error: `no recording with key ${key}` };

  const updated = await db.db.execute(sql`
    update runs set spliced_from_run_id = ${recording.id}, splice_t = ${t},
                     recording_key = ${recording.recording_key}, recording_kind = ${recording.recording_kind},
                     duration_s = ${recording.duration_s}
    where id = ${runId} and spliced_from_run_id is null
    returning id`);
  if (updated.rows.length !== 1) return { ok: false, status: 409, error: `${runId} was already spliced` };

  // The stamp above closes the run: from here every late emit fails with RunClosedError, and the
  // merged log drops anything after splice_t. So the team is cancelled in the background — the
  // Fast-forward click doesn't wait for in-flight model calls to unwind.
  const team = runtime().team();
  if (team) {
    void team.cancelRun(runId).catch((err: unknown) => {
      if (err instanceof NotImplementedError) console.log(`[splice] TEAM cancelRun not implemented yet; run ${runId} stays marked running`);
      else console.log(`[splice] cancelRun failed, continuing: ${String(err)}`);
    });
  }

  hub.publishApp({ type: "run.changed", runId });
  const row = (await getRunRow(db, runId))!;
  const events = await mergedEvents(db, row);
  return { ok: true, body: { run: rowToRun(row, events, Date.now()), events } };
}
