// ANY-92 T16 — the sandbox concurrency slots (C2–C4): a per-workspace cap on
// concurrent sandbox tool calls, held per tool call, chat turns first, a
// crashed holder reclaimed by the 60 s heartbeat window. The slots store runs
// on the runtime store, so "both drivers" is the store driver harness — the
// Postgres leg is mandatory under CI, as everywhere in this package.
import { expect, test } from "vitest";
import { sandboxSlots } from "../index";
import { describeDrivers } from "../testing/drivers";

const WORKSPACE = "ws-t16";

/** One acquire with the boilerplate trimmed; `priority` 1 = a run, 0 = a chat turn. */
const acquire = (
  slots: ReturnType<typeof sandboxSlots>,
  callKey: string,
  priority: number,
  now: number
) => slots.acquire({ workspaceId: WORKSPACE, callKey, priority, now });

describeDrivers("sandbox slots (ANY-92 T16)", (h) => {
  test("C2 cap 2 grants two and queues the third at position 1; a release grants the waiter on its next acquire", async () => {
    const store = await h.openStore();
    const slots = sandboxSlots(store, { cap: 2 });

    const first = await acquire(slots, "run:x:c1", 1, 1_000);
    expect(first.granted).toBe(true);
    const second = await acquire(slots, "run:x:c2", 1, 1_000);
    expect(second.granted).toBe(true);
    // the cap is full: the third call waits, alone in the queue, at position 1
    await expect(acquire(slots, "run:x:c3", 1, 1_000)).resolves.toEqual({
      granted: false,
      position: 1,
    });

    // a release frees the slot; the waiter is granted when it asks again
    await slots.release("run:x:c1");
    const retried = await acquire(slots, "run:x:c3", 1, 2_000);
    expect(retried.granted).toBe(true);
  });

  test("C3 a session waiter ranks ahead of an older run waiter; the run waits until the session's slot frees", async () => {
    const store = await h.openStore();
    const slots = sandboxSlots(store, { cap: 1 });
    expect((await acquire(slots, "run:x:held", 1, 1_000)).granted).toBe(true);

    // the run waiter registers first, alone in the queue
    await expect(acquire(slots, "run:x:c1", 1, 2_000)).resolves.toEqual({
      granted: false,
      position: 1,
    });
    // the chat turn registers later yet ranks first: priority 0 beats 1
    await expect(acquire(slots, "session:s1:c2", 0, 3_000)).resolves.toEqual({
      granted: false,
      position: 1,
    });

    // the slot frees: the session waiter is granted on its next acquire...
    await slots.release("run:x:held");
    expect((await acquire(slots, "session:s1:c2", 0, 4_000)).granted).toBe(true);
    // ...and the run waiter is still refused, behind the session's call
    await expect(acquire(slots, "run:x:c1", 1, 4_000)).resolves.toEqual({
      granted: false,
      position: 1,
    });

    // the session's call completes: the run waiter finally gets through
    await slots.release("session:s1:c2");
    expect((await acquire(slots, "run:x:c1", 1, 5_000)).granted).toBe(true);
  });

  test("C4 a held slot whose heartbeat is 61 s old is reclaimed by the next acquire", async () => {
    const store = await h.openStore();
    const slots = sandboxSlots(store, { cap: 1 });
    expect((await acquire(slots, "run:x:crash", 1, 0)).granted).toBe(true);
    await slots.heartbeat("run:x:crash", 30_000);

    // 30 s after the last beat the slot is still held: the worker may be slow, not dead
    await expect(acquire(slots, "run:x:other", 1, 60_000)).resolves.toEqual({
      granted: false,
      position: 1,
    });

    // 61 s after the last beat the holder is presumed crashed: the next
    // acquire walks straight in
    expect((await acquire(slots, "run:x:other", 1, 91_000)).granted).toBe(true);
  });

  test("a waiter abandoned past the 60 s cutoff stops ranking ahead of later calls", async () => {
    const store = await h.openStore();
    const slots = sandboxSlots(store, { cap: 1 });
    expect((await acquire(slots, "run:x:held", 1, 0)).granted).toBe(true);
    // a waiter registers, then its call finishes some other way — a recovery
    // records the interruption, or the job dies with its retries — so it
    // never re-acquires and never releases
    await expect(acquire(slots, "run:x:gone", 1, 1_000)).resolves.toEqual({
      granted: false,
      position: 1,
    });

    // past the stale cutoff the abandoned waiter is gone: the slot frees and
    // a fresh call walks straight in — no phantom ranks ahead of it forever
    await slots.release("run:x:held");
    expect((await acquire(slots, "run:x:fresh", 1, 61_500)).granted).toBe(true);

    // a waiter that keeps re-acquiring (the 2 s defer loop) never goes stale,
    // however long the wait: it keeps its place and gets in ahead of the
    // later arrivals
    await expect(acquire(slots, "run:x:live", 1, 62_000)).resolves.toEqual({
      granted: false,
      position: 1,
    });
    await expect(acquire(slots, "run:x:live", 1, 63_000)).resolves.toEqual({
      granted: false,
      position: 1,
    });
    await expect(acquire(slots, "run:x:later", 1, 122_000)).resolves.toEqual({
      granted: false,
      position: 2,
    });
    await slots.release("run:x:fresh");
    expect((await acquire(slots, "run:x:live", 1, 122_500)).granted).toBe(true);
  });
});
