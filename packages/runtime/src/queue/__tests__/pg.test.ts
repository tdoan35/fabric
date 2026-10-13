// ANY-34 R8 — the durable Queue on the own `jobs` table, the 2026-10-12 decision
// in docs/RUNTIME.md §14. R8.1/R8.2 run the R6 conformance suite (Q1–Q12) on
// both drivers; R8.3–R8.6 are the card's cases. The Postgres leg runs whenever
// RUNTIME_TEST_DATABASE_URL is set and is mandatory under CI — the same guard
// the store suite uses, so a silently skipped Postgres leg can never pass.
//
// A fresh backend per queue (an in-memory PGlite, or a throwaway database on
// the shared server), mirroring the store suite's isolation: every conformance
// case starts from empty tables.
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { append, queueConformanceCases } from "../../index";
import type { EnqueuePort, QueueOptions } from "../../index";
import { migrate } from "../../store/migrate";
import { PgliteAdapter } from "../../store/pglite";
import { postgresUrlFromEnv } from "../../testing/drivers";
import { PgQueue } from "../pg";

const PG_URL = postgresUrlFromEnv();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const messageOf = (error: unknown) =>
  String((error as Error | undefined)?.message ?? error).slice(0, 300);

/** A QueueTx whose commit applies at once: for tests that drive one op per tx. */
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

const fact = () => ({
  type: "run.started",
  actor: "tester",
  payload: { objective: "objective" },
});

/** The R8.3 enqueue port: the store's bare `decide` job, keyed, scoped, recorded. */
interface TrackedPort extends EnqueuePort {
  jobIds: string[];
}

function trackedDecidePort(queue: PgQueue, workspaceId: string): TrackedPort {
  const jobIds: string[] = [];
  const port: EnqueuePort = async (tx, job) => {
    const queued = await queue.enqueue(tx, {
      type: job.type,
      streamId: job.streamId,
      key: `${job.type}:${job.streamId}`,
      workspaceId,
    });
    jobIds.push(queued.id);
  };
  return Object.assign(port, { jobIds });
}

