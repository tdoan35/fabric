// The store itself (RUNTIME §2): one transaction per append — bump each touched head,
// insert consecutive seqs, queue decide for fact-bearing streams inside the tx, notify
// after commit. Identical SQL on both drivers; the adapter is the only difference.
import { eventClass } from "@fabric/core";
import { randomUUID } from "node:crypto";
import type { Adapter } from "./adapter";
import { migrate } from "./migrate";
import { PgliteAdapter } from "./pglite";
import { PostgresAdapter } from "./postgres";
import type {
  AppendBatch,
  AppendResult,
  Row,
  RuntimeStore,
  RuntimeTx,
  StoreConfig,
  StoredEvent,
} from "./types";

export async function openStore(config: StoreConfig): Promise<RuntimeStore> {
  const adapter =
    config.driver === "pglite"
      ? new PgliteAdapter(config.dataDir)
      : new PostgresAdapter(config.url);
  try {
    await migrate(adapter);
  } catch (error) {
    await adapter.close();
    throw error;
  }
  return new Store(adapter);
}

class Store implements RuntimeStore {
  constructor(private readonly adapter: Adapter) {}

  transaction<T>(run: (tx: RuntimeTx) => Promise<T>): Promise<T> {
    return this.adapter.transaction(run);
  }

  async readStream(
    streamId: string,
    options: import("./types").ReadStreamOptions
  ): Promise<StoredEvent[]> {
    const clauses = ["stream_id = $1", "workspace_id = $2"];
    const params: unknown[] = [streamId, options.workspaceId];
    if (options.fromSeq !== undefined) {
      params.push(options.fromSeq);
      clauses.push(`seq >= $${params.length}`);
    }
    if (options.factsOnly === true) clauses.push("class = 'fact'");
    const rows = await this.adapter.query(
      `select id, workspace_id, stream_id, seq, type, class, v, actor, causation, ts, payload
       from events where ${clauses.join(" and ")} order by seq asc`,
      params
    );
    return rows.map(toStoredEvent);
  }

  async close(): Promise<void> {
    await this.adapter.close();
  }
}

function toStoredEvent(row: Row): StoredEvent {
  const ts: unknown = row.ts;
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    streamId: String(row.stream_id),
    seq: Number(row.seq),
    type: String(row.type),
    class: String(row.class),
    v: Number(row.v),
    actor: String(row.actor),
    causation: row.causation === null || row.causation === undefined ? null : String(row.causation),
    ts: ts instanceof Date ? ts.toISOString() : String(ts),
    payload: row.payload,
  };
}

/**
 * One transaction over every batch: heads bump, `seq` runs consecutively, the enqueue
 * port sees the same transaction, notifications fire after commit. A batch whose fact
 * causations are all already on the stream is a recorded no-op (`duplicate: true`);
 * the other batches in the call still apply.
 */
export async function append(
  tx: RuntimeTx,
  workspaceId: string,
  batches: readonly AppendBatch[],
  options: import("./types").AppendOptions = {}
): Promise<AppendResult[]> {
  const results: AppendResult[] = [];
  const heads = new Map<string, number>();
  const factStreams = new Set<string>();

  for (const batch of batches) {
    const events = batch.events.map((event) => {
      const cls = eventClass(event.type);
      if (cls === undefined) throw new Error(`unknown event type: ${event.type}`);
      const v = event.v ?? 1;
      if (!Number.isInteger(v) || v < 1) {
        throw new Error(`event v must be a positive integer, got ${String(event.v)}`);
      }
      return { ...event, v, class: cls };
    });

    // Duplicate check: every fact causation the batch carries is already on the stream.
    const causations = [
      ...new Set(
        events
          .filter((event) => event.class === "fact" && typeof event.causation === "string")
          .map((event) => event.causation as string)
      ),
    ];
    let duplicate = false;
    if (causations.length > 0) {
      const rows = await tx.query(
        "select causation from events where stream_id = $1 and class = 'fact' and causation = any($2)",
        [batch.streamId, causations]
      );
      const known = new Set(rows.map((row) => row.causation));
      duplicate = causations.every((causation) => known.has(causation));
    }
    if (duplicate) {
      results.push({ duplicate: true });
      continue;
    }

    await tx.query(
      "insert into streams (id, workspace_id, head) values ($1, $2, 0) on conflict do nothing",
      [batch.streamId, workspaceId]
    );
    const locked = await tx.query("select head from streams where id = $1 for update", [
      batch.streamId,
    ]);
    let seq = locked.length === 0 ? 0 : Number(locked[0].head);

    for (const event of events) {
      seq += 1;
      await tx.query(
        `insert into events
           (id, workspace_id, stream_id, seq, type, class, v, actor, causation, ts, payload)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         on conflict do nothing`,
        [
          randomUUID(),
          workspaceId,
          batch.streamId,
          seq,
          event.type,
          event.class,
          event.v,
          event.actor,
          event.causation ?? null,
          new Date().toISOString(),
          event.payload === undefined ? null : JSON.stringify(event.payload),
        ]
      );
    }
    await tx.query("update streams set head = $2 where id = $1", [batch.streamId, seq]);
    heads.set(batch.streamId, seq);
    if (events.some((event) => event.class === "fact")) factStreams.add(batch.streamId);
    results.push({ duplicate: false });
  }

  for (const [streamId, head] of heads) {
    const note = `${workspaceId}:${streamId}:${head}`;
    tx.onCommit(() => options.onNotify?.(note));
  }
  for (const streamId of factStreams) {
    await options.enqueue?.(tx, { type: "decide", streamId });
  }
  return results;
}
