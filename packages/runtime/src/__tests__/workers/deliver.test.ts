// ANY-40 R9c — W13/W13a: the `deliver` job. One outbound message through the
// SurfacePort, the job key `deliver:<eventId>:<target>` passed as the
// idempotency key, the receipt recorded as `message.delivered` telemetry with
// `causation = <job key>` — so a re-run of the same job sends nothing twice.
// A failing surface is a queue retry with the type's backoff, not a dead
// letter, until the send lands. Both drivers, per the house describeDrivers
// seam; the surface is the fake, never a real channel.
import { expect, test } from "vitest";
import { append, type EventInput, type RuntimeStore } from "../../index";
import { MemoryQueue } from "../../queue/memory";
import { describeDrivers } from "../../testing/drivers";
import { FakeSurface } from "../../testing/fake-surface";
import { handleDeliverJob } from "../../workers/deliver";

const WORKSPACE = "ws-r9c-deliver";
const STREAM = "session:s1";

// -- fixtures -------------------------------------------------------------------

/** The session, its definition promising an `email` surface, and the turn-1 reply on the log. */
const sessionSeed: readonly EventInput[] = [
  {
    type: "run.created",
    actor: "api",
    payload: {
      definition: { systemPrompt: "S", tools: [], surfaces: ["email"] },
      engineVersion: "v1",
      brief: "",
      grants: [],
      budgets: {},
      parent: null,
    },
  },
  { type: "agent.message", actor: "decide", payload: { text: "hello" } },
];

const deliverKey = (eventId: string, target: string) => `deliver:${eventId}:${target}`;
const TURN_ONE_MESSAGE = "agent-message:session:s1:1";
const KEY = deliverKey(TURN_ONE_MESSAGE, "email");

async function seed(store: RuntimeStore) {
  await store.transaction((tx) => append(tx, WORKSPACE, [{ streamId: STREAM, events: sessionSeed }]));
}

async function enqueueDeliver(store: RuntimeStore, queue: MemoryQueue) {
  await store.transaction((tx) =>
    queue.enqueue(tx, {
      type: "deliver",
      key: KEY,
      streamId: STREAM,
      workspaceId: WORKSPACE,
    })
  );
}

async function claimedDeliver(store: RuntimeStore, queue: MemoryQueue, now = 0) {
  const lease = await queue.claim("worker-1", ["deliver"], now);
  if (lease === null) throw new Error("expected a claimable deliver job in the test setup");
  return lease;
}

const eventsOn = (store: RuntimeStore) => store.readStream(STREAM, { workspaceId: WORKSPACE });

const of = async (store: RuntimeStore, type: string) =>
  (await eventsOn(store)).filter((event) => event.type === type);

describeDrivers("runtime deliver worker (ANY-40 R9c)", (h) => {
  test("W13 the surface receives the message once across two runs of the same job, one receipt recorded", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const surface = new FakeSurface();
    await seed(store);
    await enqueueDeliver(store, queue);

    const lease = await claimedDeliver(store, queue);
    await handleDeliverJob(lease, { store, queue, surface });
    await handleDeliverJob(lease, { store, queue, surface }); // the at-least-once re-run

    expect(surface.sent).toHaveLength(1);
    expect(surface.sent[0]).toEqual({
      target: "email",
      text: "hello",
      idempotencyKey: KEY,
    });

    const delivered = await of(store, "message.delivered");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.causation).toBe(KEY);
    expect(delivered[0]!.payload).toEqual({
      eventId: TURN_ONE_MESSAGE,
      target: "email",
      platformMessageId: "pm-1",
    });

    // telemetry only: the receipt triggers no re-decide
    expect(await queue.claim("worker-2", ["decide"], 1)).toBeNull();
  });

  test("W13a a failing surface is retried with backoff, then one receipt", async () => {
    const store = await h.openStore();
    const queue = new MemoryQueue();
    const surface = new FakeSurface([new Error("smtp down"), new Error("smtp down")]);
    await seed(store);
    await enqueueDeliver(store, queue);

    let now = 0;
    const clock = () => now;

    const first = await claimedDeliver(store, queue, now);
    await expect(handleDeliverJob(first, { store, queue, surface, now: clock })).rejects.toThrow(
      "smtp down"
    );
    expect(surface.sent).toHaveLength(0);
    const afterFirst = await queue.get(first.jobId);
    expect(afterFirst?.status).toBe("pending"); // backed off, not dead
    expect(afterFirst?.attempts).toBe(1);

    // the type's backoff: the retry is not claimable at the same instant...
    expect(await queue.claim("worker-2", ["deliver"], now)).toBeNull();
    // ...then it is, fails again, and backs off doubly
    now = 60_000;
    const second = await queue.claim("worker-2", ["deliver"], now);
    expect(second?.attempt).toBe(2);
    await expect(handleDeliverJob(second!, { store, queue, surface, now: clock })).rejects.toThrow(
      "smtp down"
    );

    now = 180_000; // 60s + 120s of backoff later
    const third = await queue.claim("worker-3", ["deliver"], now);
    expect(third?.attempt).toBe(3);
    await handleDeliverJob(third!, { store, queue, surface, now: clock });

    expect(surface.attempts).toHaveLength(3);
    expect(surface.sent).toHaveLength(1);
    expect(await of(store, "message.delivered")).toHaveLength(1);
    expect((await queue.get(third!.jobId))?.status).toBe("completed");
  });
});
