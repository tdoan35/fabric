// The thread list (S11, ANY-61): the streams of one kind in a workspace,
// newest first by their head event's ts. A pure read — one query through the
// caller's store, identical SQL on both drivers. `before` is a keyset cursor
// (the last `streamId` of the previous page): the ordering is
// (updatedAt desc, streamId desc), so the next page is every stream strictly
// after it under the same comparison the order uses.
import type { RuntimeStore } from "./types";

export interface ListedStream {
  streamId: string;
  /** The stream's head seq. */
  headSeq: number;
  /** The head event's ts, in the store's own read shape. */
  updatedAt: string;
}

export interface ListStreamsOptions {
  /** The stream-id prefix: `session`, `run` or `agent`. */
  kind: string;
  /** Page size; a positive integer. */
  limit: number;
  /** Keyset cursor: the last `streamId` of the previous page. */
  before?: string;
}

const asTimestamp = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value);

/** The head event's ts of each `s` row — the value the ordering keys on. */
const headTsOfStream = (workspaceParam: string, streamRef: string): string =>
  `(select e.ts from events e where e.stream_id = ${streamRef} and e.workspace_id = ${workspaceParam} order by e.seq desc limit 1)`;

function toListedStream(row: Record<string, unknown>): ListedStream {
  return {
    streamId: String(row.stream_id),
    headSeq: Number(row.head),
    updatedAt: asTimestamp(row.updated_at),
  };
}

export async function listStreams(
  store: RuntimeStore,
  workspaceId: string,
  options: ListStreamsOptions
): Promise<ListedStream[]> {
  const limit = options.limit;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`listStreams limit must be a positive integer, got ${String(limit)}`);
  }

  // $1 workspace, $2 kind pattern; the cursor's own head ts is resolved in-query
  // so a page boundary is one round trip.
  const params: unknown[] = [workspaceId, `${options.kind}:%`];
  let beforeClause = "";
  if (options.before !== undefined) {
    params.push(options.before);
    const cursor = `$${params.length}`;
    const headOfStream = headTsOfStream("$1", "s.id");
    const headOfCursor = headTsOfStream("$1", cursor);
    beforeClause = `and (${headOfStream}, s.id) < (${headOfCursor}, ${cursor})`;
  }

  const rows = await store.transaction((tx) =>
    tx.query(
      `select s.id as stream_id, s.head, ${headTsOfStream("$1", "s.id")} as updated_at
       from streams s
       where s.workspace_id = $1 and s.id like $2 ${beforeClause}
       order by updated_at desc, s.id desc
       limit $${params.length + 1}`,
      [...params, limit]
    )
  );
  return rows.map(toListedStream);
}
