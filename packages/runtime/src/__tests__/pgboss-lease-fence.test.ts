// The pg-boss lease fence (ANY-92 T16 rework) — the writes a defer's
// re-claim must never land on. complete and defer buffer into the caller's
// transaction and apply after it commits; heartbeat and the retryable
// failure apply at once behind a call-time staleness check. In every shape
// the WRITE itself must fence on the claim identity: a defer's re-claim
// hands the same (worker, attempt) pair back, so only the claim's own
// instant — the row's started_on — separates the live lease from the one
// that gave the job back. A check beside the write cannot fence it: the
// claim can be lost and re-taken between the check and the write, and then
// an attempt-fenced write lands on the replacement claim — a stale
// completion finishes the fresh run, a stale deferral or failure sends it
// back to pending, a stale touch stamps its heartbeat.
//
// The staged-write cases (complete, defer) replay the ordering directly and
// run on both drivers: PGlite in-memory and Postgres from
// RUNTIME_TEST_DATABASE_URL when set. The mid-write interleavings — the
// check passes, the job is deferred and re-claimed, then the write runs —
// are forced through a query interceptor, which only the pglite connection
// shape allows (the caller supplies the database object, so the test holds
// every statement); their SQL fencing is driver-shared, and Postgres runs
// the same statements through the cases above and the conformance suite.
import { afterEach, describe, expect, test } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { TestClock } from "pg-boss";
import { PgBossQueue } from "../queue/pgboss/index";
import type { MinimalPg, PgBossQueueOptions } from "../queue/pgboss/index";
import type { QueueLease } from "../queue/types";
import { postgresUrlFromEnv } from "../testing/drivers";

/** Queues born this case; closed after it, so no pool outlives its test. */
const live: PgBossQueue[] = [];

afterEach(async () => {
  while (live.length > 0) {
    await live.pop()!.close();
  }
});

/** tracked */
function tracked(options: PgBossQueueOptions): PgBossQueue {
  const queue = new PgBossQueue({ testClock: new TestClock(0), ...options });
  live.push(queue);
  return queue;
}

/** A throwaway host transaction: applies fire on commit, never on rollback. */
function stagedTx() {
  const hooks: (() => unknown)[] = [];
  return {
    onCommit: (hook: () => unknown) => void hooks.push(hook),
    commit: () => {
      for (const hook of hooks.splice(0)) hook();
    },
  };
}

// ---------------------------------------------------------------------------
// The staged writes — complete and defer buffered, applied after a re-claim.
// ---------------------------------------------------------------------------

async function expectStagedStaleLeaseWritesToBeNoOps(queue: PgBossQueue): Promise<void> {
  const enq = stagedTx();
  const job = await queue.enqueue(enq, {
    type: "tool.exec",
    key: "run:fence:c1",
    streamId: "run:fence",
    workspaceId: "w1",
  });
  enq.commit();

  const old = await queue.claim("worker-1", ["tool.exec"], 0);
  expect(old?.jobId).toBe(job.id);
  expect(old?.attempt).toBe(1);
  expect(old?.claimAt).toBeDefined();

  // Both writes staged while the lease is current, neither committed.
  const stagedComplete = stagedTx();
  await queue.complete(stagedComplete, old!);
  const stagedDefer = stagedTx();
  await queue.defer(stagedDefer, old!, 4_000);

  // The job is given back — applied now, while the lease still holds — and
  // re-claimed at once: the same worker, the same attempt, a new claim.
  const deferTx = stagedTx();
  await queue.defer(deferTx, old!, 2_000);
  deferTx.commit();
  const fresh = await queue.claim("worker-1", ["tool.exec"], 2_000);
  expect(fresh?.jobId).toBe(job.id);
  expect(fresh?.attempt).toBe(1);
  expect(fresh?.claimAt).not.toBe(old!.claimAt);

  // The stale lease is fenced out of the fresh claim: its heartbeat throws,
  // and neither staged write, applied after the re-claim, may land on the
  // replacement claim.
  await expect(queue.heartbeat(old!, 2_100)).rejects.toThrow(/stale/i);
  stagedComplete.commit();
  expect((await queue.get(job.id))?.status).toBe("leased");
  stagedDefer.commit();
  const after = await queue.get(job.id);
  expect(after?.status).toBe("leased");
  expect(after?.runAt).toBe(2_000);
  await expect(queue.claim("worker-2", ["tool.exec"], 4_000)).resolves.toBeNull();

  // the fresh lease is the live one: its completion lands
  const done = stagedTx();
  await queue.complete(done, fresh!);
  done.commit();
  expect((await queue.get(job.id))?.status).toBe("completed");
}

describe("PgBossQueue lease fence [pglite]", () => {
  test("a staged complete or defer for a lease lost to a defer's re-claim leaves the fresh claim leased", async () => {
    await expectStagedStaleLeaseWritesToBeNoOps(
      tracked({ connection: { kind: "pglite", pglite: new PGlite() } }),
    );
  });
});

const postgresUrl = postgresUrlFromEnv();
if (postgresUrl !== undefined) {
  describe("PgBossQueue lease fence [postgres]", () => {
    test("a staged complete or defer for a lease lost to a defer's re-claim leaves the fresh claim leased", async () => {
      const schema = `pgboss_q_${process.pid}_fence_${Date.now()}`;
      await expectStagedStaleLeaseWritesToBeNoOps(
        tracked({
          schema,
          connection: { kind: "postgres", connectionString: postgresUrl },
        }),
      );
    });
  });
}

