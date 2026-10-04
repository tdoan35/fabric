// Memory reads/writes (DATA owns the tables; the import script and Dana's recall are the callers).
// Everything here takes raw vectors: @fabric/db never depends on the embedder —
// packages/agents/src/memory owns that, so tests can run offline with a fake.
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "./db";
import { memories } from "./schema";

/** One importable memory. Ids are stable (`mnemo:<table>:<origin id>`), so re-imports upsert. */
export interface MemoryUpsert {
  id: string;
  scope?: string; // personal | agent | team | run (CONCEPT §2.9)
  scopeId?: string;
  kind: string; // canonical | episode | instruction | preference | context | …
  text: string;
  source?: string;
  importance?: number;
  pinned?: boolean;
  sensitive?: boolean;
  /** When the memory is about (the origin's event time). */
  eventAt?: Date | null;
  createdAt?: Date;
  embedding: number[];
}

export interface MemoryHit {
  id: string;
  scope: string;
  scopeId: string;
  kind: string;
  text: string;
  source: string;
  importance: number;
  pinned: boolean;
  sensitive: boolean;
  eventAt: Date | null;
  createdAt: Date;
  score?: number;
}

const vectorLiteral = (embedding: number[]) => `[${embedding.join(",")}]`;

const hit = (r: typeof memories.$inferSelect): MemoryHit => ({
  id: r.id, scope: r.scope, scopeId: r.scopeId, kind: r.kind, text: r.text, source: r.source,
  importance: r.importance, pinned: r.pinned, sensitive: r.sensitive, eventAt: r.eventAt, createdAt: r.createdAt,
});

/** Drizzle's raw execute hands timestamptz back as text; normalize to Date (pg's own parser does Date). */
const toDate = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));

/** pgvector's text form; node-postgres sends it as a bound parameter, so no injection surface. */
const VECTOR_CHUNK = 64;

/**
 * Idempotent upsert: content, flags and the embedding track the source, but `pinned` and
 * `forgotten_at` are the user's decisions (Keep/Forget) and survive a re-import.
 */
export async function upsertMemories(db: Db, rows: MemoryUpsert[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < rows.length; i += VECTOR_CHUNK) {
    await db.db.insert(memories).values(rows.slice(i, i + VECTOR_CHUNK).map((r) => ({
      id: r.id, scope: r.scope ?? "personal", scopeId: r.scopeId ?? "dana", kind: r.kind, text: r.text,
      source: r.source ?? "", importance: r.importance ?? 0.5, pinned: r.pinned ?? false,
      sensitive: r.sensitive ?? false, eventAt: r.eventAt ?? null, createdAt: r.createdAt,
      embedding: r.embedding,
    }))).onConflictDoUpdate({
      target: memories.id,
      set: {
        kind: sql`excluded.kind`, text: sql`excluded.text`, source: sql`excluded.source`,
        importance: sql`excluded.importance`, sensitive: sql`excluded.sensitive`,
        eventAt: sql`excluded.event_at`, embedding: sql`excluded.embedding`,
      },
    });
    n += Math.min(VECTOR_CHUNK, rows.length - i);
  }
  return n;
}

export interface MemorySearch {
  embedding: number[];
  query: string;
  scope?: string;
  scopeId?: string;
  k?: number; // 6
  minImportance?: number; // 0.3
  includeSensitive?: boolean; // false
}

/**
 * One hybrid query with Mnemosyne's own weights: 0.5·(1−cosine distance) + 0.3·normalized
 * ts_rank_cd + 0.2·importance, plus a small pinned boost. The lexical rank normalizes against the
 * best row of the candidate set, so the three terms share a 0–1 scale. Exact scan: ~200 rows.
 */
export async function searchMemories(db: Db, s: MemorySearch): Promise<MemoryHit[]> {
  const rows = await db.db.execute(sql`
    with q as (select ${vectorLiteral(s.embedding)}::vector as emb, plainto_tsquery('english', ${s.query}) as tsq),
    scored as (
      select m.id, m.scope, m.scope_id, m.kind, m.text, m.source, m.importance, m.pinned, m.sensitive,
             m.event_at, m.created_at,
             1 - (m.embedding <=> q.emb) as semantic,
             ts_rank_cd(m.tsv, q.tsq) as lexical
      from memories m, q
      where m.forgotten_at is null and m.embedding is not null
        and m.importance >= ${s.minImportance ?? 0.3}
        and (${s.includeSensitive ?? false} or not m.sensitive)
        ${s.scope ? sql`and m.scope = ${s.scope}` : sql``}
        ${s.scopeId ? sql`and m.scope_id = ${s.scopeId}` : sql``}
    )
    select id, scope, scope_id as "scopeId", kind, text, source, importance, pinned, sensitive,
           event_at as "eventAt", created_at as "createdAt",
           0.5 * semantic + 0.3 * coalesce(lexical / nullif(max(lexical) over (), 0), 0)
             + 0.2 * importance + (case when pinned then 0.1 else 0 end) as score
    from scored
    order by score desc
    limit ${s.k ?? 6}`);
  // Our own SELECT shape; drizzle hands timestamptz (and sometimes numerics) back as text.
  return (rows.rows as unknown as MemoryHit[]).map((h) => ({
    ...h,
    importance: Number(h.importance),
    pinned: Boolean(h.pinned),
    sensitive: Boolean(h.sensitive),
    eventAt: h.eventAt ? toDate(h.eventAt) : null,
    createdAt: toDate(h.createdAt),
    score: h.score === undefined ? undefined : Number(h.score),
  }));
}

export interface MemoryList {
  scopeId?: string; // "dana"
  limit?: number; // 20
  includeSensitive?: boolean; // false
  /** "recent" sorts by event time only (Weave pulse); default is pinned first, then importance. */
  recent?: boolean;
}

/** For the Memory tabs: pinned first, then importance, then recency. */
export async function listMemories(db: Db, opts: MemoryList = {}): Promise<MemoryHit[]> {
  const rows = await db.db.select().from(memories).where(and(
    sql`forgotten_at is null`,
    eq(memories.scopeId, opts.scopeId ?? "dana"),
    ...(opts.includeSensitive ? [] : [eq(memories.sensitive, false)]),
  )).orderBy(
    ...(opts.recent ? [] : [desc(memories.pinned), desc(memories.importance)]),
    desc(sql`coalesce(event_at, created_at)`),
  ).limit(opts.limit ?? 20);
  return rows.map(hit);
}

/** A Keep decision pins (recall boost + top of the tab) and clears a past Forget; a Forget soft-deletes. */
export async function decideMemory(db: Db, id: string, decision: "kept" | "forgotten"): Promise<MemoryHit | undefined> {
  const rows = await db.db.update(memories)
    .set(decision === "kept" ? { pinned: true, forgottenAt: null } : { forgottenAt: new Date() })
    .where(eq(memories.id, id))
    .returning();
  return rows[0] ? hit(rows[0]) : undefined;
}
