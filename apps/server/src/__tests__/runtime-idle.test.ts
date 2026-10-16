// ANY-100 R17 — the server's idle posture. Z1: an idle runWorker, the purge
// loop and a started runtime's rt.stop() all return promptly when their signal
// aborts, on the 10-minute backstop. Z7: the full daemon's idle statement
// budget on Postgres, via pg_stat_database transaction counters. Z8: the
// RUNTIME_IDLE_BACKSTOP_MS default and its named start-up error. Z9: a queue
// without claimWaiting keeps today's poll.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { append, runWorker, type Queue, type QueueJob, type QueueLease, type QueueTx } from "@fabric/runtime";
import { postgresUrlFromEnv } from "@fabric/runtime/testing";
import { runPurgeLoop } from "../runtime/purge";
import { runtimeIdleBackstopMs, startRuntime, type FabricRuntime, type RuntimeEnv } from "../runtime/bootstrap";

const BACKSTOP_MS = 600_000; // the card's 10 minutes
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Per-driver env plumbing: a fresh PGlite dir, or a fresh database. */
interface EnvKit {
  driver: "pglite" | "postgres";
  env: (runtimeEnv?: Partial<RuntimeEnv>) => Promise<RuntimeEnv>;
  dispose: () => Promise<void>;
}

