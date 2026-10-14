// ANY-80 R14 — `tool.exec` runs the tool OUTSIDE the store transaction. The
// single-transaction attempt stalls every other session on PGlite's one
// connection and holds a Postgres pool client (plus the stream's rows) for
// the whole call, and a `shell` longer than the 300 s lease loses it. The
// attempt splits around the run: read (done-guard / recovery / the call),
// run bare, record (done-guard again, then telemetry + completion + the
// re-decide + the lease completion). The port's io gains `workspaceId` and
// the folded `session.agentId`; the type's lease grows to `shell`'s maximum
// plus grace. X1 proves the stall on PGlite, X2 the free row on Postgres;
// everything else pins the recorded shape, the guards, the recovery, the
// io and the lease. Both drivers except where a case names one.
import { AssertionError } from "node:assert";
import { expect, test } from "vitest";
import { append, type EventInput } from "../../index";
import { MemoryQueue } from "../../queue/memory";
import { DEFAULT_TYPE_CONFIGS } from "../../queue/types";
import type { Queue, QueueJobInput, QueueLease, QueueTx } from "../../queue/types";
import type { ToolDescriptor, ToolPort, ToolRunResult } from "../../ports";
import type { RuntimeStore } from "../../store/types";
import { describeDrivers } from "../../testing/drivers";
import { handleToolExecJob } from "../../workers/tool-exec";

const WORKSPACE = "ws-r14";
const STREAM = "run:r14";
const OTHER = "run:r14-other";
const CALL = "c1";
const KEY = `${STREAM}:${CALL}`;
const DEADLINE_MS = 2_000;
const CRASH = "simulated crash after the handler's transaction ran";

// -- fixtures -------------------------------------------------------------------

const runCreated: EventInput = {
  type: "run.created",
  actor: "api",
  payload: {
    definition: { systemPrompt: "SYS", tools: ["sh"] },
    engineVersion: "v1",
    brief: "",
    grants: ["sh"],
    budgets: {},
    parent: null,
  },
};

const sessionCreated: EventInput = {
  type: "session.created",
  actor: "api",
  payload: { agentId: "researcher", incognito: false, surfaces: [] },
};

const toolCalled = (effect: string, callId = CALL, args: Record<string, unknown> = {}): EventInput => ({
  type: "tool.call",
  actor: "decide",
  payload: { tool: "sh", summary: "run it", callId, args, effect },
});

async function seed(store: RuntimeStore, streamId: string, events: readonly EventInput[]) {
  await store.transaction((tx) => append(tx, WORKSPACE, [{ streamId, events }]));
}

async function claimedToolExec(
  store: RuntimeStore,
  queue: Queue,
  key = KEY,
  streamId = STREAM,
  now = 0
) {
  await store.transaction((tx) =>
    queue.enqueue(tx, { type: "tool.exec", key, streamId, workspaceId: WORKSPACE })
  );
  const lease = await queue.claim("worker-1", ["tool.exec"], now);
  if (lease === null) throw new Error("expected a claimable tool.exec job in the test setup");
  return lease;
}

const of = (events: Awaited<ReturnType<RuntimeStore["readStream"]>>, type: string) =>
  events.filter((event) => event.type === type);

/** Settles like `promise`, or fails as an assertion when it hangs past the
 * deadline — the R13 convention: deadlocks surface as assertions, never as
 * test timeouts. */
async function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new AssertionError({ message: `deadlocked: ${what} did not settle within ${DEADLINE_MS} ms` })
        ),
      DEADLINE_MS
    );
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** The store, with every transaction crashing after its work ran — the
 * at-least-once state: the work happened, nothing was recorded. Two-phase
 * (R14) attempt shape: the first `skip` transactions (the read) pass, the
 * record crashes after its work — the tool ran, nothing durable. */
const crashAfterRun = (store: RuntimeStore, skip = 1): RuntimeStore => {
  let seen = 0;
  return {
    transaction: (fn) =>
      store.transaction(async (tx) => {
        const index = seen;
        seen += 1;
        const value = await fn(tx);
        if (index >= skip) throw new Error(CRASH);
        return value;
      }),
    readStream: (streamId, options) => store.readStream(streamId, options),
    close: () => store.close(),
  };
};

interface ProbeRun {
  ok: boolean;
  lines?: readonly string[];
  result?: unknown;
  error?: string;
}

