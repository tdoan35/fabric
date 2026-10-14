// The erasure (S11, ANY-61) — the one sanctioned exception to the append-only
// rule (LEARNING §10.4): an incognito purge rewrites the text-bearing payload
// fields of the given event types in place and appends one `content.erased`
// marker, all in a single transaction. Everything else about an event — its
// seq, type, id, v, the event count — never moves, which is why this module is
// the only place allowed to UPDATE an event row.
import { randomUUID } from "node:crypto";
import type { RuntimeStore, RuntimeTx } from "./types";

/** The replacement every text-bearing field receives. */
export const ERASED = "[erased]";

export interface RedactOptions {
  /** The event types whose text-bearing fields get erased. */
  types: readonly string[];
  /** The erasure instant — the `content.erased` marker's ts, injected so the
   * purge runs on the caller's clock. */
  at: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The payload with its listed fields erased; `undefined` when the payload is
 * not an object (nothing to erase). Container-typed fields keep their shape —
 * a string "[erased]" would fail `parseEvent` on read — so `tool.call.args`
 * empties to `{}` and `considered` to `[]`; everything else becomes the
 * "[erased]" string. `attachments` empties wherever the field is present.
 */
function redactPayload(type: string, payload: unknown): Record<string, unknown> | undefined {
  if (!isRecord(payload)) return undefined;
  const next: Record<string, unknown> = { ...payload };
  switch (type) {
    case "message.received":
      next["text"] = ERASED;
      if ("attachments" in next) next["attachments"] = [];
      break;
    case "llm.completed": {
      next["text"] = ERASED;
      if (Array.isArray(next["toolCalls"])) {
        next["toolCalls"] = (next["toolCalls"] as unknown[]).map((call) =>
          isRecord(call) ? { ...call, args: ERASED } : call
        );
      }
      break;
    }
    case "agent.message":
      next["text"] = ERASED;
      break;
    case "tool.call":
      if ("args" in next) next["args"] = {};
      break;
    case "tool.completed":
      if ("result" in next) next["result"] = ERASED;
      break;
    case "tool.result":
      next["line"] = ERASED;
      break;
    case "disposition.recorded":
      next["reason"] = ERASED;
      if ("considered" in next) next["considered"] = [];
      break;
    default:
      break; // A type without listed fields: the payload survives unchanged.
  }
  return next;
}

async function redactInTx(
  tx: RuntimeTx,
  workspaceId: string,
  streamId: string,
  types: readonly string[],
  at: number
): Promise<number> {
  let changed = 0;
  if (types.length > 0) {
    const placeholders = types.map((_, index) => `$${index + 3}`).join(", ");
    const rows = await tx.query(
      `select id, type, payload from events
       where stream_id = $1 and workspace_id = $2 and type in (${placeholders})
       order by seq`,
      [streamId, workspaceId, ...types]
    );
    for (const row of rows) {
      const next = redactPayload(String(row.type), row.payload);
      if (next === undefined) continue;
      if (JSON.stringify(next) === JSON.stringify(row.payload)) continue;
      await tx.query(`update events set payload = $1 where id = $2 and workspace_id = $3`, [
        JSON.stringify(next),
        String(row.id),
        workspaceId,
      ]);
      changed += 1;
    }
  }

  // The marker: head-locked like any append, one seq past the head.
  await tx.query(`insert into streams (id, workspace_id, head) values ($1, $2, 0) on conflict do nothing`, [
    streamId,
    workspaceId,
  ]);
  const locked = await tx.query(`select head from streams where id = $1 for update`, [streamId]);
  const seq = (locked.length === 0 ? 0 : Number(locked[0]!.head)) + 1;
  await tx.query(
    `insert into events
       (id, workspace_id, stream_id, seq, type, class, v, actor, causation, ts, payload)
     values ($1, $2, $3, $4, 'content.erased', 'fact', 1, 'system', null, $5, $6)`,
    [
      randomUUID(),
      workspaceId,
      streamId,
      seq,
      new Date(at).toISOString(),
      JSON.stringify({ contentRef: streamId, reason: "incognito", by: "system" }),
    ]
  );
  await tx.query(`update streams set head = $2 where id = $1`, [streamId, seq]);
  return changed;
}

/**
 * Erase `streamId`'s text in one transaction; returns the number of events
 * whose payload changed. Safe to run inside a caller's transaction (the purge
 * job's completion shares it): the nested transaction joins per R13.
 */
export async function redactStream(
  store: RuntimeStore,
  workspaceId: string,
  streamId: string,
  options: RedactOptions
): Promise<number> {
  return store.transaction((tx) =>
    redactInTx(tx, workspaceId, streamId, options.types, options.at)
  );
}
