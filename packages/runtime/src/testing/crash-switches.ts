// Crash-suite switches (ANY-37 R11, RUNTIME §15.3): test-only decorators that
// disable ONE recovery mechanism each, so the KM cases can prove every
// mechanism load-bearing — with the switch on, the invariant the mechanism
// guards must break. Production code never imports this module; the crash
// worker entry (packages/runtime/crash/) applies them per scenario flag.
//
// The four mechanisms, as the R11 card names them:
// - lease expiry: a dead worker's job is reclaimable once `lease_until` lapses.
//   Off = leases whose window never lapses within any test (KM1).
// - the `(stream_id, causation)` unique index — "append without it": append's
//   fact-dedupe (the pre-check SELECT plus the index that backstops it) is
//   what makes a re-delivered job's second append a no-op. Off = both layers
//   (KM2): the index is dropped on the database and the pre-check reads as
//   "unknown", so an append of an already-recorded causation inserts again.
// - effect-class recovery (§6): a retried `tool.exec` with no recorded result
//   re-runs `read`/`idempotent` tools and records `tool.interrupted` for
//   `rerunnable`/`once` instead of a second run. Off = every tool describes
//   as `read`, so the retry re-runs it (KM3).
// - `deliver` idempotency: the job key rides to the surface as the
//   idempotency key, so a crash between send and record is absorbed by the
//   adapter. Off = the key never reaches the surface (KM4).
import type { QueueTypeConfig } from "../queue/types";
import type { ToolPort, SurfacePort } from "../ports";
import type { RuntimeStore, RuntimeTx } from "../store/types";

/** The loop's job types — the leases the KM1 switch must make unlapsable. */
export const CRASH_WORKER_TYPES = ["decide", "llm.call", "tool.exec", "delegate.resolve", "deliver"] as const;

/** KM1: type-config overrides whose lease window (`min(heartbeat, maxRun)`)
 * outlives any test, so a killed worker's job is never reclaimed. */
export function leaseNeverExpires(): Record<string, Partial<QueueTypeConfig>> {
  const frozen: Partial<QueueTypeConfig> = { maxRunMs: 21_600_000, heartbeatMs: 21_600_000 };
  return Object.fromEntries(CRASH_WORKER_TYPES.map((type) => [type, frozen]));
}

/** Anything that can run SQL: the store's transaction, an adapter, a pool. */
export interface SqlRunner {
  query(sql: string, params?: readonly unknown[]): Promise<Record<string, unknown>[]>;
}

/** KM2, database half: drop the partial unique index append's `on conflict`
 * leans on. Idempotent; run once when the scenario's switch is on. */
export async function dropCausationIndex(db: SqlRunner): Promise<void> {
  await db.query("drop index if exists events_stream_causation_fact_key");
}

/** The dedupe SELECT append issues before inserting a batch — the exact
 * shape store.append builds (kept in sync by the KM2 test, which asserts the
 * wrapper saw it; if append's query changes, that assertion fails loudly). */
const DEDUPE_PREFIX = "select causation from events where stream_id = $1";

/** True when `sql` is append's fact-dedupe pre-check. */
export function isCausationDedupeQuery(sql: string): boolean {
  return sql.startsWith(DEDUPE_PREFIX);
}

/** KM2, store half: append without causation dedupe — the pre-check reads as
 * "nothing recorded" whatever the table holds, so a batch whose causations
 * are already on the stream inserts again (and with the index dropped,
 * nothing absorbs the rows). The handler-level recorded guards are
 * deliberately untouched: the switch isolates append's own layer.
 */
export function appendWithoutCausationDedupe(store: RuntimeStore): RuntimeStore {
  return {
    transaction: (run) =>
      store.transaction((tx) =>
        run({
          query: async (sql, params) => {
            if (isCausationDedupeQuery(sql)) return [];
            return tx.query(sql, params);
          },
          onCommit: tx.onCommit,
        } satisfies RuntimeTx),
      ),
    readStream: (streamId, options) => store.readStream(streamId, options),
    close: () => store.close(),
  };
}

/** KM3: every tool describes as `read` — the safe default that re-runs — so a
 * retried tool.exec re-runs even `rerunnable`/`once` tools instead of
 * recording `tool.interrupted`. */
export function effectBlind(tools: ToolPort): ToolPort {
  return {
    describe: (name) => {
      const declared = tools.describe(name);
      return declared === undefined ? undefined : { ...declared, effect: "read" };
    },
    run: (name, args, io) => tools.run(name, args, io),
  };
}

/** KM4: the idempotency key never reaches the surface, so a re-delivered
 * deliver job cannot be absorbed by the adapter — every attempt lands. */
export function withoutIdempotencyKey(surface: SurfacePort): SurfacePort {
  return {
    send: (target, message) => surface.send(target, message),
  };
}
