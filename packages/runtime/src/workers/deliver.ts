// The `deliver` job handler (RUNTIME §4): one outbound message, sent once
// through the SurfacePort with the job key — `deliver:<eventId>:<target>` — as
// the idempotency key, the receipt recorded as `message.delivered` telemetry
// carrying `{ eventId, target, platformMessageId }` with
// `causation = <job key>`. The key names the `agent.message` it delivers
// (`agent-message:<stream>:<turn>`, decide's id for the reply); the turn-th
// such event on the session is the text, one per ended turn by construction.
//
// The receipt is telemetry, so the recorded-result guard reads across classes:
// a re-run of the job sends nothing and appends nothing (W13). A failing send
// is a queue retry with the type's backoff — the idempotency key lets a
// crash-between-send-and-record be absorbed by the adapter (W13a). Telemetry
// triggers no re-decide (§2): the receipt is the UI's, not the loop's.
import type { SurfacePort } from "../ports";
import type { Queue, QueueLease } from "../queue/types";
import { append } from "../store/store";
import type { RuntimeStore } from "../store/types";
import { readEventRows, type EventRow } from "./decide";

export type DeliverJobDeps = {
  store: RuntimeStore;
  queue: Queue;
  /** The outbound channel; production adapters bind target → transport. */
  surface: SurfacePort;
  /** Injected clock, handed to the queue's retry bookkeeping. */
  now?: () => number;
};

/** The delivery the job key names, parsed against the job's own stream. */
function deliveryOf(key: string, streamId: string): { eventId: string; turn: number; target: string } {
  const rest = key.startsWith("deliver:") ? key.slice("deliver:".length) : null;
  const prefix = `agent-message:${streamId}:`;
  if (rest === null || !rest.startsWith(prefix)) {
    throw new Error(`deliver ${key}: does not name an agent.message on ${streamId}`);
  }
  const tail = rest.slice(prefix.length);
  const sep = tail.indexOf(":");
  const turn = sep === -1 ? Number.NaN : Number(tail.slice(0, sep));
  const target = sep === -1 ? "" : tail.slice(sep + 1);
  if (!Number.isInteger(turn) || turn < 1 || target.length === 0) {
    throw new Error(`deliver ${key}: does not parse as deliver:<agent-message>:<target>`);
  }
  return { eventId: `${prefix}${turn}`, turn, target };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The turn-th `agent.message` on the stream — one per ended turn, in order. */
function messageTextOf(rows: readonly EventRow[], turn: number, streamId: string, key: string): string {
  const messages = rows.filter((row) => row.type === "agent.message");
  const message = messages[turn - 1];
  if (message === undefined) {
    throw new Error(`deliver ${key}: no ${turn}th agent.message on ${streamId}`);
  }
  const payload = isRecord(message.payload) ? message.payload : {};
  return typeof payload.text === "string" ? payload.text : "";
}

/**
 * Run one claimed `deliver` job. A surface failure fails the lease per the
 * type's retry config (backoff to 24 h) and rethrow, so the runner sees the
 * failure; the retry re-enters through the recorded guard.
 */
export async function handleDeliverJob(lease: QueueLease, deps: DeliverJobDeps): Promise<void> {
  const { store, queue, surface } = deps;
  const now = deps.now ?? (() => Date.now());
  const streamId = lease.streamId;
  if (streamId === null) throw new Error("deliver job without a stream");
  const key = lease.key;
  const delivery = deliveryOf(key, streamId);

  let recorded = false;
  try {
    await store.transaction(async (tx) => {
      // W13: the receipt already recorded — an at-least-once re-run. No second
      // send; the tail completes the lease tolerantly. Telemetry, so no class
      // filter: the guard reads across classes.
      const done = await tx.query(
        `select 1 from events where stream_id = $1 and workspace_id = $2 and causation = $3 limit 1`,
        [streamId, lease.workspaceId, key]
      );
      if (done.length > 0) {
        recorded = true;
        return;
      }

      const rows = await readEventRows(tx, streamId, lease.workspaceId);
      const text = messageTextOf(rows, delivery.turn, streamId, key);
      const receipt = await surface.send(delivery.target, { text }, {
        idempotencyKey: key,
      });

      await append(tx, lease.workspaceId, [
        {
          streamId,
          events: [
            {
              type: "message.delivered",
              actor: "deliver",
              payload: {
                eventId: delivery.eventId,
                target: delivery.target,
                platformMessageId: receipt?.platformMessageId ?? null,
              },
              causation: key,
            },
          ],
        },
      ]);
      // telemetry only: no re-decide (§2)
      await queue.complete(tx, lease);
    });
  } catch (error) {
    await queue.fail(lease, error instanceof Error ? error : new Error(String(error)), {
      retryable: true,
    }, now());
    throw error;
  }
  if (recorded) {
    // The receipt is durable; complete the lease, tolerating the runner that
    // got there first — its completion is the proof the guard saw.
    try {
      await store.transaction((tx) => queue.complete(tx, lease));
    } catch (error) {
      const job = await queue.get(lease.jobId);
      if (job?.status !== "completed") throw error;
    }
  }
}
