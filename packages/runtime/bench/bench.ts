// The ANY-33 R7 queue probe: docs/RUNTIME.md §14's four measurements per
// driver, plus the conformance verdict the decision rule consumes.
//
//   npm run bench:queue -w @fabric/runtime [-- --driver pglite|postgres|both]
//
// Runs against in-process PGlite and the local Postgres only. One JSON object
// per driver:
//   { driver, conformance, pickup {p50,p95,n}, serialOverlaps,
//     idleQueriesPerMinute, deadWorkerHandoverMs }
// - pickup: enqueue->claim over 300 deliver jobs paced 10 ms; the claimer wakes
//   on the insert's LISTEN/NOTIFY with a 25 ms poll backstop.
// - serialOverlaps: decide leases of one stream held at once across 4 lanes
//   (200 jobs, 8 streams); the conformance says 0.
// - idleQueriesPerMinute: statements over 5 min, empty queue, one idle
//   claimer on the same notify + 1 s backstop loop.
// - deadWorkerHandoverMs: A claims an llm.call, never heartbeats; time to B's
//   claim. The lease is the 60 s heartbeat window.
import { Client } from "pg";
import { PGlite } from "@electric-sql/pglite";
import { TestClock } from "pg-boss";
import { PgBossQueue, notifyChannelFor } from "../src/queue/pgboss/index";
import type { QueueTx } from "../src/queue/types";
import { queueConformanceCases } from "../src/queue/conformance";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1]! : fallback;
};
const driverArg = arg("driver", "both");
const pgUrl = arg(
  "pg",
  process.env.RUNTIME_TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:55488/runtime_test",
);

const PICKUP_JOBS = 300;
const SERIAL_JOBS = 200;
const SERIAL_STREAMS = 8;
const SERIAL_LANES = 4;
const IDLE_MS = 5 * 60 * 1000;
const PICKUP_BACKSTOP_MS = 25;
const IDLE_BACKSTOP_MS = 3000;

const percentile = (xs: number[], p: number) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] * 10) / 10;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Wake {
  start(channel: string): Promise<void>;
  wait(ms: number): Promise<void>;
  close(): Promise<void>;
}

class PgWake implements Wake {
  #client = new Client({ connectionString: pgUrl });
  #resolvers: (() => void)[] = [];
  async start(channel: string): Promise<void> {
    await this.#client.connect();
    await this.#client.query(`LISTEN ${channel}`);
    this.#client.on("notification", () => {
      for (const resolve of this.#resolvers.splice(0)) resolve();
    });
  }
  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.#resolvers.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  async close(): Promise<void> {
    await this.#client.end().catch(() => {});
  }
}

type ListeningPglote = PGlite & {
  listen?: (channel: string, onEvent: () => void) => Promise<() => Promise<void>>;
};

class PgLiteWake implements Wake {
  #resolvers: (() => void)[] = [];
  #unlisten: (() => Promise<void>) | null = null;
  constructor(private pglite: ListeningPglote) {}
  async start(channel: string): Promise<void> {
    if (!this.pglite.listen) return;
    this.#unlisten = await this.pglite.listen(channel, () => {
      for (const resolve of this.#resolvers.splice(0)) resolve();
    });
  }
  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.#resolvers.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  async close(): Promise<void> {
    await this.#unlisten?.();
  }
}

/** A commit-on-demand tx: the QueueTx contract, one object. */
function benchTx(): QueueTx & { commit(): void } {
  const hooks: (() => unknown)[] = [];
  return {
    onCommit: (hook) => void hooks.push(hook),
    commit: () => {
      const run = [...hooks];
      hooks.length = 0;
      for (const hook of run) hook();
    },
  };
}

/** complete buffered into the tx, committed, and waited out to `completed`. */
async function settleComplete(queue: PgBossQueue, lease: { jobId: string }) {
  const tx = benchTx();
  await queue.complete(tx, lease as never);
  tx.commit();
  for (let i = 0; i < 100; i++) {
    const job = await queue.get(lease.jobId);
    if (job?.status === "completed") return;
    await sleep(1);
  }
  throw new Error(`job ${lease.jobId} never completed`);
}

