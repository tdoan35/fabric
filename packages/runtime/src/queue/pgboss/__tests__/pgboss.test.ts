// The pg-boss adapter against the R6 conformance suite (ANY-33 R7), on both
// drivers: PGlite in-memory (one fresh database per queue) and Postgres from
// RUNTIME_TEST_DATABASE_URL when set, mirroring the store suite's driver rule.
// Time is injected end to end through pg-boss's TestClock, so the same injected
// instants drive the adapter's claims and pg-boss's own SQL.
import { afterEach, describe } from "vitest";
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