// ---------------------------------------------------------------------------
// The applied-at-once writes — heartbeat and the retryable failure — whose
// staleness check runs as a separate statement before the write. The
// interceptor holds the write's statement, gives the job back through the
// lease the check just validated, re-claims it (same worker, same attempt,
// a new claim instant), and only then lets the write through: the write must
// miss the replacement claim, exactly as a lease lost in the window since
// the check is left alone everywhere else.
// ---------------------------------------------------------------------------

/** A pglite stand-in that runs `inject` immediately before the first
 * statement matching `victim` reaches the database, once per queue. The
 * single underlying connection serializes everything, so the interleaving —
 * check, defer, re-claim, write — is exact. */
function intercepting(pglite: PGlite, victim: (sql: string) => boolean): {
  db: MinimalPg;
  arm: (inject: () => Promise<void>) => void;
} {
  let inject: (() => Promise<void>) | null = null;
  // Both protocols go through one gate: the held statement waits while the
  const gate = async <T>(text: string, run: () => Promise<T>): Promise<T> => {
    const held = inject;
    if (held !== null && victim(text)) {
      inject = null;
      await held();
    }
    return run();
  };
  const db: MinimalPg = {
    query: (text, values) => gate(text, () => pglite.query(text, values)),
    exec: (text) => gate(text, () => pglite.exec(text)),
  };
  return { db, arm: (fn) => void (inject = fn) };
}

/** One claimed tool.exec job to race on: the claim is `out`'s result. */
async function claimOne(queue: PgBossQueue, callKey: string): Promise<QueueLease> {
  const enq = stagedTx();
  const job = await queue.enqueue(enq, {
    type: "tool.exec",
    key: callKey,
    streamId: "run:fence2",
    workspaceId: "w1",
  });
  enq.commit();
  const lease = await queue.claim("worker-1", ["tool.exec"], 0);
  expect(lease?.jobId).toBe(job.id);
  expect(lease?.claimAt).toBeDefined();
  return lease!;
}

/** The mid-write takeover: defer through the checked lease, then re-claim —
 * the same worker, the same attempt, a new claim instant. The claim lands on
 * the victim's own clock instant: the held statement is still in flight, and
 * the TestClock's setTime would wait for the database to go idle — on the
 * very statement the gate is holding — so the takeover must not move time. */
async function reclaimThrough(queue: PgBossQueue, old: QueueLease): Promise<QueueLease> {
  const giveBack = stagedTx();
  await queue.defer(giveBack, old, 2_000);
  giveBack.commit();
  const fresh = await queue.claim("worker-1", ["tool.exec"], 2_100);
  expect(fresh?.jobId).toBe(old.jobId);
  expect(fresh?.attempt).toBe(old.attempt);
  expect(fresh?.claimAt).not.toBe(old.claimAt);
  return fresh!;
}

describe("PgBossQueue applied-write fence [pglite]", () => {
  test("a retryable failure whose lease lost the job between check and write leaves the fresh claim leased", async () => {
    // the victim statement: a write that requeues or fails the job, naming
    // the retry state — never a bare `retry_count` column reference
    const { db, arm } = intercepting(new PGlite(), (sql) =>
      /^\s*(update|with|delete)\b/i.test(sql) && /\bretry\b/i.test(sql));
    const queue = tracked({ connection: { kind: "pglite", pglite: db } });
    const old = await claimOne(queue, "run:fence2:fail");

    let fresh: QueueLease | null = null;
    arm(async () => {
      fresh = await reclaimThrough(queue, old);
    });

    // The stale failure: its check passed (the lease was current when the
    // check ran); its write runs after the re-claim and must be a no-op —
    // an attempt-fenced write would send the replacement claim back to
    // pending while its worker runs it.
    await queue.fail(old, new Error("stale worker failed"), { retryable: true }, 2_100);
    expect((await queue.get(old.jobId))?.status).toBe("leased");

    // the fresh lease is the live one: its completion lands
    const done = stagedTx();
    await queue.complete(done, fresh!);
    done.commit();
    expect((await queue.get(old.jobId))?.status).toBe("completed");
  });

  test("a heartbeat whose lease lost the job between check and touch throws instead of stamping the fresh claim", async () => {
    // the victim statement: the touch, the only write that sets heartbeat_on
    const { db, arm } = intercepting(new PGlite(), (sql) =>
      /^\s*(update|with)\b/i.test(sql) && sql.includes("heartbeat_on"));
    const queue = tracked({ connection: { kind: "pglite", pglite: db } });
    const old = await claimOne(queue, "run:fence2:hb");

    let fresh: QueueLease | null = null;
    arm(async () => {
      fresh = await reclaimThrough(queue, old);
    });

    // The stale touch: an attempt-fenced touch would refresh the
    // replacement claim's heartbeat for a worker that no longer holds it;
    // fenced on the claim identity it is a stale lease, like every miss.
    await expect(queue.heartbeat(old, 2_100)).rejects.toThrow(/stale/i);
  });

});