// ---------------------------------------------------------------------------
// PGlite: an in-memory database per queue; the queue migrates it on first use.
// ---------------------------------------------------------------------------
describe("R8 durable queue [pglite]", () => {
  const dispose: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const close of dispose.splice(0).reverse()) await close().catch(() => undefined);
  });

  const makeQueue = (options?: QueueOptions): PgQueue => {
    const pglite = new PGlite();
    let seq = 0;
    const queue = new PgQueue({
      connection: { kind: "pglite", pglite },
      // Q7 pins the id sequence (qjob-1, qjob-2, ...): a per-instance counter.
      generateId: () => `qjob-${++seq}`,
      ...(options ?? {}),
    });
    dispose.push(() => pglite.close());
    return queue;
  };

  it("R8.1 runQueueConformance (R6 Q1–Q12) passes on PGlite", async () => {
    const failed: string[] = [];
    for (const testCase of queueConformanceCases) {
      try {
        await testCase.run(makeQueue);
      } catch (error) {
        failed.push(`${testCase.id}: ${messageOf(error)}`);
      }
    }
    expect(failed).toEqual([]);
  });

  it("R8.3 an appended fact and its decide job commit together; a rolled-back append leaves no job", async () => {
    const adapter = new PgliteAdapter();
    await migrate(adapter);
    const queue = makeQueueWith(adapter, dispose);
    const port = trackedDecidePort(queue, "ws-a");

    // Committed: the fact and its decide job land in one transaction.
    await adapter.transaction(async (tx) => {
      await append(tx, "ws-a", [{ streamId: "run:committed", events: [fact()] }], {
        enqueue: port,
      });
    });
    const lease = await queue.claim("worker-1", ["decide"], 0);
    expect(lease?.streamId).toBe("run:committed");
    expect(lease?.type).toBe("decide");

    // Rolled back: the append's transaction throws; no decide job exists.
    const beforeRollback = [...port.jobIds];
    await expect(
      adapter.transaction(async (tx) => {
        await append(tx, "ws-a", [{ streamId: "run:rolled", events: [fact()] }], {
          enqueue: port,
        });
        throw new Error("rollback now");
      })
    ).rejects.toThrow(/rollback/);
    const rolled = port.jobIds.find((id) => !beforeRollback.includes(id));
    expect(rolled).toBeDefined();
    await expect(queue.get(rolled!)).resolves.toBeNull();
    // ...and no claim surfaces for the rolled-back stream either.
    const next = await queue.claim("worker-2", ["decide"], 0);
    expect(next === null || next.streamId !== "run:rolled").toBe(true);
  });

  it("R8.5 a waiting worker claims an enqueued job without the polling backstop", async () => {
    const queue = makeQueue();
    const backstopMs = 60_000; // far longer than this test may run
    const started = Date.now();
    const waiting = queue.claimWaiting("worker-1", ["deliver"], {
      backstopMs,
      now: () => 0,
    });
    const tx = nowTx();
    const job = await queue.enqueue(tx, {
      type: "deliver",
      key: "deliver:wake:1",
      workspaceId: "ws-a",
    });
    tx.commit();
    const lease = await waiting;
    expect(lease?.jobId).toBe(job.id);
    expect(Date.now() - started).toBeLessThan(backstopMs / 2);
  });

  it("R8.6 a silent worker's lease laps in real time, shortened by per-type config", async () => {
    const queue = makeQueue({
      typeConfigs: { "llm.call": { heartbeatMs: 40, maxRunMs: 400 } },
    });
    const tx = nowTx();
    const job = await queue.enqueue(tx, {
      type: "llm.call",
      key: "llm:silence:1",
      streamId: "run:silence",
      workspaceId: "ws-a",
    });
    tx.commit();
    const held = await queue.claim("worker-a", ["llm.call"], Date.now());
    expect(held?.jobId).toBe(job.id);
    // still held moments later: the shortened 40 ms window has not lapsed
    await sleep(10);
    await expect(queue.claim("worker-b", ["llm.call"], Date.now())).resolves.toBeNull();
    // worker-a never heartbeats: the lease laps and worker-b takes over
    await sleep(80);
    const reclaimed = await queue.claim("worker-b", ["llm.call"], Date.now());
    expect(reclaimed?.jobId).toBe(job.id);
    expect(reclaimed?.attempt).toBe(2);
  });

  function makeQueueWith(pglite: unknown, sink: (() => Promise<void>)[]): PgQueue {
    let seq = 0;
    const queue = new PgQueue({
      connection: { kind: "pglite", pglite: pglite as never },
      generateId: () => `qjob-${++seq}`,
    });
    sink.push(() => (pglite as { close(): Promise<void> }).close());
    return queue;
  }
});

