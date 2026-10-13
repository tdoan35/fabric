// The `run.timer` job handler (RUNTIME section 4, section 7): a decide
// scheduled with `run_at`. The handler folds the stream, asks the pure core
// what the firing means (`decideTimer`, keyed by the grammar in
// `parseTimerTrigger`), then appends the decision and enqueues its jobs —
// the watchdog's second check, the re-queued lost work — in ONE transaction,
// like every handler. Events carry `causation = <key>:<type>:<n>`, so a
// retried timer's re-append is a no-op and one firing's facts never collide.
//
// There is no re-decide here: a firing that blocks the run leaves it terminal,
// a reminder is telemetry, and a re-queued job re-enters the loop under its
// own key when it runs.
import { decideTimer, fold, parseTimerTrigger } from "@fabric/core";
import type { Queue, QueueLease } from "../queue/types";
import { append } from "../store/store";
import type { RuntimeStore } from "../store/types";
import { readEventRows } from "./decide";

export type TimerJobDeps = {
  store: RuntimeStore;
  queue: Queue;
  /** Injected clock for the rules' windows; the real clock in production. */
  now?: () => number;
};

export async function handleTimerJob(lease: QueueLease, deps: TimerJobDeps): Promise<void> {
  const { store, queue } = deps;
  const now = deps.now ?? (() => Date.now());
  const streamId = lease.streamId;
  if (streamId === null) throw new Error("run.timer job without a stream");
  const key = lease.key;

  try {
    await store.transaction(async (tx) => {
      const rows = await readEventRows(tx, streamId, lease.workspaceId);
      const state = fold(rows);
      const trigger = parseTimerTrigger(streamId, key);
      const decision =
        trigger === null ? { events: [], jobs: [] } : decideTimer(state, streamId, trigger, now());

      // -- one transaction: the firing's events, then its jobs -------------------
      const ordinals = new Map<string, number>();
      const events = decision.events.map((event) => {
        const n = ordinals.get(event.type) ?? 0;
        ordinals.set(event.type, n + 1);
        return {
          type: event.type,
          actor: "run.timer",
          payload: event.payload,
          causation: `${key}:${event.type}:${n}`,
        };
      });
      if (events.length > 0) {
        await append(tx, lease.workspaceId, [{ streamId, events }]);
      }
      for (const job of decision.jobs) {
        await queue.enqueue(tx, {
          type: job.type,
          key: job.key,
          streamId: job.streamId ?? streamId,
          workspaceId: lease.workspaceId,
          ...(job.runAt !== undefined ? { runAt: job.runAt } : {}),
        });
      }

      await queue.complete(tx, lease);
    });
  } catch (error) {
    await queue.fail(lease, error instanceof Error ? error : new Error(String(error)), {
      retryable: true,
    }, now());
    throw error;
  }
}
