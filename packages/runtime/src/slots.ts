// The sandbox concurrency slots (ANY-44 D1, ANY-92 T16): a per-workspace cap
// on concurrent sandbox tool calls — the slot is held per tool call, never
// per run, and chat turns (`session:` streams) rank ahead of everything else.
// State lives in the runtime-owned `sandbox_slots` table, created on first
// use; every operation is one transaction on the caller's store, with `now`
// injected so tests stay deterministic.
//
// The wait is a fact (the `tool.exec` handler appends `tool.queued` /
// `tool.dequeued`), and a crashed holder never leaks a slot: a held row whose
// heartbeat is older than 60 s is reclaimable by the next acquire. As with
// the R8 queue's cap filters, two concurrent acquires on separate Postgres
// connections serialize on a per-workspace advisory lock; the reclaim counts
// committed rows, so a crash is bounded by the 60 s window, not by the lock.
import type { RuntimeStore } from "./store/types";

/** A held slot older than this is presumed crashed and reclaimable. */
export const SLOT_STALE_MS = 60_000;

/** One slot request: the workspace, the call's key (`<stream>:<callId>`),
 * the queue priority (0 = a `session:` stream, 1 = everything else), and the
 * injected-clock instant of the ask. */
export type SlotRequest = {
  workspaceId: string;
  callKey: string;
  priority: number;
  now: number;
};

/** `{ granted: true, since }` — `since` is the waiter's registration instant,
 * from which the handler derives a dequeue's `waitedMs` (0 for a call granted
 * at once). `{ granted: false, position }` — the 1-based rank in the wait
 * queue (priority, then older `since`). */
export type SlotVerdict =
  | { granted: true; since: number }
  | { granted: false; position: number };

/** The sandbox slot store: acquire per call, release and heartbeat while held. */
export type SandboxSlots = {
  acquire(request: SlotRequest): Promise<SlotVerdict>;
  release(callKey: string): Promise<void>;
  heartbeat(callKey: string, now: number): Promise<void>;
};

const DDL = [
  `create table if not exists sandbox_slots (
     workspace_id text not null,
     call_key text not null,
     priority integer not null,
     state text not null check (state in ('waiting', 'held')),
     since bigint not null,
     heartbeat_at bigint,
     primary key (workspace_id, call_key)
   )`,
  `create index if not exists sandbox_slots_state_idx
     on sandbox_slots (workspace_id, state)`,
];

// The DDL runs once per store instance, chained so concurrent constructions
// serialize (the `if not exists` check-then-act is not race-free alone).
const schemaReady = new WeakMap<object, Promise<void>>();

function ensureSchema(store: RuntimeStore): Promise<void> {
  let ready = schemaReady.get(store);
  if (ready === undefined) {
    ready = store.transaction(async (tx) => {
      for (const statement of DDL) await tx.query(statement);
    });
    schemaReady.set(store, ready);
    // A failed ensure is retried by the next call, not cached.
    ready.catch(() => schemaReady.delete(store));
  }
  return ready;
}

/** Builds the slot store over the runtime store, capped at `cap` concurrent
 * held slots per workspace. Host mode never constructs one. */
export function sandboxSlots(store: RuntimeStore, options: { cap: number }): SandboxSlots {
  const cap = options.cap;

  return {
    async acquire({ workspaceId, callKey, priority, now }): Promise<SlotVerdict> {
      await ensureSchema(store);
      return store.transaction(async (tx) => {
        // One decision per workspace at a time: the cap count and the wait
        // queue order must be read and written as a unit.
        await tx.query("select pg_advisory_xact_lock(hashtext($1))", [`${workspaceId}:sandbox_slots`]);

        // A crashed holder's row goes: its slot is free to hand out again.
        await tx.query(
          `delete from sandbox_slots
           where workspace_id = $1 and state = 'held'
             and heartbeat_at is not null and heartbeat_at <= $2`,
          [workspaceId, now - SLOT_STALE_MS]
        );

        // Register the waiter if this call is new; a returning one keeps its
        // original priority and `since` — its place in the queue.
        await tx.query(
          `insert into sandbox_slots (workspace_id, call_key, priority, state, since, heartbeat_at)
           values ($1, $2, $3, 'waiting', $4, null)
           on conflict (workspace_id, call_key) do nothing`,
          [workspaceId, callKey, priority, now]
        );
        const mine = await tx.query(
          `select priority, state, since from sandbox_slots
           where workspace_id = $1 and call_key = $2`,
          [workspaceId, callKey]
        );
        const row = mine[0]!;

        // A re-acquire of a slot this call still holds (a retried run after a
        // crash inside the window) is the grant it already has.
        if (row.state === "held") {
          await tx.query(
            `update sandbox_slots set heartbeat_at = $3
             where workspace_id = $1 and call_key = $2`,
            [workspaceId, callKey, now]
          );
          return { granted: true, since: Number(row.since) };
        }

        const held = await tx.query(
          `select count(*)::int as n from sandbox_slots
           where workspace_id = $1 and state = 'held'`,
          [workspaceId]
        );
        const ahead = await tx.query(
          `select count(*)::int as n from sandbox_slots
           where workspace_id = $1 and state = 'waiting'
             and (priority < $2 or (priority = $2 and since < $3)
               or (priority = $2 and since = $3 and call_key < $4))`,
          [workspaceId, Number(row.priority), Number(row.since), callKey]
        );

        // Grant when under the cap and nobody ranks ahead: lower priority
        // number first, then the older registration.
        if (Number(held[0]!.n) < cap && Number(ahead[0]!.n) === 0) {
          await tx.query(
            `update sandbox_slots set state = 'held', heartbeat_at = $3
             where workspace_id = $1 and call_key = $2`,
            [workspaceId, callKey, now]
          );
          return { granted: true, since: Number(row.since) };
        }
        return { granted: false, position: Number(ahead[0]!.n) + 1 };
      });
    },

    async release(callKey: string): Promise<void> {
      await ensureSchema(store);
      await store.transaction((tx) =>
        tx.query(`delete from sandbox_slots where call_key = $1`, [callKey])
      );
    },

    async heartbeat(callKey: string, now: number): Promise<void> {
      await ensureSchema(store);
      await store.transaction((tx) =>
        tx.query(
          `update sandbox_slots set heartbeat_at = $2 where call_key = $1 and state = 'held'`,
          [callKey, now]
        )
      );
    },
  };
}
