// The `delegate.resolve` job handler (RUNTIME §4, §5.2): a child run has ended
// and the parent must hear of it. The handler applies R4's `resolveDelegation`
// against the parent stream — `tool.completed` on the awaited call,
// `delegation.result` on a background one; the fold releases the reserved
// budget and takes the child's spend from either fact (§7). The parent's next
// `decide` is queued here, the same way every fact-bearing append is followed
// (§2): the await completion re-opens the call, a background result parks as
// a pending input.
//
// The append carries `causation = <job key>` (`run:<child>:resolve`), so R5's
// unique index and the recorded-result guard make a re-run append nothing
// twice — the guard reads the PARENT stream, where the fact lands.
import { fold, parseStreamId, resolveDelegation } from "@fabric/core";
import type { Queue, QueueLease } from "../queue/types";
import { append } from "../store/store";
import type { RuntimeStore } from "../store/types";
import { enqueueReDecides, readEventRows, type EventRow } from "./decide";

export type DelegateResolveJobDeps = {
  store: RuntimeStore;
  queue: Queue;
  /** Injected clock, handed to the queue's retry bookkeeping. */
  now?: () => number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The parent stream and call the child's `run.created` names. */
function parentOf(rows: readonly EventRow[], childStream: string, key: string): { stream: string; callId: string } {
  const created = rows.find((row) => row.type === "run.created");
  if (created === undefined) throw new Error(`delegate.resolve ${key}: ${childStream} has no run.created`);
  const payload = isRecord(created.payload) ? created.payload : {};
  const parent = isRecord(payload.parent) ? payload.parent : null;
  const callId = typeof parent?.callId === "string" && parent.callId !== "" ? parent.callId : null;
  const stream =
    typeof parent?.runId === "string" && parent.runId !== ""
      ? `run:${parent.runId}`
      : typeof parent?.sessionId === "string" && parent.sessionId !== ""
        ? `session:${parent.sessionId}`
        : null;
  if (stream === null || callId === null) {
    throw new Error(`delegate.resolve ${key}: ${childStream} has no parent reference`);
  }
  return { stream, callId };
}

/** The parent's call mode: `background` when its `delegate` tool.call said so,
 * `await` otherwise — the same default rule 2 applies. */
function modeOf(rows: readonly EventRow[], callId: string): "await" | "background" {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.type !== "tool.call") continue;
    const payload = isRecord(row.payload) ? row.payload : {};
    if (payload.tool !== "delegate" || payload.callId !== callId) continue;
    const args = isRecord(payload.args) ? payload.args : {};
    return args.mode === "background" ? "background" : "await";
  }
  return "await";
}

/**
 * Run one claimed `delegate.resolve` job. Errors fail the lease per the type's
 * retry config (run-until-done) and rethrow, so the runner sees the failure.
 */
export async function handleDelegateResolveJob(lease: QueueLease, deps: DelegateResolveJobDeps): Promise<void> {
  const { store, queue } = deps;
  const now = deps.now ?? (() => Date.now());
  const childStream = lease.streamId;
  if (childStream === null) throw new Error("delegate.resolve job without a stream");
  const key = lease.key;

  let recorded = false;
  try {
    await store.transaction(async (tx) => {
      const childRows = await readEventRows(tx, childStream, lease.workspaceId);
      const parent = parentOf(childRows, childStream, key);

      // W12: the outcome already reported — an at-least-once re-run. Skip the
      // append; the tail completes the lease tolerantly.
      const done = await tx.query(
        `select 1 from events where stream_id = $1 and workspace_id = $2 and causation = $3 and class = 'fact' limit 1`,
        [parent.stream, lease.workspaceId, key]
      );
      if (done.length > 0) {
        recorded = true;
        return;
      }

      const parentRows = await readEventRows(tx, parent.stream, lease.workspaceId);
      const mode = modeOf(parentRows, parent.callId);
      const decision = resolveDelegation(
        { childRunId: parseStreamId(childStream).id, callId: parent.callId, state: fold(childRows) },
        mode
      );

      await append(tx, lease.workspaceId, [
        {
          streamId: parent.stream,
          events: decision.events.map((event) => ({
            type: event.type,
            actor: "delegate.resolve",
            payload: event.payload,
            causation: key,
          })),
        },
      ]);
      // §2: the parent gained a fact — its loop continues from it.
      await enqueueReDecides(tx, queue, lease.workspaceId, [parent.stream]);
      await queue.complete(tx, lease);
    });
  } catch (error) {
    await queue.fail(lease, error instanceof Error ? error : new Error(String(error)), {
      retryable: true,
    }, now());
    throw error;
  }
  if (recorded) {
    // The outcome is durable; complete the lease, tolerating the runner that
    // got there first — its completion is the proof the guard saw.
    try {
      await store.transaction((tx) => queue.complete(tx, lease));
    } catch (error) {
      const job = await queue.get(lease.jobId);
      if (job?.status !== "completed") throw error;
    }
  }
}