// ---------------------------------------------------------------------------
// Postgres: RUNTIME_TEST_DATABASE_URL when configured; mandatory under CI.
// ---------------------------------------------------------------------------
(PG_URL === undefined ? describe.skip : describe)("R8 durable queue [postgres]", () => {
  const dispose: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const close of dispose.splice(0).reverse()) await close().catch(() => undefined);
  });

  /** A throwaway database per queue, dropped on dispose — the store suite's isolation. */
  const makeQueue = (options?: QueueOptions): PgQueue => {
    const queue = new PgQueue({
      connection: { kind: "postgresAdmin", adminUrl: PG_URL! },
      generateId: (() => {
        let seq = 0;
        return () => `qjob-${++seq}`;
      })(),
      ...(options ?? {}),
    });
    dispose.push(() => queue.close());
    return queue;
  };

  /** A fresh database shared by everything opened inside `run`; dropped after. */
  async function withSharedDb(run: (url: string) => Promise<void>): Promise<void> {
    const admin = new Pool({ connectionString: PG_URL! });
    const database = `runtime_q_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    await admin.query(`create database "${database}"`);
    const url = new URL(PG_URL!);
    url.pathname = `/${database}`;
    dispose.push(async () => {
      await admin.query(`drop database if exists "${database}" with (force)`);
    });
    try {
      await run(url.toString());
    } finally {
      await admin.query(`drop database if exists "${database}" with (force)`);
    }
  }

  it("R8.2 runQueueConformance (R6 Q1–Q12) passes on Postgres", async () => {
    const failed: string[] = [];
    for (const testCase of queueConformanceCases) {
      try {
        await testCase.run(makeQueue);
      } catch (error) {
        failed.push(`${testCase.id}: ${messageOf(error)}`);
      }
    }
    expect(failed).toEqual([]);
  });

  it("R8.3 an appended fact and its decide job commit together; a rolled-back append leaves no job", async () => {
    await withSharedDb(async (url) => {
      const { openStore } = await import("../../index");
      const store = await openStore({ driver: "postgres", url });
      const queue = new PgQueue({
        connection: { kind: "postgres", connectionString: url },
        generateId: () => `qjob-${randomUUID()}`,
      });
      dispose.push(() => queue.close());
      const port = trackedDecidePort(queue, "ws-a");

      await store.transaction(async (tx) => {
        await append(tx, "ws-a", [{ streamId: "run:committed", events: [fact()] }], {
          enqueue: port,
        });
      });
      const lease = await queue.claim("worker-1", ["decide"], 0);
      expect(lease?.streamId).toBe("run:committed");

      const beforeRollback = [...port.jobIds];
      await expect(
        store.transaction(async (tx) => {
          await append(tx, "ws-a", [{ streamId: "run:rolled", events: [fact()] }], {
            enqueue: port,
          });
          throw new Error("rollback now");
        })
      ).rejects.toThrow(/rollback/);
      const rolled = port.jobIds.find((id) => !beforeRollback.includes(id));
      expect(rolled).toBeDefined();
      await expect(queue.get(rolled!)).resolves.toBeNull();
      const next = await queue.claim("worker-2", ["decide"], 0);
      expect(next === null || next.streamId !== "run:rolled").toBe(true);
    });
  });

  it("R8.4 two workers on separate connections split 50 jobs into disjoint, once-only claims", async () => {
    await withSharedDb(async (url) => {
      const queues = [0, 1, 2].map(
        () =>
          new PgQueue({
            connection: { kind: "postgres", connectionString: url },
            generateId: () => `qjob-${randomUUID()}`,
          })
      );
      dispose.push(() => Promise.all(queues.map((queue) => queue.close())));
      const [enqueuer, a, b] = queues;
      await enqueuer.get("warm-up"); // settle the schema before the second pool opens

      const tx = nowTx();
      for (let i = 0; i < 50; i++) {
        await enqueuer.enqueue(tx, {
          type: "deliver",
          key: `deliver:bulk:${i}`,
          workspaceId: "ws-bulk",
        });
      }
      tx.commit();

      const mine: string[][] = [[], []];
      const claimer = async (queue: PgQueue, claimed: string[]) => {
        for (;;) {
          const lease = await queue.claim("worker", ["deliver"], 0);
          if (!lease) return;
          claimed.push(lease.jobId);
          const done = nowTx();
          await queue.complete(done, lease);
          done.commit();
        }
      };
      await Promise.all([claimer(a, mine[0]), claimer(b, mine[1])]);

      const all = [...mine[0], ...mine[1]];
      expect(new Set(mine[0]).size).toBe(mine[0].length);
      expect(new Set(all).size).toBe(50);
      expect(all.length).toBe(50);
      const aHas = new Set(mine[0]);
      expect(mine[1].every((id) => !aHas.has(id))).toBe(true);
    });
  });

  it("R8.5 a waiting worker claims an enqueued job without the polling backstop", async () => {
    const queue = makeQueue();
    const backstopMs = 60_000;
    const started = Date.now();
    const waiting = queue.claimWaiting("worker-1", ["deliver"], {
      backstopMs,
      now: () => 0,
    });
    const tx = nowTx();
    const job = await queue.enqueue(tx, {
      type: "deliver",
      key: "deliver:wake:pg",
      workspaceId: "ws-a",
    });
    tx.commit();
    const lease = await waiting;
    expect(lease?.jobId).toBe(job.id);
    expect(Date.now() - started).toBeLessThan(backstopMs / 2);
  });

  it("R8.6 a silent worker's lease laps in real time, shortened by per-type config", async () => {
    const queue = makeQueue({
      typeConfigs: { "llm.call": { heartbeatMs: 40, maxRunMs: 400 } },
    });
    const tx = nowTx();
    const job = await queue.enqueue(tx, {
      type: "llm.call",
      key: "llm:silence:pg",
      streamId: "run:silence",
      workspaceId: "ws-a",
    });
    tx.commit();
    const held = await queue.claim("worker-a", ["llm.call"], Date.now());
    expect(held?.jobId).toBe(job.id);
    await sleep(10);
    await expect(queue.claim("worker-b", ["llm.call"], Date.now())).resolves.toBeNull();
    await sleep(80);
    const reclaimed = await queue.claim("worker-b", ["llm.call"], Date.now());
    expect(reclaimed?.jobId).toBe(job.id);
    expect(reclaimed?.attempt).toBe(2);
  });
});