function envKit(driver: "pglite" | "postgres"): EnvKit {
  if (driver === "pglite") {
    let dir: string | undefined;
    return {
      driver,
      env: async (extra = {}) => {
        dir ??= await mkdtemp(path.join(tmpdir(), "fabric-r17-server-"));
        return { RUNTIME_PGLITE_DIR: dir, MODEL_PORT: "test", ...extra } as RuntimeEnv;
      },
      dispose: async () => {
        if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  }
  const base = postgresUrlFromEnv();
  if (base === undefined) throw new Error("postgres leg without RUNTIME_TEST_DATABASE_URL");
  let admin: Pool | undefined;
  const databases: string[] = [];
  return {
    driver,
    env: async (extra = {}) => {
      admin ??= new Pool({ connectionString: new URL("/postgres", base).toString() });
      const database = `r17_srv_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
      await admin.query(`create database "${database}"`);
      databases.push(database);
      const url = new URL(`/${database}`, base).toString();
      return { RUNTIME_DATABASE_URL: url, MODEL_PORT: "test", ...extra } as RuntimeEnv;
    },
    dispose: async () => {
      for (const database of databases) {
        await admin
          ?.query(`drop database if exists "${database}" with (force)`)
          .catch(() => undefined);
      }
      await admin?.end().catch(() => undefined);
    },
  };
}

function serverCases(kit: () => EnvKit, testTimeout: number): void {
  let kitInstance: EnvKit | null = null;
  afterEach(async () => {
    const taken = kitInstance;
    kitInstance = null;
    await taken?.dispose();
  });
  const fresh = (): EnvKit => (kitInstance ??= kit());

  it(
    "Z1 abort: an idle runWorker, the purge loop and rt.stop return on signal",
    { timeout: testTimeout },
    async () => {
      const kitInstance = fresh();
      const runtime = await startRuntime(await kitInstance.env(), { worker: false });

      // Both loops parked on their idle wait before the abort.
      const controller = new AbortController();
      const worker = runWorker({
        store: runtime.store,
        queue: runtime.queue,
        ports: { surface: { send: async () => ({}) } },
        workerId: "z1-worker",
        idleBackstopMs: BACKSTOP_MS,
        signal: controller.signal,
      });
      const purge = runPurgeLoop(
        runtime.store,
        runtime.queue,
        controller.signal,
        "z1-purge",
        1_000,
        BACKSTOP_MS
      );
      await sleep(60);

      const t0 = Date.now();
      controller.abort();
      await Promise.all([worker, purge]);
      expect(Date.now() - t0).toBeLessThanOrEqual(500);

      // A started server (workers on) stops within a second on an idle board.
      const served = await startRuntime(await kitInstance.env({ RUNTIME_IDLE_BACKSTOP_MS: String(BACKSTOP_MS) }));
      await sleep(60);
      const t1 = Date.now();
      await served.stop();
      expect(Date.now() - t1).toBeLessThanOrEqual(1_000);

      await runtime.stop();
    }
  );

  it("Z9 fallback: a queue without claimWaiting keeps the pollIntervalMs poll", { timeout: testTimeout }, async () => {
    const kitInstance = fresh();
    const runtime = await startRuntime(await kitInstance.env(), { worker: false });
    const streamId = "session:r17-z9";
    await runtime.store.transaction((tx) =>
      append(tx, "local", [
        {
          streamId,
          events: [{ type: "agent.message", actor: "dana", payload: { text: "fallback" } }],
        },
      ])
    );

    // The stub wraps a MemoryQueue's surface; the claim is the point: no
    // claimWaiting, so runWorker must keep today's poll at pollIntervalMs.
    const inner = new (await import("@fabric/runtime")).MemoryQueue();
    const stub = {
      enqueue: (tx: QueueTx, job: Parameters<Queue["enqueue"]>[1]) => inner.enqueue(tx, job),
      claim: (workerId: string, types: readonly string[], now: number) => inner.claim(workerId, types, now),
      heartbeat: (lease: QueueLease, now: number) => inner.heartbeat(lease, now),
      complete: (tx: QueueTx, lease: QueueLease) => inner.complete(tx, lease),
      fail: ((lease, error, options, now) =>
        inner.fail(lease, error, options, now)) as Queue["fail"],
      get: (jobId: string): Promise<QueueJob | null> => inner.get(jobId),
    } as unknown as Queue;

    const sentAt: number[] = [];
    const controller = new AbortController();
    const worker = runWorker({
      store: runtime.store,
      queue: stub,
      ports: {
        surface: {
          send: async () => {
            sentAt.push(Date.now());
            return {};
          },
        },
      },
      workerId: "z9-worker",
      pollIntervalMs: 80,
      signal: controller.signal,
    });
    await sleep(100); // the loop has polled empty and is sleeping

    const t0 = Date.now();
    await runtime.store.transaction((tx) =>
      stub.enqueue(tx, {
        type: "deliver",
        key: `deliver:agent-message:${streamId}:1:app`,
        streamId,
        workspaceId: "local",
      })
    );
    while (sentAt.length === 0 && Date.now() - t0 < 5_000) await sleep(10);
    controller.abort();
    await worker;

    // Claimed by a poll, not a wake: one idle poll interval, generously bound.
    expect(sentAt.length).toBe(1);
    expect(sentAt[0]! - t0).toBeGreaterThanOrEqual(60);
    expect(sentAt[0]! - t0).toBeLessThanOrEqual(2_000);
    await runtime.stop();
  });

  it("Z8 env: the backstop defaults to 600 000 and invalid values are named", () => {
    expect(runtimeIdleBackstopMs({})).toBe(600_000);
    expect(runtimeIdleBackstopMs({ RUNTIME_IDLE_BACKSTOP_MS: "600000" })).toBe(600_000);
    expect(runtimeIdleBackstopMs({ RUNTIME_IDLE_BACKSTOP_MS: 1_200_000 })).toBe(1_200_000);
    for (const invalid of ["0", "-1", "abc"]) {
      expect(() => runtimeIdleBackstopMs({ RUNTIME_IDLE_BACKSTOP_MS: invalid })).toThrow(
        /RUNTIME_IDLE_BACKSTOP_MS/
      );
    }
  });

  it(
    "Z8 env: startRuntime rejects an invalid RUNTIME_IDLE_BACKSTOP_MS, naming it",
    { timeout: testTimeout },
    async () => {
      const kitInstance = fresh();
      const env = await kitInstance.env({ RUNTIME_IDLE_BACKSTOP_MS: "0" });
      await expect(startRuntime(env, { worker: false })).rejects.toThrow(/RUNTIME_IDLE_BACKSTOP_MS/);
    }
  );
}

describe("R17 server idle posture [pglite]", () => {
  serverCases(() => envKit("pglite"), 30_000);
});

if (postgresUrlFromEnv() !== undefined) {
  describe("R17 server idle posture [postgres]", () => {
    serverCases(() => envKit("postgres"), 30_000);

    it(
      "Z7 (Postgres) budget: the idle daemon's statements stay inside the backstop's bound",
      { timeout: 180_000 },
      async () => {
        const url = new URL("/postgres", postgresUrlFromEnv()!).toString();
        const admin = new Pool({ connectionString: url });
        const settleAndQuiet = async (dbUrl: string) => {
          // The budget counts this database's transactions; the boot window's
          // vacuum/analyze dust would pollute it, so the tables go quiet and the
          // window starts late (start-up settles).
          const db = new Pool({ connectionString: dbUrl });
          try {
            const tables = (
              await db.query(`select tablename from pg_tables where schemaname = 'public'`)
            ).rows.map((row: { tablename: string }) => `"${row.tablename}"`);
            for (const table of tables) {
              await db
                .query(`alter table ${table} set (autovacuum_enabled = off, toast.autovacuum_enabled = off)`)
                .catch(() => undefined);
            }
            // The boot's DDL bumps catalog stats; autovacuum would answer with
            // an ANALYZE wave (pg_constraint & co) inside the window. Analyze
            // here instead: the counters reset, the launcher finds nothing.
            await db.query(`analyze`).catch(() => undefined);
            for (const catalog of ["pg_class", "pg_index", "pg_attribute", "pg_type", "pg_constraint"]) {
              await db.query(`analyze pg_catalog.${catalog}`).catch(() => undefined);
            }
          } finally {
            await db.end().catch(() => undefined);
          }
          await sleep(15_000);
        };
        try {
          const database = `r17_budget_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
          await admin.query(`create database "${database}"`);
          const dbUrl = new URL(`/${database}`, postgresUrlFromEnv()!).toString();
          const xacts = async (): Promise<number> => {
            const result = await admin.query(
                `select xact_commit + xact_rollback as n from pg_stat_database where datname = $1`,
              [database]
            );
            return Number(result.rows[0]?.n ?? 0);
          };

          // The full daemon: 4 worker loops plus the purge claim loop, on the
          // 5 s test backstop, then on the default, measured via the
          // database's transaction counters (the builder's choice, per card).
          const runtime = await startRuntime(
            {
              RUNTIME_DATABASE_URL: dbUrl,
              MODEL_PORT: "test",
              RUNTIME_CONCURRENCY: 4,
              RUNTIME_IDLE_BACKSTOP_MS: "5000",
            } as RuntimeEnv
          );
          await settleAndQuiet(dbUrl);
          const before = await xacts();
          await sleep(30_000);
          const after = await xacts();
          await runtime.stop();
          const windowed = after - before;
          expect(windowed).toBeGreaterThanOrEqual(1);
          expect(windowed).toBeLessThanOrEqual(70); // 5 loops x 6 cycles x 2 + slack

          const runtimeDefault = await startRuntime({
            RUNTIME_DATABASE_URL: dbUrl,
            MODEL_PORT: "test",
            RUNTIME_CONCURRENCY: 4,
          } as RuntimeEnv);
          await settleAndQuiet(dbUrl);
          const beforeDefault = await xacts();
          await sleep(30_000);
          const afterDefault = await xacts();
          await runtimeDefault.stop();
          expect(afterDefault - beforeDefault).toBeLessThanOrEqual(5);

          await admin.query(`drop database if exists "${database}" with (force)`);
        } finally {
          await admin.end().catch(() => undefined);
        }
      }
    );
  });
}

void (undefined as unknown as FabricRuntime | undefined);
