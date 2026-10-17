// ANY-100 R17 — the idle wait: an idle `runWorker` sleeps on the queue's wake,
// the next due time or the backstop, instead of polling. Z2 pins the wake, Z3
// the due time and the retry backoff, Z4 the dead-lease reclaim — each against
// a real queue on the same database as the store (the bootstrap shape), on both
// drivers, with the card's 10-minute backstop and real clocks.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { append, openStore, type EventInput, type RuntimeStore } from "../../index";
import { postgresUrlFromEnv } from "../../testing/drivers";
import { PgQueue } from "../../queue/pg";
import { runWorker } from "../../workers/loop";

const PG_URL = postgresUrlFromEnv();
const WORKSPACE = "ws-r17";
const BACKSTOP_MS = 600_000; // the card's 10 minutes; never reached in these tests
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One store + one queue on the same backend, fresh per test. */
interface Stack {
  store: RuntimeStore;
  queue: PgQueue;
  dispose: () => Promise<void>;
}

/** The per-type overrides these cases read: the card's 1.5 s retry backoff and
 * a short heartbeat so a silent holder's lease laps within the test. */
const TYPE_CONFIGS = { deliver: { retryBackoffMs: 1500, heartbeatMs: 300, maxRunMs: 5000 } };

function pgliteStack(): Promise<Stack> {
  return (async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fabric-r17-"));
    const store = await openStore({ driver: "pglite", dataDir: dir });
    // The queue rides the store's own connection, exactly as the server's
    // bootstrap wires it: standalone statements run as single-statement
    // transactions on the serialized chain; handler-owned statements are
    // the handler's tx already.
    const queue = new PgQueue({
      connection: {
        kind: "pglite",
        pglite: {
          query: async (text: string, values: unknown[] = []) => {
            // Yield the loop: back-to-back claims must not starve timers.
            await new Promise((resolve) => setImmediate(resolve));
            return { rows: await store.transaction((tx) => tx.query(text, values as never)) };
          },
        },
      },
      typeConfigs: TYPE_CONFIGS,
    });
    // Warm the queue before anything else runs (bootstrap's own rule): the
    // one-time schema init takes the same serialized path as every other
    // statement, and a concurrent store transaction would queue behind it.
    await queue.get("warm-up");
    return {
      store,
      queue,
      dispose: async () => {
        await queue.close().catch(() => undefined);
        await store.close();
        await rm(dir, { recursive: true, force: true });
      },
    };
  })();
}

function postgresStack(url: string): Promise<Stack> {
  return (async () => {
    const store = await openStore({ driver: "postgres", url });
    const queue = new PgQueue({
      connection: { kind: "postgres", connectionString: url },
      typeConfigs: TYPE_CONFIGS,
    });
    await queue.get("warm-up");
    return {
      store,
      queue,
      dispose: async () => {
        await queue.close().catch(() => undefined);
        await store.close();
      },
    };
  })();
}

const agentMessage = (text: string): EventInput => ({
  type: "agent.message",
  actor: "dana",
  payload: { text },
});

async function seedMessageStream(store: RuntimeStore, streamId: string, text: string): Promise<void> {
  await store.transaction((tx) => append(tx, WORKSPACE, [{ streamId, events: [agentMessage(text)] }]));
}

/** The deliver idempotency key of turn 1 on `streamId`, to the app surface. */
const deliverKey = (streamId: string): string => `deliver:agent-message:${streamId}:1:app`;

/** The SurfacePort double: records the wall clock of every send attempt, hands
 * each to a waiter, and fails the first attempt of the named keys (Z3's
 * retryable delivery) before succeeding. */
class ScriptedSurface {
  readonly sentAt: number[] = [];
  #waiters: ((at: number) => void)[] = [];
  #attempts = new Map<string, number>();
  constructor(private readonly failOnce: readonly string[] = []) {}