interface ProbeSpec {
  effect: "read" | "idempotent" | "rerunnable" | "once";
  runs: readonly ProbeRun[];
}

/** A tool port whose runs are recorded with the exact io they received, and
 * which — while armed — parks each run on a gate the test controls. X1, X2
 * and X5 hold the tool blocked while acting on the store from outside; the
 * other cases use it as a plain scripted port. */
class ProbeTools implements ToolPort {
  readonly calls: { tool: string; args: Record<string, unknown>; io: Record<string, unknown> }[] =
    [];

  #specs: Map<string, ProbeSpec>;
  #next = new Map<string, number>();
  #armed = false;
  #started: (() => void) | undefined;
 #startedWait: Promise<void> = Promise.resolve();
  #release: (() => void) | undefined;
  #releaseWait: Promise<void> = Promise.resolve();

  constructor(specs: Record<string, ProbeSpec>) {
    this.#specs = new Map(Object.entries(specs));
  }

  /** Park the next run on the gate. */
  arm() {
    this.#armed = true;
    this.#startedWait = new Promise((resolve) => (this.#started = resolve));
    this.#releaseWait = new Promise((resolve) => (this.#release = resolve));
  }

  /** Resolves once a run is inside the port (and parked, when armed). */
  started(): Promise<void> {
    return this.#startedWait;
  }

  /** Lets the parked run finish. */
  release() {
    this.#release?.();
  }

  count(tool: string): number {
    return this.calls.filter((call) => call.tool === tool).length;
  }

  async run(
    tool: string,
    args: Record<string, unknown>,
    io: {
      onLine?: (line: string) => void;
      callId?: string;
      streamId?: string;
      workspaceId?: string;
      agentId?: string;
    }
  ): Promise<ToolRunResult> {
    this.calls.push({ tool, args: { ...args }, io: { ...io } });
    if (this.#armed) {
      this.#started?.();
      await this.#releaseWait;
    }
    const spec = this.#specs.get(tool);
    if (spec === undefined) throw new Error(`ProbeTools: no spec for tool "${tool}"`);
    const index = this.#next.get(tool) ?? 0;
    if (index >= spec.runs.length) throw new Error(`ProbeTools: no scripted run left for "${tool}"`);
    this.#next.set(tool, index + 1);
    const run = spec.runs[index]!;
    for (const line of run.lines ?? []) io.onLine?.(line);
    return {
      ok: run.ok,
      ...(run.result !== undefined ? { result: run.result } : {}),
      ...(run.error !== undefined ? { error: run.error } : {}),
    };
  }

  describe(tool: string): ToolDescriptor | undefined {
    const spec = this.#specs.get(tool);
    return spec === undefined ? undefined : { name: tool, effect: spec.effect };
  }
}

/** A port whose run always throws — the tool has a bug (X9). */
const brokenTools = (message: string): ToolPort => ({
  run: () => Promise.reject(new Error(message)),
  describe: () => undefined,
});

/** A queue that remembers every enqueue, so tests count the re-decides. */
class RecordingQueue {
  readonly enqueued: QueueJobInput[] = [];

  constructor(private readonly inner: Queue) {}

  enqueue(tx: QueueTx, job: QueueJobInput) {
    this.enqueued.push(job);
    return this.inner.enqueue(tx, job);
  }

  claim(workerId: string, types: readonly string[], now: number) {
    return this.inner.claim(workerId, types, now);
  }

  heartbeat(lease: QueueLease, now: number) {
    return this.inner.heartbeat(lease, now);
  }

  complete(tx: QueueTx, lease: QueueLease) {
    return this.inner.complete(tx, lease);
  }

  fail(lease: QueueLease, error: Error, options: { retryable: boolean }, now: number) {
    return this.inner.fail(lease, error, options, now);
  }

  get(jobId: string) {
    return this.inner.get(jobId);
  }
}

