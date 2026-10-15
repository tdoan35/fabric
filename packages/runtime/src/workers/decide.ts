// The `decide` job handler (RUNTIME §4): read the stream, fold, decideAgent —
// then append the decision and enqueue its jobs in ONE transaction, so the
// decision's events and jobs commit together or not at all (W1). The handler
// appends with `causation = <job key>:<type>:<n>`: derived from the job key, so
// R5's unique index makes a retried job's re-append a no-op, and distinct per
// event, so one decision's several facts never collide on (stream, causation).
//
// `readEventRows` and `enqueueReDecides` live here because the card's file
// scope pins the module set; `ll-call` imports them as the shared worker
// internals they are.
import { decideAgent, eventClass, fold, type AgentState, type DecideDef } from "@fabric/core";
import { randomUUID } from "node:crypto";
import type { Queue, QueueLease } from "../queue/types";
import { append } from "../store/store";
import type { RuntimeStore, RuntimeTx, StoredEvent } from "../store/types";

/** The columns any event read needs: the full envelope `parseEvent` demands,
 * which is also the fold's input — StoredEvent, the store's own read shape. */
export type EventRow = StoredEvent;

export type DecideJobDeps = {
  store: RuntimeStore;
  queue: Queue;
  /** Injected clock for the rules' deadlines; the real clock in production. */
  now?: () => number;
};

/** MAX_STEPS when the definition snapshot is silent. */
const DEFAULT_MAX_STEPS = 8;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The whole stream, any class, seq-ordered: the fold needs contiguous seqs
 * (telemetry included) and raises FoldError on a gap. */
export async function readEventRows(
  tx: RuntimeTx,
  streamId: string,
  workspaceId: string
): Promise<EventRow[]> {
  const rows = await tx.query(
    `select id, workspace_id, stream_id, seq, type, class, v, actor, causation, ts, payload
     from events where stream_id = $1 and workspace_id = $2 order by seq asc`,
    [streamId, workspaceId]
  );
  return rows.map((row) => toEventRow(row));
}

function toEventRow(row: Record<string, unknown>): EventRow {
  const ts: unknown = row.ts;
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    streamId: String(row.stream_id),
    seq: Number(row.seq),
    type: String(row.type),
    class: String(row.class) as EventRow["class"],
    v: Number(row.v),
    actor: String(row.actor),
    causation: row.causation === null || row.causation === undefined ? null : String(row.causation),
    ts: ts instanceof Date ? ts.toISOString() : String(ts),
    payload: row.payload,
  };
}

/**
 * §2: every stream that gained a fact decides again. The key carries the head it
 * decided on plus a unique suffix — never a bare `decide:<stream>`, which would
 * dedupe against the live lease of the very job that appended the facts and
 * strand them. Streams already receiving a `decide` in `jobs` (a delegation's
 * child) are skipped.
 */
export async function enqueueReDecides(
  tx: RuntimeTx,
  queue: Queue,
  workspaceId: string,
  streams: readonly string[],
  except: ReadonlySet<string> = new Set()
): Promise<void> {
  for (const streamId of new Set(streams)) {
    if (except.has(streamId)) continue;
    const head = await tx.query("select head from streams where id = $1", [streamId]);
    if (head.length === 0) continue;
    await queue.enqueue(tx, {
      type: "decide",
      key: `decide:${streamId}:h${Number(head[0]!.head)}:${randomUUID().slice(0, 8)}`,
      streamId,
      workspaceId,
    });
  }
}

/**
 * The `DecideDef` the fold's snapshot cannot carry whole: the definition record
 * supplies every knob it has, the stream id comes from the job, and the run's
 * `parent` — which `run.created` carries next to the definition, not inside it —
 * is injected by the caller from the stream's `run.created` (a run is a stream
 * whose log has one; a session's has none, and stays parent-less).
 */
function decideDefFrom(state: AgentState, streamId: string): DecideDef {
  const d = isRecord(state.def) ? state.def : {};
  const def: DecideDef = {
    streamId,
    tools: Array.isArray(d.tools) ? d.tools.filter((tool): tool is string => typeof tool === "string") : [],
    maxSteps: typeof d.maxSteps === "number" ? d.maxSteps : DEFAULT_MAX_STEPS,
  };
  if (typeof d.model === "string") def.model = d.model;
  if (typeof d.askWaitMs === "number") def.askWaitMs = d.askWaitMs;
  if (typeof d.turnCostCapUsd === "number" || d.turnCostCapUsd === null) {
    def.turnCostCapUsd = d.turnCostCapUsd as number | null;
  }
  if (isRecord(d.budget)) def.budget = d.budget as DecideDef["budget"];
  if (Array.isArray(d.surfaces)) {
    def.surfaces = d.surfaces.filter((surface): surface is string => typeof surface === "string");
  }
  if (isRecord(d.toolEffects)) def.toolEffects = d.toolEffects as DecideDef["toolEffects"];
  if (isRecord(d.dispositionKinds)) def.dispositionKinds = d.dispositionKinds as DecideDef["dispositionKinds"];
  if (isRecord(d.agents)) def.agents = d.agents as DecideDef["agents"];
  if (typeof d.userChosenAgent === "string") def.userChosenAgent = d.userChosenAgent;
  if (d.dispositionVirtual === false) def.dispositionVirtual = false;
  return def;
}

