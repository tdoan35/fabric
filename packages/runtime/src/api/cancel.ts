// The cancellation API and the append guard (RUNTIME section 7). `cancel`
// appends `run.cancel_requested` — decide's rule 1 does the rest (the subtree,
// `run.stopped`). Past it, late results for the stream are refused by the
// append guard: the runtime's answer to the old `RunClosedError`, a check and
// append in the caller's transaction so a closed run's log stays closed.
import { fold } from "@fabric/core";
import { append } from "../store/store";
import type { AppendBatch, RuntimeStore, RuntimeTx } from "../store/types";
import { enqueueReDecides, readEventRows } from "../workers/decide";

/** The queue is optional: with one, the cancellation's decide is queued here;
 * without, the caller owns waking the loop. */
export type CancelOptions = { queue?: import("../queue/types").Queue };

export async function cancel(
  store: RuntimeStore,
  workspaceId: string,
  streamId: string,
  by: string,
  options: CancelOptions = {}
): Promise<void> {
  await store.transaction(async (tx) => {
    await append(tx, workspaceId, [
      {
        streamId,
        events: [{ type: "run.cancel_requested", actor: "api", payload: { by } }],
      },
    ]);
    if (options.queue !== undefined) {
      await enqueueReDecides(tx, options.queue, workspaceId, [streamId]);
    }
  });
}

export type AppendGuardResult = { appended: boolean };

/**
 * The append guard: `batch` lands only if the stream's run is still open —
 * not terminal and with no cancellation requested. A refused batch records
 * nothing; the caller sees `appended: false` and the lease's retry bookkeeping
 * takes it from there. The check and the append share the caller's
 * transaction, so a cancellation landing mid-flight cannot split the two.
 */
export async function appendGuarded(
  tx: RuntimeTx,
  workspaceId: string,
  batch: AppendBatch
): Promise<AppendGuardResult> {
  const rows = await readEventRows(tx, batch.streamId, workspaceId);
  const state = fold(rows);
  const closed =
    state.status === "blocked" ||
    state.status === "finished" ||
    state.status === "stopped" ||
    state.cancelRequested;
  if (closed) return { appended: false };
  await append(tx, workspaceId, [batch]);
  return { appended: true };
}