  waitSend(): Promise<number> {
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  async send(
    _target: string,
    _message: { text: string },
    options?: { idempotencyKey?: string }
  ): Promise<{ platformMessageId: string }> {
    const at = Date.now();
    this.sentAt.push(at);
    this.#waiters.shift()?.(at);
    const key = options?.idempotencyKey ?? "";
    const attempt = this.#attempts.get(key) ?? 0;
    this.#attempts.set(key, attempt + 1);
    if (key !== "" && this.failOnce.includes(key) && attempt === 0) {
      throw new Error(`scripted failure: ${key}`);
    }
    return { platformMessageId: `pm-${this.sentAt.length}` };
  }
}

type StackFactory = () => Promise<Stack>;

/** The shared cases; each describe is one driver. */
function idleWaitCases(makeStack: () => Promise<Stack>, testTimeout: number): void {
  let stack: Stack | null = null;
  afterEach(async () => {
    const taken = stack;
    stack = null;
    await taken?.dispose().catch(() => undefined);
  });
  const fresh = async (): Promise<Stack> => (stack ??= await makeStack());

      it(
    "Z2 wake: a commit's enqueue is claimed within 100 ms, at the p95 of 20 trials",
    { timeout: 45_000 },
    async () => {
      const { store, queue } = await fresh();
      const streamId = "session:r17-z2";
      await seedMessageStream(store, streamId, "wake me");

      const surface = new ScriptedSurface();
      const controller = new AbortController();
      const worker = runWorker({
        store,
        queue,
        ports: { surface },
        workerId: "z2-worker",
        idleBackstopMs: BACKSTOP_MS,
        signal: controller.signal,
      });
      await sleep(50); // the loop has run empty once and parked on its wait

      const deltas: number[] = [];
      for (let trial = 0; trial < 20; trial++) {
        const sent = surface.waitSend();
        const before = Date.now();
        await store.transaction((tx) =>
          queue.enqueue(tx, {
            type: "deliver",
            key: `${deliverKey(streamId)}:${trial}`,
            streamId,
            workspaceId: WORKSPACE,
          })
        );
        const committedAt = Date.now();
        const sentAt = await sent;
        deltas.push(sentAt - committedAt);
        void before;
        await sleep(30); // the loop has reclaimed its idle wait
      }

      controller.abort();
      await worker;

      deltas.sort((a, b) => a - b);
      const p95 = deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * 0.95))];
      expect(p95).toBeLessThanOrEqual(100);
    }
  );

  it(
    "Z3 due time: a future runAt, and a retryable failure's backoff, are honoured",
    { timeout: testTimeout },
    async () => {
      const { store, queue } = await fresh();
      const streamId = "session:r17-z3";
      await seedMessageStream(store, streamId, "later");

      const retryKey = `${deliverKey(streamId)}:retry`;
      const surface = new ScriptedSurface([retryKey]);
      const controller = new AbortController();
      const worker = runWorker({
        store,
        queue,
        ports: { surface },
        workerId: "z3-worker",
        idleBackstopMs: BACKSTOP_MS,
        signal: controller.signal,
      });
      await sleep(50);

      // (a) runAt = now + 1500: claimed no earlier than runAt, within +250 ms.
      const enqueuedAt = Date.now();
      const runAt = enqueuedAt + 1500;
      await store.transaction((tx) =>
        queue.enqueue(tx, {
          type: "deliver",
          key: `${deliverKey(streamId)}:future`,
          streamId,
          workspaceId: WORKSPACE,
          runAt,
        })
      );
      const futureAt = await surface.waitSend();

      // (b) a retryable failure re-claims within the same window after the
      // refreshed run_at (the type's 1 500 ms backoff).
      await sleep(30);
      const retrySent = surface.waitSend(); // first attempt, fails
      const retried = surface.waitSend(); // the retry, succeeds
      await store.transaction((tx) =>
        queue.enqueue(tx, {
          type: "deliver",
          key: retryKey,
          streamId,
          workspaceId: WORKSPACE,
        })
      );
      const failedAt = await retrySent;
      const retriedAt = await retried;

      controller.abort();
      await worker;

      expect(futureAt).toBeGreaterThanOrEqual(runAt);
      expect(futureAt - enqueuedAt).toBeLessThanOrEqual(1500 + 250);
      expect(retriedAt - failedAt).toBeGreaterThanOrEqual(1500 - 100);
      expect(retriedAt - failedAt).toBeLessThanOrEqual(1500 + 250);
    }
  );

  it(
    "Z4 reclaim: a lease whose worker stopped heartbeating is reclaimed within 250 ms of its expiry",
    { timeout: testTimeout },
    async () => {
      const { store, queue } = await fresh();
      const streamId = "session:r17-z4";
      await seedMessageStream(store, streamId, "hand me over");
      const surface = new ScriptedSurface();

      // The job exists; the holder claims it before any worker runs, so the
      // holder's lease is the one that laps.
      await store.transaction((tx) =>
        queue.enqueue(tx, {
          type: "deliver",
          key: deliverKey(streamId),
          streamId,
          workspaceId: WORKSPACE,
        })
      );
      const holderClaimedAt = Date.now();
      const held = await queue.claim("z4-holder", ["deliver"], holderClaimedAt);
      expect(held).not.toBeNull();
      const leaseUntil = holderClaimedAt + 300;

      // The idle loop reclaims once the holder's window laps; the holder
      // never heartbeats.
      const controller = new AbortController();
      const worker = runWorker({
        store,
        queue,
        ports: { surface },
        workerId: "z4-worker",
        idleBackstopMs: BACKSTOP_MS,
        signal: controller.signal,
      });

      const reclaimedAt = await surface.waitSend();
      controller.abort();
      await worker;

      expect(reclaimedAt - leaseUntil).toBeGreaterThanOrEqual(-100);
      expect(reclaimedAt - leaseUntil).toBeLessThanOrEqual(250);
    }
  );
}

describe("R17 idle-wait worker [pglite]", () => {
  idleWaitCases(pgliteStack, 15_000);
});

if (PG_URL !== undefined) {
  describe("R17 idle-wait worker [postgres]", () => {
    const base = PG_URL as string;
    let admin: Pool | undefined;
    let database: string | undefined;

    async function makeStack(): Promise<Stack> {
      admin ??= new Pool({ connectionString: new URL("/postgres", base).toString() });
      database = `r17_idle_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
      await admin.query(`create database "${database}"`);
      const url = new URL(`/${database}`, base).toString();
      const stack = await postgresStack(url);
      return {
        ...stack,
        dispose: async () => {
          await stack.dispose();
          if (database !== undefined) {
            await admin
              ?.query(`drop database if exists "${database}" with (force)`)
              .catch(() => undefined);
            database = undefined;
          }
        },
      };
    }

    idleWaitCases(makeStack, 15_000);
  });
}
