// ANY-92 T16 — the sandbox concurrency slots (C2–C4): a per-workspace cap on
// concurrent sandbox tool calls, held per tool call, chat turns first, a
// crashed holder reclaimed by the 60 s heartbeat window. The slots store runs
// on the runtime store, so "both drivers" is the store driver harness — the
// Postgres leg is mandatory under CI, as everywhere in this package. The
// concurrent-init case below the harness is Postgres-only by nature: it needs
// four stores on four connections over one database, which PGlite's single
// connection cannot give.
import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { Pool } from "pg";
import { openStore, sandboxSlots } from "../index";
import type { RuntimeStore } from "../store/types";
import { describeDrivers, postgresUrlFromEnv } from "../testing/drivers";

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

const slotsPostgresUrl = postgresUrlFromEnv();
if (slotsPostgresUrl !== undefined) {
  test("four stores initializing against one fresh Postgres serialize the schema DDL (T16 rework)", async () => {
    // The review probe's shape: independent store instances — one pool each —
    // whose first acquires race the `create table if not exists` on separate
    // connections against a fresh database. The check-then-act races in the
    // catalog: two creators both see the table missing and the loser dies on
    // a duplicate key. The DDL must serialize across connections.
    const admin = new Pool({ connectionString: slotsPostgresUrl.replace(/\/[^/]*$/, "/postgres") });
    const database = `runtime_slots_init_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    await admin.query(`create database "${database}"`);
    const stores: RuntimeStore[] = [];
    try {
      const url = slotsPostgresUrl.replace(/\/[^/]*$/, `/${database}`);
      // Opened one by one: the store's own migrations are out of scope here.
      for (let i = 0; i < 4; i++) {
        stores.push(await openStore({ driver: "postgres", url }));
      }
      const slots = stores.map((store) => sandboxSlots(store, { cap: 2 }));
      const verdicts = await Promise.all(
        slots.map((slotStore, i) =>
          slotStore.acquire({ workspaceId: "ws-init", callKey: `run:x:c${i}`, priority: 1, now: 1_000 })
        ),
      );
      // cap 2 held by two of the four, the other two refused — no throw is
      // the point. The waiters' reported positions are 1 and-or 2: with the
      // same `since`, a later ask whose call key ranks ahead also reports 1,
      // which the 2 s re-acquire loop straightens out on its own; the queue
      // order itself is C2 and C3's, decided there on distinct instants.
      expect(verdicts.filter((v) => v.granted).length).toBe(2);
      const waiting = verdicts.filter((v): v is Extract<typeof v, { granted: false }> => !v.granted);
      expect(waiting.length).toBe(2);
      for (const verdict of waiting) {
        expect(verdict.position).toBeGreaterThanOrEqual(1);
        expect(verdict.position).toBeLessThanOrEqual(2);
      }
    } finally {
      await Promise.all(stores.map((store) => store.close()));
      await admin.query(`drop database if exists "${database}" with (force)`);
      await admin.end();
    }
  });
}
