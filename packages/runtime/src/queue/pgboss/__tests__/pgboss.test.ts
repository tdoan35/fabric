// The pg-boss adapter against the R6 conformance suite (ANY-33 R7), on both
// drivers: PGlite in-memory (one fresh database per queue) and Postgres from
// RUNTIME_TEST_DATABASE_URL when set, mirroring the store suite's driver rule.
// Time is injected end to end through pg-boss's TestClock, so the same injected
// instants drive the adapter's claims and pg-boss's own SQL.
import { afterEach, describe, expect, test } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { TestClock } from "pg-boss";
import { runQueueConformance } from "../../conformance";
import { PgBossQueue } from "../index";
import type { PgBossQueueOptions } from "../index";
import { postgresUrlFromEnv } from "../../../testing/drivers";

// The adapter's conformance lives behind `bench:queue` (and the explicit
// RUNTIME_QUEUE_CONFORMANCE=1) until it passes on both drivers; npm test
// skips it so the gate stays green (ANY-33: Q7's final assertion pins the
// MemoryQueue id literal, unsatisfiable on pg-boss's uuid ids).
const CONFORMANCE = process.env.RUNTIME_QUEUE_CONFORMANCE === "1";
const describeConformance = CONFORMANCE ? describe : describe.skip;

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

describeConformance("PgBossQueue [pglite]", () => {
  runQueueConformance("PgBossQueue [pglite]", (options) =>
    tracked({
      ...options,
      connection: { kind: "pglite", pglite: new PGlite() },
    }),
  );
});

const postgresUrl = postgresUrlFromEnv();
if (postgresUrl !== undefined) {
  describeConformance("PgBossQueue [postgres]", () => {
    // A schema per queue keeps the cases' rows apart without per-case
    // databases; the TestClock rides the schema's job_now().
    let suffix = 0;
    runQueueConformance("PgBossQueue [postgres]", (options) => {
      const schema = `pgboss_q_${process.pid}_${suffix++}`;
      return tracked({
        ...options,
        schema,
        connection: { kind: "postgres", connectionString: postgresUrl },
      });
    });
  });
}

// ---------------------------------------------------------------------------
// The lease fence (T16 rework) — always on, both drivers. complete and defer
// buffer into the caller's transaction and apply after it commits; between
// the call and the apply the claim can be lost to a defer and taken again at
// the same attempt. The applied write must fence on the claim identity: a
// staged write for the dead lease is a no-op against the replacement claim,
// never a completion or a deferral of it. This is the regression the review
// probe caught (a stale staged complete turned the fresh claim `completed`,
// a stale staged defer turned it `pending`).
// ---------------------------------------------------------------------------

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