describeDrivers("runtime tool.exec two-phase (ANY-80 R14)", (h) => {
  test("X1 a concurrent store transaction commits while the tool runs, on the one PGlite connection", async () => {
    if (h.driver !== "pglite") return;
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const tools = new ProbeTools({ sh: { effect: "read", runs: [{ ok: true, result: "gated" }] } });
    await seed(store, STREAM, [runCreated, toolCalled("read")]);

    const lease = await claimedToolExec(store, queue);
    tools.arm();
    const run = handleToolExecJob(lease, { store, queue, tools, now: () => 0 });
    await within(tools.started(), "the tool run to start");
    expect(tools.count("sh")).toBe(1);

    // A bystander transaction — another session's append — must commit while
    // the tool is still parked. On the single-transaction handler it queues
    // behind the open attempt and cannot.
    let bystanderSettled = false;
    const bystander = store
      .transaction((tx) => append(tx, WORKSPACE, [{ streamId: OTHER, events: [toolCalled("read", "elsewhere")] }]))
      .then(() => {
        bystanderSettled = true;
      });

    try {
      await expect.poll(() => bystanderSettled, { timeout: DEADLINE_MS, interval: 10 }).toBe(true);
      expect(tools.count("sh")).toBe(1); // still parked: the commit beat the release
    } finally {
      tools.release();
      await within(bystander, "the bystander transaction");
      await within(run, "the tool.exec run");
    }

    const bystanderRows = await store.readStream(OTHER, { workspaceId: WORKSPACE });
    expect(bystanderRows.map((event) => event.type)).toEqual(["tool.call"]);
  });

  test("X2 the tool stream's row is lockable nowait while the tool runs (Postgres)", async () => {
    if (h.driver !== "postgres") return;
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const tools = new ProbeTools({ sh: { effect: "read", runs: [{ ok: true, result: "gated" }] } });
    await seed(store, STREAM, [runCreated, toolCalled("read")]);

    const lease = await claimedToolExec(store, queue);
    tools.arm();
    const run = handleToolExecJob(lease, { store, queue, tools, now: () => 0 });
    await within(tools.started(), "the tool run to start");
    expect(tools.count("sh")).toBe(1);

    try {
      // A second connection (the handler holds the first for the whole call on
      // the single-transaction shape) must be able to lock the stream's row
      // without waiting, and the park must leave NO open transaction on the
      // database: the record phase reads and writes in its own short
      // transaction, so nothing of this attempt is held while the tool runs.
      const [rows, openTransactions] = await within(
        store.transaction(async (tx) => {
          const locked = await tx.query(
            "select id from streams where id = $1 and workspace_id = $2 for update nowait",
            [STREAM, WORKSPACE]
          );
          const open = await tx.query(
            `select count(*)::int as n from pg_stat_activity
             where datname = current_database() and state = 'idle in transaction'`
          );
          return [locked, Number(open[0].n)] as const;
        }),
        "the park-window probe"
      );
      expect(rows).toHaveLength(1);
      // The parked attempt holds a pooled connection in an open transaction on
      // the single-transaction shape; two-phase parks nothing.
      expect(openTransactions).toBe(0);
    } finally {
      tools.release();
      await within(run, "the tool.exec run");
    }
  });

  test("X3 a normal run records exactly the single-transaction facts, ok and failed alike", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const spied = new RecordingQueue(queue);
    const tools = new ProbeTools({
      sh: {
        effect: "read",
        runs: [
          { ok: true, result: "listing", lines: ["$ ls", "a.txt"] },
          { ok: false, error: "exit 1" },
        ],
      },
    });
    await seed(store, STREAM, [runCreated, toolCalled("read")]);
    const failStream = `${STREAM}-fail`;
    const failCall = "c2";
    await seed(store, failStream, [runCreated, toolCalled("read", failCall)]);

    const okLease = await claimedToolExec(store, spied as unknown as Queue);
    await within(
      handleToolExecJob(okLease, { store, queue: spied as unknown as Queue, tools, now: () => 0 }),
      "the ok run"
    );
    const failLease = await claimedToolExec(
      store,
      spied as unknown as Queue,
      `${failStream}:${failCall}`,
      failStream
    );
    await within(
      handleToolExecJob(failLease, { store, queue: spied as unknown as Queue, tools, now: () => 0 }),
      "the failed run"
    );

    const okEvents = await store.readStream(STREAM, { workspaceId: WORKSPACE });
    expect(okEvents.map((event) => [event.type, event.actor, event.causation])).toEqual([
      ["run.created", "api", null],
      ["tool.call", "decide", null],
      ["tool.result", "tool.exec", `${KEY}:tool.result:0`],
      ["tool.result", "tool.exec", `${KEY}:tool.result:1`],
      ["tool.completed", "tool.exec", KEY],
    ]);
    expect(okEvents[4]!.payload).toEqual({ callId: CALL, ok: true, result: "listing" });

    const failEvents = await store.readStream(failStream, { workspaceId: WORKSPACE });
    const failKeys = failEvents.map((event) => [event.type, event.actor, event.causation]);
    expect(failKeys).toEqual([
      ["run.created", "api", null],
      ["tool.call", "decide", null],
      ["tool.completed", "tool.exec", `${failStream}:${failCall}`],
    ]);
    expect(failEvents[2]!.payload).toEqual({ callId: failCall, ok: false, error: "exit 1" });

    // one re-decide per run — the completion's; telemetry adds none
    expect(spied.enqueued.map((job) => job.type)).toEqual([
      "tool.exec",
      "decide",
      "tool.exec",
      "decide",
    ]);
    expect(await spied.get(okLease.jobId).then((job) => job?.status)).toBe("completed");
    expect(await spied.get(failLease.jobId).then((job) => job?.status)).toBe("completed");
  });

  test("X4 the phase-one done-guard: a recorded key completes without calling the tool", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const tools = new ProbeTools({ sh: { effect: "idempotent", runs: [{ ok: true, result: "upserted" }] } });
    await seed(store, STREAM, [runCreated, toolCalled("idempotent")]);

    const lease = await claimedToolExec(store, queue);
    await within(handleToolExecJob(lease, { store, queue, tools, now: () => 0 }), "the first run");
    await within(handleToolExecJob(lease, { store, queue, tools, now: () => 0 }), "the re-run");

    expect(tools.count("sh")).toBe(1);
    expect(of(await store.readStream(STREAM, { workspaceId: WORKSPACE }), "tool.completed")).toHaveLength(1);
    const job = await queue.get(lease.jobId);
    expect(job?.status).toBe("completed");
  });

  test("X5 the phase-three done-guard: a result recorded under the blocked run's key discards this run's", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const tools = new ProbeTools({ sh: { effect: "read", runs: [{ ok: true, result: "first-runner" }] } });
    await seed(store, STREAM, [runCreated, toolCalled("read")]);

    const lease = await claimedToolExec(store, queue);
    tools.arm();
    const run = handleToolExecJob(lease, { store, queue, tools, now: () => 0 });
    await within(tools.started(), "the tool run to start");

    // A second runner records the completion for the same key while the first
    // is still parked — the state the phase-three guard exists for.
    const secondRunner: EventInput = {
      type: "tool.completed",
      actor: "tool.exec",
      payload: { callId: CALL, ok: true, result: "second-runner" },
      causation: KEY,
    };
    let secondSettled = false;
    const second = store
      .transaction((tx) => append(tx, WORKSPACE, [{ streamId: STREAM, events: [secondRunner] }]))
      .then(() => {
        secondSettled = true;
      });

    try {
      // the record phase is free: the second runner commits while the tool is parked
      await expect.poll(() => secondSettled, { timeout: DEADLINE_MS, interval: 10 }).toBe(true);
    } finally {
      tools.release();
      await within(second, "the second runner's append");
      await within(run, "the tool.exec run");
    }

    const completed = of(await store.readStream(STREAM, { workspaceId: WORKSPACE }), "tool.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]!.payload).toEqual({ callId: CALL, ok: true, result: "second-runner" });
    expect(completed[0]!.causation).toBe(KEY);
    const job = await queue.get(lease.jobId);
    expect(job?.status).toBe("completed");
  });

  test("X6 recovery is one transaction: attempt two of a once call records the interruption, never the tool", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const tools = new ProbeTools({ sh: { effect: "once", runs: [{ ok: true, result: "sent" }] } });
    await seed(store, STREAM, [runCreated, toolCalled("once")]);

    // Attempt one crashes after its work: the tool ran, nothing was recorded.
    const first = await claimedToolExec(store, queue);
    await expect(
      handleToolExecJob(first, { store: crashAfterRun(store), queue, tools, now: () => 0 })
    ).rejects.toThrow(CRASH);
    expect(tools.count("sh")).toBe(1);

    // Attempt two is the recovery: interruption facts, no second run, one
    // transaction — proven by crashing that single transaction and finding
    // nothing recorded.
    const second = await queue.claim("worker-2", ["tool.exec"], 30_000);
    expect(second?.attempt).toBe(2);
    await expect(
      handleToolExecJob(second!, { store: crashAfterRun(store, 0), queue, tools, now: () => 0 })
    ).rejects.toThrow(CRASH);
    expect(
      of(await store.readStream(STREAM, { workspaceId: WORKSPACE }), "tool.interrupted")
    ).toHaveLength(0);
    expect(tools.count("sh")).toBe(1);

    // The same attempt on the real store records, still without a run.
    const third = await queue.claim("worker-3", ["tool.exec"], 90_000);
    expect(third?.attempt).toBe(3);
    await within(handleToolExecJob(third!, { store, queue, tools, now: () => 0 }), "the recovery");
    expect(tools.count("sh")).toBe(1);
    const interrupted = of(await store.readStream(STREAM, { workspaceId: WORKSPACE }), "tool.interrupted");
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]!.payload).toEqual({
      callId: CALL,
      effect: "once",
      note: "interrupted by a restart; effects may be partial",
    });
    expect(of(await store.readStream(STREAM, { workspaceId: WORKSPACE }), "human.requested")).toHaveLength(1);
  });

  test("X7 the port's io carries the lease's workspace and the session's agent, absent on runs", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const tools = new ProbeTools({
      sh: { effect: "read", runs: [{ ok: true, result: "a" }, { ok: true, result: "b" }] },
    });

    await seed(store, "session:r14", [sessionCreated, toolCalled("read")]);
    const sessionLease = await claimedToolExec(store, queue, `session:r14:${CALL}`, "session:r14");
    await within(handleToolExecJob(sessionLease, { store, queue, tools, now: () => 0 }), "the session run");

    await seed(store, STREAM, [runCreated, toolCalled("read")]);
    const runLease = await claimedToolExec(store, queue);
    await within(handleToolExecJob(runLease, { store, queue, tools, now: () => 0 }), "the run call");

    expect(tools.calls).toHaveLength(2);
    const [onSession, onRun] = tools.calls.map((call) => call.io);
    expect(onSession!.agentId).toBe("researcher");
    expect(onSession!.workspaceId).toBe(WORKSPACE);
    expect(onSession!.streamId).toBe("session:r14");
    expect(onSession!.callId).toBe(CALL);
    expect(typeof onSession!.onLine).toBe("function");
    expect(onRun!.agentId).toBeUndefined();
    expect(onRun!.workspaceId).toBe(WORKSPACE);
    expect(onRun!.streamId).toBe(STREAM);
  });

  test("X8 the tool.exec lease: 61 minutes, heartbeat-held past ten, reclaimable 30 s after silence", async () => {
    expect(DEFAULT_TYPE_CONFIGS["tool.exec"]).toEqual({
      maxRunMs: 3_660_000,
      heartbeatMs: 30_000,
      maxRetries: 3,
      retryBackoffMs: 30_000,
    });

    const store = await h.openStore();
    const queue = new MemoryQueue();
    await seed(store, STREAM, [runCreated, toolCalled("read")]);
    const lease = await claimedToolExec(store, queue);

    // Heartbeat every 30 s: the lease is still held at 10 minutes — well
    // past the old 300 s cap — so no other worker claims it under us.
    for (let at = 30_000; at <= 600_000; at += 30_000) {
      await queue.heartbeat(lease, at);
    }
    expect(await queue.claim("worker-2", ["tool.exec"], 600_000)).toBeNull();

    // The heartbeats stop at 600_000: the lease is reclaimable exactly at the
    // heartbeat-silence window's edge, 30 s after the last one.
    expect(await queue.claim("worker-2", ["tool.exec"], 629_999)).toBeNull();
    const reclaimed = await queue.claim("worker-2", ["tool.exec"], 630_000);
    expect(reclaimed?.attempt).toBe(2);
    expect(reclaimed?.workerId).toBe("worker-2");
  });

  test("X9 a tool that throws fails the lease retryably and appends nothing", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    await seed(store, STREAM, [runCreated, toolCalled("read")]);
    const before = await store.readStream(STREAM, { workspaceId: WORKSPACE });

    const lease = await claimedToolExec(store, queue);
    await expect(
      handleToolExecJob(lease, { store, queue, tools: brokenTools("the tool exploded"), now: () => 0 })
    ).rejects.toThrow("the tool exploded");

    const job = await queue.get(lease.jobId);
    expect(job?.status).toBe("pending"); // retryable: backoff, not dead
    expect(job?.lastError).toContain("the tool exploded");
    expect(await store.readStream(STREAM, { workspaceId: WORKSPACE })).toHaveLength(before.length);
  });
});