async function runConformance(make: (options: import("../src/queue/types").QueueOptions) => PgBossQueue) {
  const passed: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const testCase of queueConformanceCases) {
    const created: PgBossQueue[] = [];
    try {
      await testCase.run((options) => {
        const queue = make(options ?? {});
        created.push(queue);
        return queue;
      });
      passed.push(testCase.id);
    } catch (error) {
      failed.push({ id: testCase.id, error: String((error as Error)?.message ?? error).slice(0, 160) });
    }
    for (const queue of created) await queue.close();
  }
  return { passed, failed };
}

interface DriverResult {
  driver: string;
  conformance: { passed: string[]; failed: { id: string; error: string }[] };
  pickup: { p50: number; p95: number; n: number };
  serialOverlaps: number;
  idleQueriesPerMinute: number;
  deadWorkerHandoverMs: number;
}

async function benchDriver(driver: "pglite" | "postgres", index: number): Promise<DriverResult> {
  const trace = (m: string) => process.stderr.write(`[bench ${driver}] ${m}\n`);
  trace("start");
  const closeFns: (() => Promise<void>)[] = [];
  let seq = 0;
  const newOpts = (tags: string): ConstructorParameters<typeof PgBossQueue>[0] =>
    driver === "pglite"
      ? { connection: { kind: "pglite", pglite: new PGlite() } }
      : {
          connection: { kind: "postgres", connectionString: pgUrl },
          schema: `pgboss_b${index}_${tags}_${process.pid}_${seq++}`,
        };
  const makeQueue = (opts: ConstructorParameters<typeof PgBossQueue>[0]) => {
    const queue = new PgBossQueue(opts);
    closeFns.push(() => queue.close());
    return queue;
  };

  // Conformance: the suite's shape, a fresh backend per case, TestClock time.
  const conformance = await runConformance((options) =>
    makeQueue({ ...newOpts("conf"), testClock: new TestClock(0), ...options }),
  );
  trace(`conformance done: ${conformance.passed.length} passed, ${conformance.failed.length} failed`);

  // The measured instance: its own backend, a statement counter, a wake listener.
  let queryCount = 0;
  const measuredOpts = newOpts("measured");
  const queue = makeQueue({ ...measuredOpts, onQuery: () => void ++queryCount });
  const channel = notifyChannelFor(
    driver === "pglite" ? "pgboss" : (measuredOpts as { schema: string }).schema!,
  );
  const wake: Wake =
    driver === "pglite"
      ? new PgLiteWake((measuredOpts!.connection as { kind: "pglite"; pglite: ListeningPglote }).pglite)
      : new PgWake();
  await wake.start(channel);
  trace("wake listening");

  // -- pickup: enqueue->claim under a notify-woken claimer ------------------
  const enqueueAt = new Map<string, number>();
  const latencies: number[] = [];
  let claimed = 0;
    const claimer = (async () => {
    while (claimed < PICKUP_JOBS) {
      const lease = await queue.claim("pickup", ["deliver"], Date.now());
      if (lease) {
        const t0 = enqueueAt.get(lease.jobId);
        if (t0 !== undefined) latencies.push(performance.now() - t0);
        claimed++;
        await settleComplete(queue, lease);
      } else {
        await wake.wait(PICKUP_BACKSTOP_MS);
      }
    }
  })();
  for (let i = 0; i < PICKUP_JOBS; i++) {
    const tx = benchTx();
    const job = await queue.enqueue(tx, {
      type: "deliver",
      key: `bench:${index}:pickup:${i}`,
      workspaceId: "bench",
    });
    enqueueAt.set(job.id, performance.now());
    tx.commit();
    await sleep(10);
  }
  await claimer;
  trace(`pickup done: n=${latencies.length}`);
  const pickup = { p50: percentile(latencies, 50), p95: percentile(latencies, 95), n: latencies.length };

  // -- serial-per-stream under parallel lanes -------------------------------
  const serialTx = benchTx();
  for (let i = 0; i < SERIAL_JOBS; i++) {
    await queue.enqueue(serialTx, {
      type: "decide",
      key: `bench:${index}:serial:${i}`,
      streamId: `serial-stream-${i % SERIAL_STREAMS}`,
      workspaceId: "bench",
    });
  }
  serialTx.commit();
  const intervals = new Map<string, [number, number][]>();
  let serialDone = 0;
  const perLane = SERIAL_JOBS / SERIAL_LANES;
  await Promise.all(
    Array.from({ length: SERIAL_LANES }, (_, lane) =>
      (async () => {
        let mine = 0;
        while (mine < perLane) {
          const lease = await queue.claim(`lane-${lane}`, ["decide"], Date.now());
          if (!lease) {
            await sleep(2);
            continue;
          }
          const start = performance.now();
          await sleep(5);
          await settleComplete(queue, lease);
          const list = intervals.get(lease.streamId ?? "?") ?? [];
          list.push([start, performance.now()]);
          intervals.set(lease.streamId ?? "?", list);
          mine++;
          serialDone++;
        }
      })(),
    ),
  );
  let serialOverlaps = 0;
  for (const spans of intervals.values()) {
    const sorted = [...spans].sort((a, b) => a[0]! - b[0]!);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i]![0] < sorted[i - 1]![1]) serialOverlaps++;
    }
  }
  trace(`serial done: overlaps=${serialOverlaps} of ${serialDone}`);
  if (serialDone !== SERIAL_JOBS) throw new Error(`serial phase incomplete: ${serialDone}`);

  // -- idle traffic: 5 minutes, empty queue, lazy claimer --------------------
  queryCount = 0;
  const idleEnd = Date.now() + IDLE_MS;
  while (Date.now() < idleEnd) {
    const lease = await queue.claim("idler", ["deliver"], Date.now());
    if (lease) await settleComplete(queue, lease);
    await wake.wait(IDLE_BACKSTOP_MS);
  }
  const idleQueriesPerMinute = Math.round((queryCount / (IDLE_MS / 60_000)) * 10) / 10;
  trace(`idle done: ${idleQueriesPerMinute} queries/min`);

  // -- dead-worker handover: claim, vanish, wait for the reclaim -------------
  const handoverTx = benchTx();
  const job = await queue.enqueue(handoverTx, {
    type: "llm.call",
    key: `bench:${index}:handover`,
    streamId: "bench-handover",
    workspaceId: "bench",
  });
  handoverTx.commit();
  let lease: Awaited<ReturnType<PgBossQueue["claim"]>> = null;
  while (!lease) {
    lease = await queue.claim("worker-a", ["llm.call"], Date.now());
    if (!lease) await sleep(20);
  }
  const diedAt = performance.now();
  // worker A is gone: no heartbeat, no complete, nothing.
  const deadline = Date.now() + 5 * 60_000;
  let handover: number | null = null;
  while (Date.now() < deadline) {
    const again = await queue.claim("worker-b", ["llm.call"], Date.now());
    if (again?.jobId === job.id) {
      handover = Math.round(performance.now() - diedAt);
      await settleComplete(queue, again);
      break;
    }
    if (again) await settleComplete(queue, again);
    await sleep(100);
  }
  if (handover === null) throw new Error("handover: never reclaimed");
  trace(`handover done: ${handover} ms`);

  await wake.close();
  await Promise.all(closeFns.map((close) => close()));
  return { driver, conformance, pickup, serialOverlaps, idleQueriesPerMinute, deadWorkerHandoverMs: handover };
}

const drivers: ("pglite" | "postgres")[] =
  driverArg === "both" ? ["pglite", "postgres"] : [driverArg as "pglite" | "postgres"];
const results: DriverResult[] = [];
for (const [index, driver] of drivers.entries()) {
  results.push(await benchDriver(driver, index));
}
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
