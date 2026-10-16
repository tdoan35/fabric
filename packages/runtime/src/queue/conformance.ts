// The queue conformance suite (ANY-32 R6): the executable spec of RUNTIME §4.
// Any queue implementation — MemoryQueue here, R7's pg-boss adapter, R8's
// durable queue — proves itself by calling `runQueueConformance(name, makeQueue)`
// and passing every case. Time is injected end to end; no case reads the clock.
//
// The cases are exported as data (`queueConformanceCases`) so the mutant checks
// can run a single case against a broken variant and watch it fail.
import { describe, expect, it } from "vitest";
import type { QueueFactory, QueueJobInput, QueueLease, QueueTx } from "./types";

/** A throwaway host transaction: queue writes buffered against it land on
 * `commit`, never on rollback. Exactly the `QueueTx` contract of types.ts. */
function memoryTx(): QueueTx & { commit(): void; rollback(): void } {
  const hooks: (() => unknown)[] = [];
  return {
    onCommit: (hook) => hooks.push(hook),
    commit: () => {
      const run = [...hooks];
      hooks.length = 0;
      for (const hook of run) hook();
    },
    rollback: () => {
      hooks.length = 0;
    },
  };
}

export interface QueueConformanceCase {
  id: string;
  name: string;
  run: (makeQueue: QueueFactory) => Promise<void>;
}

/** Defaults pinned by the cases below; see `DEFAULT_TYPE_CONFIGS` in types.ts.
 * Changing a default means changing the pinning case with it. */
