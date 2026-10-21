// ANY-100 R17 — claimWaiting as the idle-wait primitive, on Postgres where the
// cross-process legs live: Z5 pins that a lost wake (the NOTIFY suppressed on
// the writing queue) still claims within the backstop, Z6 that a dropped
// LISTEN connection is re-established lazily, on the next claim and never on a
// timer, after which the wake path works again, and Z6b that a claim finding
// that reconnect in flight awaits it instead of claiming ahead of the LISTEN.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { postgresUrlFromEnv } from "../../testing/drivers";
import { PgQueue } from "../pg";

const PG_URL = postgresUrlFromEnv();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A QueueTx whose commit applies at once (the R8 suite's shape). */
function nowTx() {
  const hooks: (() => unknown)[] = [];
  return {
    onCommit: (hook: () => unknown) => void hooks.push(hook),
    commit: () => {
      const run = [...hooks];
      hooks.length = 0;
      for (const hook of run) hook();
    },
  };
}

const queueOptions = (): { connection: { kind: "postgres"; connectionString: string }; generateId: () => string } => ({
  connection: { kind: "postgres", connectionString: "" }, // replaced per queue
  generateId: () => `qjob-${randomUUID()}`,
});
void queueOptions;

(PG_URL === undefined ? describe.skip : describe)("R17 queue claimWaiting [postgres]", () => {
  const dispose: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const close of dispose.splice(0).reverse()) await close().catch(() => undefined);
  });

  /** A fresh database per case; every queue in the case shares it. */
  async function withSharedDb(run: (url: string) => Promise<void>): Promise<void> {
    const admin = new Pool({ connectionString: new URL("/postgres", PG_URL!).toString() });
    const database = `r17_cw_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const url = new URL(`/${database}`, PG_URL!).toString();
    await admin.query(`create database "${database}"`);
    try {
      await run(url);
    } finally {
      await admin.query(`drop database if exists "${database}" with (force)`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  }

  const makeQueue = (url: string, options: Partial<ConstructorParameters<typeof PgQueue>[0]> = {}) => {
    const queue = new PgQueue({
      connection: { kind: "postgres", connectionString: url },
      generateId: () => `qjob-${randomUUID()}`,
      ...options,
    });
    dispose.push(() => queue.close().catch(() => undefined));
    return queue;
  };

  /** The listener's backend pid via pg_stat_activity (its last statement is
   * the LISTEN itself, so the marker is unique to that connection). Scoped to
   * this database: pg_stat_activity is cluster-global, and the same channel
   * name is LISTENed in every other test database (this suite's other cases,
   * the R8 suite, other lanes on a shared server). */
  const listenerPids = (admin: Pool): Promise<number[]> =>
    admin
      .query(
        `select pid from pg_stat_activity where datname = current_database() and query like 'listen fabric_queue_wake%'`,
      )
      .then((r) => r.rows.map((row: { pid: number }) => Number(row.pid)));

  it("Z5 (Postgres) a lost wake still claims within the backstop", async () => {
    await withSharedDb(async (url) => {
      const listener = makeQueue(url);
      // The writer's NOTIFY leg is suppressed: the cross-process wake cannot
      // fire, so only the backstop can deliver the job (the test hook).
      const writer = makeQueue(url, { wakeNotify: false });
      await writer.get("warm-up"); // settle the schema before anyone listens

      const backstopMs = 1_000;
      const waiting = listener.claimWaiting("worker-1", ["deliver"], {
        backstopMs,
        now: () => Date.now(),
      });
      await sleep(100); // the first claim ran empty; the waiter is parked

      const tx = nowTx();
      const job = await writer.enqueue(tx, {
        type: "deliver",
        key: "deliver:z5:lost-wake",
        workspaceId: "ws-z5",
      });
      const enqueuedAt = Date.now();
      tx.commit();
      const lease = await waiting;
      const claimedAt = Date.now();

      expect(lease?.jobId).toBe(job.id);
      // The wake was suppressed: the claim waited out the backstop, not a
      // NOTIFY that (unsuppressed) would have landed in single-digit ms.
      const latency = claimedAt - enqueuedAt;
      expect(latency).toBeGreaterThanOrEqual(backstopMs - 300);
      expect(latency).toBeLessThanOrEqual(backstopMs + 250);
    });
  });

  it(
    "Z6 (Postgres) the LISTEN connection is re-established lazily, on the next claim",
    { timeout: 20_000 },
    async () => {
      await withSharedDb(async (url) => {
        const admin = new Pool({ connectionString: url });
        // withSharedDb's finally drops this database `with (force)`, which
        // terminates this pool's idle clients; the Pool re-emits the FATAL as
        // an `error` event, uncaught without a listener (same guard PgQueue
        // puts on its own pools).
        admin.on("error", () => undefined);
        dispose.push(() => admin.end().catch(() => undefined));

        const listener = makeQueue(url);
        await listener.get("warm-up"); // init, schema, the first LISTEN
        await sleep(50);
        let pids = await listenerPids(admin);
        expect(pids.length).toBe(1);

        // The listener's backend dies; the queue must not re-LISTEN eagerly.
        await admin.query(`select pg_terminate_backend($1)`, [pids[0]]);
        await sleep(300);
        expect(await listenerPids(admin)).toEqual([]);
        await sleep(700); // no timer, no background reconnect
        expect(await listenerPids(admin)).toEqual([]);

        // The next claim re-LISTENs; the wake path works again afterwards.
        const waiting = listener.claimWaiting("worker-1", ["deliver"], {
          backstopMs: 5_000,
          now: () => Date.now(),
        });
        await sleep(150); // the cycle's claim has re-established the listener
        pids = await listenerPids(admin);
        expect(pids.length).toBe(1); // RED: the re-LISTEN on claim is missing

        const writer = makeQueue(url);
        await writer.get("warm-up");
        const tx = nowTx();
        const job = await writer.enqueue(tx, {
          type: "deliver",
          key: "deliver:z6:lazy-listen",
          workspaceId: "ws-z6",
        });
        const enqueuedAt = Date.now();
        tx.commit();
        const lease = await waiting;

        expect(lease?.jobId).toBe(job.id);
        expect(Date.now() - enqueuedAt).toBeLessThanOrEqual(100);
      });
    }
  );

  it(
    "Z6b (Postgres) recovery is shared, not skipped: concurrent typed waits await the reconnect",
    { timeout: 20_000 },
    async () => {
      await withSharedDb(async (url) => {
        const admin = new Pool({ connectionString: url });
        admin.on("error", () => undefined); // see Z6
        dispose.push(() => admin.end().catch(() => undefined));

        // The reconnect is held open between its connect and its LISTEN (the
        // test hook) so both claims overlap it deterministically; init's own
        // LISTEN is not a reconnect and is never held.
        let release!: () => void;
        const hold = new Promise<void>((resolve) => (release = resolve));
        let relistens = 0;
        let reconnecting!: () => void;
        const reconnectStarted = new Promise<void>((resolve) => (reconnecting = resolve));
        const listener = makeQueue(url, {
          beforeRelisten: () => {
            relistens += 1;
            reconnecting();
            return hold;
          },
        });
        await listener.get("warm-up");
        await sleep(50);
        const pids = await listenerPids(admin);
        expect(pids.length).toBe(1);
        await admin.query(`select pg_terminate_backend($1)`, [pids[0]]);
        await sleep(1_000); // as Z6: the client has seen its connection end
        expect(await listenerPids(admin)).toEqual([]);
        const writer = makeQueue(url); // its own LISTEN comes after the probe
        await writer.get("warm-up");

        const backstopMs = 600_000;
        const claimedAt: Record<string, number> = {};
        const loop = (workerId: string, type: string) =>
          listener
            .claimWaiting(workerId, [type], { backstopMs, now: () => Date.now() })
            .then((lease) => {
              claimedAt[type] = Date.now();
              return lease;
            });
        // Loop A's claim starts the reconnect; loop B's claim finds it in flight.
        const alphaLoop = loop("worker-a", "alpha");
        const started = await Promise.race([
          reconnectStarted.then(() => true),
          sleep(5_000).then(() => false),
        ]);
        expect(started).toBe(true); // A's claim really is re-LISTENing
        const betaLoop = loop("worker-b", "beta");
        await sleep(100);
        // Only the writer is LISTENing; the held reconnect has not installed
        // the reader's subscription yet, so beta's NOTIFY really can be lost.
        expect(await listenerPids(admin)).toHaveLength(1);

        // B's job commits while the reconnect is still open: its NOTIFY has no
        // listener. Only a claim that ran after the re-LISTEN can see it.
        const betaTx = nowTx();
        const beta = await writer.enqueue(betaTx, { type: "beta", key: "beta:z6b", workspaceId: "ws-z6b" });
        const betaCommitAt = Date.now();
        betaTx.commit();
        expect(await writer.get(beta.id)).not.toBeNull(); // inserted and NOTIFYed
        release();

        // Both loops settle; A parks on the wake. Nothing but A's job wakes B
        // now, so a B that claimed before the re-LISTEN shows up late here.
        await sleep(300);
        const alphaTx = nowTx();
        const alpha = await writer.enqueue(alphaTx, { type: "alpha", key: "alpha:z6b", workspaceId: "ws-z6b" });
        const alphaCommitAt = Date.now();
        alphaTx.commit();

        const [alphaLease, betaLease] = await Promise.all([alphaLoop, betaLoop]);
        expect(alphaLease?.jobId).toBe(alpha.id);
        expect(betaLease?.jobId).toBe(beta.id);
        expect(claimedAt.beta! - betaCommitAt).toBeLessThanOrEqual(100);
        expect(claimedAt.alpha! - alphaCommitAt).toBeLessThanOrEqual(100);
        expect(relistens).toBe(1); // one shared reconnect, serialized per instance
        expect(await listenerPids(admin)).toHaveLength(2); // reader and writer
      });
    }
  );
});

// The horizon race behind CI's Z4 timeout: a lease lapsing between the empty
// claim and the horizon query must still be the horizon. A scripted clock puts
// the claim before the lease's expiry and every later read after it.
describe("R17 queue claimWaiting [pglite]", () => {
  it("Z4b a lease lapsing between the empty claim and the horizon query is reclaimed at once", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const pglite = new PGlite();
    try {
      const queue = new PgQueue({
        connection: { kind: "pglite", pglite },
        typeConfigs: { deliver: { heartbeatMs: 300, maxRunMs: 5000 } },
      });
      const tx = nowTx();
      const queued = await queue.enqueue(tx as never, { type: "deliver", key: "z4b", streamId: "s", workspaceId: "ws" });
      tx.commit();
      expect(await queue.claim("holder", ["deliver"], 1_000)).not.toBeNull(); // lease_until = 1300

      const reads = [1_100]; // the claim's now; every later read is past the lease
      const now = () => reads.shift() ?? 1_400;
      const controller = new AbortController();
      const bounded = setTimeout(() => controller.abort(), 1_000);
      const lease = await queue.claimWaiting("reclaimer", ["deliver"], {
        backstopMs: 600_000,
        now,
        signal: controller.signal,
      });
      clearTimeout(bounded);
      expect(lease?.jobId).toBe(queued.id);
      await queue.close();
    } finally {
      await pglite.close();
    }
  });
});
