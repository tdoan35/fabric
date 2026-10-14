// Crash-suite queue wrapper (ANY-37 R11): the observability and kill-point
// seams the harness needs around the durable queue, with the queue's own
// semantics untouched.
//
// - Every claim and completion lands in the JSONL log with a timestamp: the
//   handover table is `kill → the survivor's first claim`, read off this log.
// - K3's kill point is BETWEEN jobs — after a chosen job's completion
//   committed, before the next claim. The wrapper arms on that completion and
//   holds the NEXT claim at a barrier: the kill lands holding no lease, the
//   board still carrying pending work.
import type { Queue, QueueLease, QueueTx, QueueJob, QueueJobInput } from "../src/queue/types";
import { barrier, logEvent } from "./fakes";

export interface QueueWrapSpec {
  logFile: string;
  /** The directory barrier markers and releases live in. */
  dir: string;
  /** Arm on this job key's completion; hold the next claim at `barrier`. */
  blockClaimAfterCompleteOf?: { key: string; barrier: string };
}

export function wrapQueue(queue: Queue, spec: QueueWrapSpec): Queue {
  let armed = false;
  const wrapped: Queue = {
    enqueue: (tx: QueueTx, job: QueueJobInput) => queue.enqueue(tx, job),
    claim: async (workerId: string, types: readonly string[], now: number) => {
      if (armed) {
        armed = false;
        await barrier(spec.dir, spec.blockClaimAfterCompleteOf!.barrier);
      }
      const lease = await queue.claim(workerId, types, now);
      if (lease !== null) {
        logEvent(spec.logFile, {
          t: Date.now(),
          ev: "claim",
          worker: workerId,
          type: lease.type,
          key: lease.key,
          attempt: lease.attempt,
        });
      }
      return lease;
    },
    heartbeat: (lease: QueueLease, now: number) => queue.heartbeat(lease, now),
    complete: async (tx: QueueTx, lease: QueueLease) => {
      await queue.complete(tx, lease);
      if (spec.blockClaimAfterCompleteOf !== undefined && lease.key === spec.blockClaimAfterCompleteOf.key) {
        armed = true;
      }
    },
    fail: (lease: QueueLease, error: Error, options: { retryable: boolean }, now: number) =>
      queue.fail(lease, error, options, now),
    get: (jobId: string) => queue.get(jobId) as Promise<QueueJob | null>,
  };
  return wrapped;
}