/** The job's causations: `<key>:<type>:<n>`, n counting within the type. */
function causationFor(key: string, type: string, ordinal: number): string {
  return `${key}:${type}:${ordinal}`;
}

/**
 * Run one claimed `decide` job. Errors fail the lease per the type's retry
 * config (`decide`: 3, then dead — the `run.blocked` escalation is the stall
 * watchdog's, §7) and rethrow, so the runner sees the failure too.
 */
export async function handleDecideJob(lease: QueueLease, deps: DecideJobDeps): Promise<void> {
  const { store, queue } = deps;
  const now = deps.now ?? (() => Date.now());
  const streamId = lease.streamId;
  if (streamId === null) throw new Error("decide job without a stream");

  try {
    await store.transaction(async (tx) => {
      const rows = await readEventRows(tx, streamId, lease.workspaceId);
      const state = fold(rows);
      const def = decideDefFrom(state, streamId);

      const created = rows.find((row) => row.type === "run.created");
      if (created !== undefined && isRecord((created.payload as Record<string, unknown>).parent)) {
        // A run: `run.created` carries the parent next to the definition (§3);
        // its presence is what makes decide's run-branches fire.
        def.parent = (created.payload as Record<string, unknown>).parent as DecideDef["parent"];
      }

      const decision = decideAgent(state, def, now());

      // ANY-98: the fold cannot see `agent.message` (telemetry by design), so a
      // second decide folding the same completion re-fires endTurn and duplicates
      // the reply — the re-decide the disposition fact queues, or a stale one
      // racing it. A reply already sitting past the stream's last fact means the
      // trigger was answered: this decide stands down (reply and its delivers).
      const lastFactSeq = rows.reduce((seq, row) => (row.class === "fact" ? row.seq : seq), 0);
      const replyAlreadyLanded = rows.some(
        (row) => row.type === "agent.message" && row.seq > lastFactSeq
      );
      const events = replyAlreadyLanded
        ? decision.events.filter((event) => event.type !== "agent.message")
        : decision.events;
      const jobs = replyAlreadyLanded
        ? decision.jobs.filter(
            (job) => !(job.type === "deliver" && job.key.startsWith("deliver:agent-message:"))
          )
        : decision.jobs;

      // -- one transaction: the decision's events, then its jobs ------------------
      const ordinals = new Map<string, number>();
      const batches = new Map<string, import("../store/types").EventInput[]>();
      for (const event of events) {
        const stream = event.streamId ?? streamId;
        const n = ordinals.get(event.type) ?? 0;
        ordinals.set(event.type, n + 1);
        const batch = batches.get(stream) ?? [];
        batch.push({
          type: event.type,
          actor: "decide",
          payload: event.payload,
          causation: causationFor(lease.key, event.type, n),
        });
        batches.set(stream, batch);
      }
      const batchList = [...batches.entries()].map(([stream, events]) => ({ streamId: stream, events }));
      const results = batchList.length > 0
        ? await append(tx, lease.workspaceId, batchList)
        : [];

      for (const job of jobs) {
        await queue.enqueue(tx, {
          type: job.type,
          key: job.key,
          streamId: job.streamId,
          workspaceId: lease.workspaceId,
          ...(job.runAt !== undefined ? { runAt: job.runAt } : {}),
        });
      }

      // §2: every stream that gained a fact decides again — the decision's own
      // appends included (a background delegation's completion re-opens the loop).
      // A telemetry-only append (endTurn's `agent.message`) re-decides nothing:
      // the fold skips telemetry, so that decide would face an unchanged state
      // and re-fire the same decision — the runaway agent.message loop (ANY-98).
      const decidedHere = new Set<string>(
        jobs.filter((job) => job.type === "decide").map((job) => job.streamId)
      );
      const touched = batchList
        .filter(
          (batch, index) =>
            results[index]!.duplicate === false &&
            batch.events.some((event) => eventClass(event.type) === "fact")
        )
        .map((batch) => batch.streamId);
      await enqueueReDecides(tx, queue, lease.workspaceId, touched, decidedHere);

      await queue.complete(tx, lease);
    });
  } catch (error) {
    await queue.fail(lease, error instanceof Error ? error : new Error(String(error)), {
      retryable: true,
    }, now());
    throw error;
  }
}
