// The incognito purge (S11, ANY-61; PRODUCT §10.7): an incognito session's text
// is erased 24 h after its last activity, while the audit trail — dispositions,
// the fold-bearing facts — survives with its text redacted. Two halves:
//
//  - the enqueue side rides the command path's transaction (bootstrap's
//    `enqueueDecide`): every incognito stream that gains a `message.received`
//    carries a live `session.purge` job keyed `session:<id>:purge`, whose
//    runAt is the latest activity plus INCOGNITO_PURGE_HOURS;
//  - the handler, claimed by `runPurgeLoop` (or by hand in tests), re-checks
//    the deadline against the stream's latest `message.received` — activity
//    that landed after the queueing moves it — and either re-queues itself or
//    redacts and completes, the redaction and the completion in one
//    transaction.
import { redactStream } from "@fabric/runtime";
import type { Queue, QueueLease, RuntimeStore, RuntimeTx } from "@fabric/runtime";

/** The hour, in ms. */
const HOUR_MS = 60 * 60 * 1000;

/** The event types whose text-bearing fields the purge erases (card ANY-61). */
export const PURGE_EVENT_TYPES = [
  "message.received",
  "llm.completed",
  "agent.message",
  "tool.call",
  "tool.completed",
  "tool.result",
  "disposition.recorded",
] as const;

/** The purge horizon; INCOGNITO_PURGE_HOURS overrides, 24 h by default. Read
 * at call time, like the other definition-adjacent env (bootstrap's note). */
export function incognitoPurgeHoursMs(): number {
  const raw = process.env.INCOGNITO_PURGE_HOURS;
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed * HOUR_MS : 24 * HOUR_MS;
}

const tsMs = (value: unknown): number =>
  value instanceof Date ? value.getTime() : Date.parse(String(value));

/** The latest `message.received` ts on the stream, or null. */
async function latestActivityOn(tx: RuntimeTx, streamId: string, workspaceId: string): Promise<number | null> {
  const rows = await tx.query(
    `select ts from events
     where stream_id = $1 and workspace_id = $2 and type = 'message.received'
     order by seq desc limit 1`,
    [streamId, workspaceId]
  );
  return rows.length === 0 ? null : tsMs(rows[0]!.ts);
}

/**
 * The (re)queue half: call inside the command's transaction, after the append.
 * No-op on streams that are not incognito sessions or carry no message; else
 * the purge job exists with its runAt at the latest activity + horizon, and a
 * pending job's deadline follows the newest message (the queue's key dedupe
 * keeps the first live row, so the move is a direct run_at update; a leased
 * job is left alone — the handler re-checks).
 */
export async function enqueuePurgeOnActivity(
  tx: RuntimeTx,
  queue: Queue,
  workspaceId: string,
  streamId: string
): Promise<void> {
  const created = await tx.query(
    `select payload->>'incognito' as incognito from events
     where stream_id = $1 and workspace_id = $2 and type = 'session.created'
     order by seq limit 1`,
    [streamId, workspaceId]
  );
  if (created.length === 0 || created[0]!.incognito !== "true") return;

  const latest = await latestActivityOn(tx, streamId, workspaceId);
  if (latest === null) return;

  const runAt = latest + incognitoPurgeHoursMs();
  const key = `${streamId}:purge`;
  await queue.enqueue(tx, { type: "session.purge", key, streamId, workspaceId, runAt });
  await tx.query(`update jobs set run_at = $2 where key = $1 and status = 'pending'`, [key, runAt]);
}

export interface PurgeJobDeps {
  store: RuntimeStore;
  queue: Queue;
  /** Injected clock for the deadline check; the real clock in production. */
  now?: () => number;
}

/** The purge handler: re-queue on the moved deadline, else redact + complete. */
export async function handleSessionPurgeJob(lease: QueueLease, deps: PurgeJobDeps): Promise<void> {
  const { store, queue } = deps;
  const now = deps.now ?? (() => Date.now());
  const streamId = lease.streamId;
  if (streamId === null) throw new Error("session.purge job without a stream");
  const key = `${streamId}:purge`;

  try {
    await store.transaction(async (tx) => {
      const latest = await latestActivityOn(tx, streamId, lease.workspaceId);
      const deadline = (latest ?? now()) + (latest === null ? 0 : incognitoPurgeHoursMs());
      if (latest !== null && now() < deadline) {
        // Activity moved the deadline past this firing: nothing redacted.
        await queue.complete(tx, lease);
        await queue.enqueue(tx, {
          type: "session.purge",
          key,
          streamId,
          workspaceId: lease.workspaceId,
          runAt: deadline,
        });
        return;
      }
      // One transaction: the redaction (nested per R13) and the completion.
      await redactStream(store, lease.workspaceId, streamId, {
        types: PURGE_EVENT_TYPES,
        at: now(),
      });
      await queue.complete(tx, lease);
    });
  } catch (error) {
    await queue.fail(lease, error instanceof Error ? error : new Error(String(error)), { retryable: true }, now());
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });

/**
 * The daemon side: claim `session.purge` and run it, the worker loop's shape
 * for the one type the runtime loop does not dispatch. Never throws for long.
 */
export async function runPurgeLoop(
  store: RuntimeStore,
  queue: Queue,
  signal: AbortSignal | undefined,
  workerId: string,
  pollIntervalMs = 1_000
): Promise<void> {
  while (signal?.aborted !== true) {
    let lease: Awaited<ReturnType<Queue["claim"]>> = null;
    try {
      lease = await queue.claim(workerId, ["session.purge"], Date.now());
    } catch {
      lease = null;
    }
    if (lease === null) {
      await sleep(pollIntervalMs);
      continue;
    }
    try {
      await handleSessionPurgeJob(lease, { store, queue });
    } catch (error) {
      console.log(
        `[purge] ${lease.key} failed: ${error instanceof Error ? error.message : String(error)}`
      );
      await sleep(pollIntervalMs);
    }
  }
}