const cases: QueueConformanceCase[] = [
  {
    id: "Q1",
    name: "Q1 enqueueing the same key twice leaves one job",
    run: async (makeQueue) => {
      const queue = makeQueue();
      const tx1 = memoryTx();
      const first = await queue.enqueue(tx1, { type: "deliver", key: "deliver:e1:email", workspaceId: "w1" });
      tx1.commit();
      const tx2 = memoryTx();
      const second = await queue.enqueue(tx2, { type: "deliver", key: "deliver:e1:email", workspaceId: "w1" });
      tx2.commit();
      expect(second.id).toBe(first.id);
      const lease = await queue.claim("worker-1", ["deliver"], 0);
      expect(lease?.jobId).toBe(first.id);
      // the duplicate must not have become a second job
      await expect(queue.claim("worker-2", ["deliver"], 0)).resolves.toBeNull();
    },
  },
  {
    id: "Q2",
    name: "Q2 a job with runAt in the future can't be claimed until now >= runAt",
    run: async (makeQueue) => {
      const queue = makeQueue();
      const tx = memoryTx();
      const job = await queue.enqueue(tx, { type: "deliver", key: "deliver:e2:sms", workspaceId: "w1", runAt: 100 });
      tx.commit();
      await expect(queue.claim("worker-1", ["deliver"], 0)).resolves.toBeNull();
      await expect(queue.claim("worker-1", ["deliver"], 99)).resolves.toBeNull();
      const lease = await queue.claim("worker-1", ["deliver"], 100);
      expect(lease?.jobId).toBe(job.id);
    },
  },
  {
    id: "Q3",
    name: "Q3 two decide jobs for the same stream are never leased at once; different streams are",
    run: async (makeQueue) => {
      const queue = makeQueue();
      const tx = memoryTx();
      await queue.enqueue(tx, { type: "decide", key: "decide:s1:a", streamId: "stream-1", workspaceId: "w1" });
      await queue.enqueue(tx, { type: "decide", key: "decide:s1:b", streamId: "stream-1", workspaceId: "w1" });
      await queue.enqueue(tx, { type: "decide", key: "decide:s2:c", streamId: "stream-2", workspaceId: "w1" });
      tx.commit();
      const first = await queue.claim("worker-1", ["decide"], 0);
      expect(first?.streamId).toBe("stream-1");
      // a different stream leases alongside the first
      const otherStream = await queue.claim("worker-2", ["decide"], 0);
      expect(otherStream?.streamId).toBe("stream-2");
      // the second stream-1 job waits: one decide run per stream
      await expect(queue.claim("worker-3", ["decide"], 0)).resolves.toBeNull();
      const done = memoryTx();
      await queue.complete(done, first!);
      done.commit();
      const again = await queue.claim("worker-3", ["decide"], 0);
      expect(again?.streamId).toBe("stream-1");
    },
  },
  {
    id: "Q4",
    name: "Q4 two executor jobs (llm.call, tool.exec) for the same stream are leased at once",
    run: async (makeQueue) => {
      const queue = makeQueue();
      const tx = memoryTx();
      const llm = await queue.enqueue(tx, {
        type: "llm.call",
        key: "stream-1:turn:llm:1",
        streamId: "stream-1",
        workspaceId: "w1",
      });
      const tool = await queue.enqueue(tx, {
        type: "tool.exec",
        key: "stream-1:call-1",
        streamId: "stream-1",
        workspaceId: "w1",
      });
      tx.commit();
      const llmLease = await queue.claim("worker-1", ["llm.call"], 0);
      const toolLease = await queue.claim("worker-2", ["tool.exec"], 0);
      expect(llmLease?.jobId).toBe(llm.id);
      expect(toolLease?.jobId).toBe(tool.id);
    },
  },
  {
    id: "Q5",
    name: "Q5 a lease not heartbeated within its window is reclaimable; the stale complete is rejected",
    run: async (makeQueue) => {
      const queue = makeQueue();
      const tx = memoryTx();
      const job = await queue.enqueue(tx, {
        type: "llm.call",
        key: "stream-1:turn:llm:2",
        streamId: "stream-1",
        workspaceId: "w1",
      });
      tx.commit();
      const first = await queue.claim("worker-1", ["llm.call"], 0);
      expect(first?.jobId).toBe(job.id);
      // llm.call's heartbeat window is 60s: still held just before it lapses
      await expect(queue.claim("worker-2", ["llm.call"], 59_000)).resolves.toBeNull();
      // ...and reclaimable once it has, as attempt 2
      const second = await queue.claim("worker-2", ["llm.call"], 61_000);
      expect(second?.jobId).toBe(job.id);
      expect(second?.attempt).toBe(2);
      // worker-1's lease is dead: its completion is rejected as stale
      await expect(queue.complete(memoryTx(), first!)).rejects.toThrow(/stale/i);
    },
  },
  {
    id: "Q6",
    name: "Q6 a heartbeat extends the lease: the job is not reclaimable while heartbeats keep coming",
    run: async (makeQueue) => {
      const queue = makeQueue();
      const tx = memoryTx();
      const job = await queue.enqueue(tx, {
        type: "llm.call",
        key: "stream-1:turn:llm:3",
        streamId: "stream-1",
        workspaceId: "w1",
      });
      tx.commit();
      const lease = await queue.claim("worker-1", ["llm.call"], 0);
      // beat at 30s: the window now runs to 90s, past the original 60s
      await queue.heartbeat(lease!, 30_000);
      await expect(queue.claim("worker-2", ["llm.call"], 70_000)).resolves.toBeNull();
      // beat at 100s: the window runs to 160s
      await queue.heartbeat(lease!, 100_000);
      await expect(queue.claim("worker-2", ["llm.call"], 120_000)).resolves.toBeNull();
      // the beats stop: 60s after the last one the job is reclaimable
      const reclaimed = await queue.claim("worker-2", ["llm.call"], 160_001);
      expect(reclaimed?.jobId).toBe(job.id);
      expect(reclaimed?.attempt).toBe(2);
    },
  },
  {
    id: "Q7",
    name: "Q7 retryable failures requeue with backoff up to the retry count, then the job is dead",
    run: async (makeQueue) => {
      const queue = makeQueue();
      const tx = memoryTx();
      const job = await queue.enqueue(tx, { type: "decide", key: "decide:s9:x", streamId: "stream-9", workspaceId: "w1" });
      tx.commit();
      let now = 0;
      let lease = await queue.claim("worker-1", ["decide"], now);
      expect(lease?.attempt).toBe(1);
      // decide allows 3 retries; each requeue waits a doubling backoff (1s base)
      for (let run = 1; run <= 3; run++) {
        await queue.fail(lease!, new Error(`boom ${run}`), { retryable: true }, now);
        await expect(queue.claim("worker-2", ["decide"], now + 1)).resolves.toBeNull();
        now += 1_000 * 2 ** (run - 1);
        lease = await queue.claim("worker-2", ["decide"], now);
        expect(lease?.attempt).toBe(run + 1);
      }
      // the fourth failure has no retry left: dead, with the last error
      await queue.fail(lease!, new Error("boom 4"), { retryable: true }, now);
      const dead = await queue.get(lease!.jobId);
      expect(dead?.status).toBe("dead");
      expect(dead?.lastError).toBe("boom 4");
      expect(dead?.attempts).toBe(4);
      await expect(queue.claim("worker-3", ["decide"], now + 1_000_000)).resolves.toBeNull();
      expect(job.id).toBe("qjob-1");
    },
  },
  {
    id: "Q8",
    name: "Q8 a non-retryable failure makes the job dead at once",
    run: async (makeQueue) => {
      const queue = makeQueue();
      const tx = memoryTx();
      const job = await queue.enqueue(tx, { type: "deliver", key: "deliver:e3:push", workspaceId: "w1" });
      tx.commit();
      const lease = await queue.claim("worker-1", ["deliver"], 0);
      await queue.fail(lease!, new Error("channel gone"), { retryable: false }, 0);
      const dead = await queue.get(job.id);
      expect(dead?.status).toBe("dead");
      expect(dead?.lastError).toBe("channel gone");
      await expect(queue.claim("worker-2", ["deliver"], 0)).resolves.toBeNull();
      await expect(queue.claim("worker-2", ["deliver"], 1_000_000)).resolves.toBeNull();
    },
  },
  {
    id: "Q9",
    name: "Q9 the per-workspace cap bounds concurrent leases; other workspaces are unaffected",
    run: async (makeQueue) => {
      const queue = makeQueue({ perWorkspaceConcurrency: 2 });
      const tx = memoryTx();
      for (let i = 1; i <= 5; i++) {
        await queue.enqueue(tx, { type: "deliver", key: `deliver:bulk:a${i}`, workspaceId: "workspace-a" });
      }
      await queue.enqueue(tx, { type: "deliver", key: "deliver:bulk:b1", workspaceId: "workspace-b" });
      tx.commit();
      const a1 = await queue.claim("worker-1", ["deliver"], 0);
      const a2 = await queue.claim("worker-2", ["deliver"], 0);
      expect(a1?.workspaceId).toBe("workspace-a");
      expect(a2?.workspaceId).toBe("workspace-a");
      // workspace-a is at its cap of 2: the next lease goes to workspace-b
      const b1 = await queue.claim("worker-3", ["deliver"], 0);
      expect(b1?.workspaceId).toBe("workspace-b");
      // and nothing further is leaseable until a lease frees up
      await expect(queue.claim("worker-4", ["deliver"], 0)).resolves.toBeNull();
      const done = memoryTx();
      await queue.complete(done, a1!);
      done.commit();
      const a3 = await queue.claim("worker-4", ["deliver"], 0);
      expect(a3?.workspaceId).toBe("workspace-a");
    },
  },
  {
    id: "Q10",
    name: "Q10 a job enqueued in a rolled-back transaction does not exist",
    run: async (makeQueue) => {
      const queue = makeQueue();
      const tx = memoryTx();
      const staged = await queue.enqueue(tx, { type: "deliver", key: "deliver:rb:1", workspaceId: "w1" });
      tx.rollback();
      await expect(queue.claim("worker-1", ["deliver"], 0)).resolves.toBeNull();
      await expect(queue.get(staged.id)).resolves.toBeNull();
    },
  },
  {
    id: "Q11",
    name: "Q11 complete is atomic with the caller's transaction: rollback leaves the job leased",
    run: async (makeQueue) => {
      const queue = makeQueue();
      const setup = memoryTx();
      const job = await queue.enqueue(setup, {
        type: "llm.call",
        key: "stream-1:turn:llm:4",
        streamId: "stream-1",
        workspaceId: "w1",
      });
      setup.commit();
      const lease = await queue.claim("worker-1", ["llm.call"], 0);
      const tx = memoryTx();
      await queue.complete(tx, lease!);
      // buffered, not applied: still leased before the commit
      expect((await queue.get(job.id))?.status).toBe("leased");
      tx.rollback();
      expect((await queue.get(job.id))?.status).toBe("leased");
      // the rolled-back completion never landed: the lease later lapses, the job is reclaimable
      const next = await queue.claim("worker-2", ["llm.call"], 61_000);
      expect(next?.attempt).toBe(2);
      // a committed completion lands
      const committed = memoryTx();
      await queue.complete(committed, next!);
      committed.commit();
      expect((await queue.get(job.id))?.status).toBe("completed");
    },
  },
  {
    id: "Q12",
    name: "Q12 claim respects types: a deliver worker never gets the llm.call job",
    run: async (makeQueue) => {
      const queue = makeQueue();
      const tx = memoryTx();
      await queue.enqueue(tx, { type: "llm.call", key: "llm:solo:1", workspaceId: "w1" });
      const deliver = await queue.enqueue(tx, { type: "deliver", key: "deliver:e4:x", workspaceId: "w1" });
      tx.commit();
      const lease = await queue.claim("deliver-worker", ["deliver"], 0);
      expect(lease?.type).toBe("deliver");
      expect(lease?.jobId).toBe(deliver.id);
      // the second pass must not pick up the llm.call job either
      await expect(queue.claim("deliver-worker", ["deliver"], 0)).resolves.toBeNull();
    },
  },
  {
    // ANY-92 T16 C1: the sandbox-slot wait defers a leased job instead of
    // failing it. The optional call keeps a pre-defer queue failing on the
    // assertion below (the job is still leased) rather than on the method.
    id: "C1",
    name: "C1 defer puts a leased job back to pending at runAt on the same attempt; a stale lease throws",
    run: async (makeQueue) => {
      const queue = makeQueue();
      const tx = memoryTx();
      const job = await queue.enqueue(tx, {
        type: "tool.exec",
        key: "run:d1:c1",
        streamId: "run:d1",
        workspaceId: "w1",
      });
      tx.commit();
      const lease = await queue.claim("worker-1", ["tool.exec"], 0);
      expect(lease?.jobId).toBe(job.id);
      expect(lease?.attempt).toBe(1);

      // the slot wait: back to pending at runAt, no failure recorded
      const deferTx = memoryTx();
      await queue.defer?.(deferTx, lease!, 2_000);
      deferTx.commit();
      const deferred = await queue.get(job.id);
      expect(deferred?.status).toBe("pending");
      expect(deferred?.runAt).toBe(2_000);
      expect(deferred?.lastError).toBeNull();

      // not claimable before runAt; claimable after, as the same attempt —
      // a queue wait is not a retry, so the handler re-enters un-recovered
      await expect(queue.claim("worker-2", ["tool.exec"], 1_999)).resolves.toBeNull();
      const again = await queue.claim("worker-2", ["tool.exec"], 2_000);
      expect(again?.jobId).toBe(job.id);
      expect(again?.attempt).toBe(1);

      // the deferred lease is stale the moment the job left it: heartbeat and
      // complete throw, as complete throws on any lost lease
      await expect(queue.heartbeat(lease!, 2_100)).rejects.toThrow(/stale/i);
      await expect(queue.complete(memoryTx(), lease!)).rejects.toThrow(/stale/i);

      // and the same with ONE worker: the defer's re-claim hands the same
      // (worker, attempt) pair back, so the claim's own instant — not the
      // pair — is what fences the job the deferring lease left behind
      const deferAgain = memoryTx();
      await queue.defer?.(deferAgain, again!, 4_000);
      deferAgain.commit();
      const third = await queue.claim("worker-2", ["tool.exec"], 4_000);
      expect(third?.jobId).toBe(job.id);
      expect(third?.attempt).toBe(1);
      // the fresh lease is the live one: its heartbeats land
      await queue.heartbeat(third!, 4_050);
      // the lease that deferred is stale, though it names the same worker and
      // the same attempt — its heartbeat and completion cannot touch the run
      // that superseded it
      await expect(queue.heartbeat(again!, 4_100)).rejects.toThrow(/stale/i);
      await expect(queue.complete(memoryTx(), again!)).rejects.toThrow(/stale/i);
    },
  },
  {
    // The staged-write interleaving (T16 rework): complete and defer buffer
    // into the caller's transaction and apply after it commits. Between the
    // call and the apply the claim can be lost to a defer and taken again at
    // the same attempt — the applied write must fence on the claim identity,
    // or it lands on the replacement claim instead of being a no-op.
    id: "Q13",
    name: "Q13 a staged complete or defer whose lease lost the job to a defer's re-claim is a no-op against the replacement claim",
    run: async (makeQueue) => {
      const queue = makeQueue();
      const tx = memoryTx();
      const job = await queue.enqueue(tx, {
        type: "tool.exec",
        key: "run:d1:q13",
        streamId: "run:q13",
        workspaceId: "w1",
      });
      tx.commit();
      const old = await queue.claim("worker-1", ["tool.exec"], 0);
      expect(old?.jobId).toBe(job.id);
      expect(old?.attempt).toBe(1);

      // Both writes staged while the lease is current, neither committed.
      const stagedComplete = memoryTx();
      await queue.complete(stagedComplete, old!);
      const stagedDefer = memoryTx();
      await queue.defer(stagedDefer, old!, 4_000);

      // The job is given back — applied now, while the lease still holds —
      // and re-claimed at once: the same worker, the same attempt, a new
      // claim identity.
      const deferTx = memoryTx();
      await queue.defer(deferTx, old!, 2_000);
      deferTx.commit();
      const fresh = await queue.claim("worker-1", ["tool.exec"], 2_000);
      expect(fresh?.jobId).toBe(job.id);
      expect(fresh?.attempt).toBe(1);
      expect(fresh?.claimAt).not.toBe(old!.claimAt);

      // The stale lease is fenced out of the fresh claim: its heartbeat
      // throws, and the staged completion, applied after the re-claim, must
      // leave the replacement claim leased instead of completing it.
      await expect(queue.heartbeat(old!, 2_100)).rejects.toThrow(/stale/i);
      stagedComplete.commit();
      expect((await queue.get(job.id))?.status).toBe("leased");

      // The same for the staged defer: applied after the re-claim it must
      // not send the fresh claim back to pending.
      stagedDefer.commit();
      const after = await queue.get(job.id);
      expect(after?.status).toBe("leased");
      expect(after?.runAt).toBe(2_000);
      await expect(queue.claim("worker-2", ["tool.exec"], 4_000)).resolves.toBeNull();

      // the fresh lease is the live one: its completion lands
      const done = memoryTx();
      await queue.complete(done, fresh!);
      done.commit();
      expect((await queue.get(job.id))?.status).toBe("completed");
    },
  },
];

export const queueConformanceCases: readonly QueueConformanceCase[] = cases;

/** Registers the whole suite under `name`, one test per case. Every queue
 * implementation calls this on itself; the case names start with their IDs. */
export function runQueueConformance(name: string, makeQueue: QueueFactory): void {
  describe(name, () => {
    for (const testCase of queueConformanceCases) {
      it(testCase.name, () => testCase.run(makeQueue));
    }
  });
}

// Re-exported for implementers writing extra per-implementation cases in the
// same shape (the types ride along for convenience).
export type { QueueJobInput, QueueLease };
