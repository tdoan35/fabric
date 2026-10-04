// MEM: searchMemories' ranking (Mnemosyne weights + pinned boost) and the sensitive/forgotten
// filters, plus upsert idempotency and Keep/Forget. DB-gated like writer-race: skips without
// DATABASE_URL, and on branches the 0004 migration hasn't reached yet.
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, decideMemory, listMemories, loadRootEnv, searchMemories, upsertMemories } from "../index";
import type { Db, MemoryUpsert } from "../index";

loadRootEnv(); // the suite is DB-gated; .env supplies DATABASE_URL
// Detected before the describes register (the contract suite's pattern): skip without DATABASE_URL,
// and on branches the 0004 migration hasn't reached yet.
const migrated = await (async () => {
  if (!process.env.DATABASE_URL) return false;
  const db = createDb();
  try {
    await db.db.execute(sql`select 1 from memories limit 1`);
    return true;
  } catch {
    return false;
  } finally {
    await db.close();
  }
})();

const dims = (weights: [number, number][]): number[] => {
  const v = new Array<number>(384).fill(0);
  weights.forEach(([i, w]) => { v[i] = w; });
  return v;
};

const row = (over: Partial<MemoryUpsert> & { id: string; text: string }): MemoryUpsert => ({
  scope: "personal", scopeId: "dana", kind: "fact", source: "test", importance: 0.5,
  eventAt: new Date("2026-09-20T10:00:00Z"), embedding: dims([[0, 1]]), ...over,
});

describe.skipIf(!migrated)("memories: ranking, filters, decisions", () => {
  const db = (process.env.DATABASE_URL ? createDb() : undefined)!;
  const ids = ["mnemo:test:rank-a", "mnemo:test:rank-b", "mnemo:test:low", "mnemo:test:secret", "mnemo:test:pinned", "mnemo:test:plain"];

  /** `select count(*)` reader: narrows the one field the suite reads (in-guard, no unchecked cast). */
  const countOf = (rows: Record<string, unknown>[]): number => {
    const first = rows[0];
    return first && "n" in first ? Number(first.n) : NaN;
  };

  beforeAll(async () => {
    await db.db.execute(sql`delete from memories where id like 'mnemo:test:%'`);
    await upsertMemories(db, [
      // Semantic winner: the query vector is e_a; its text shares only "serving" with the query.
      row({ id: ids[0], text: "serving recipe alpha", embedding: dims([[0, 1]]) }),
      // Lexical winner: text matches the query exactly, but its vector is orthogonal.
      row({ id: ids[1], text: "the dgx spark serving status", embedding: dims([[2, 1]]) }),
      // Below minImportance, sensitive, and (later) forgotten rows must never come back.
      row({ id: ids[2], text: "serving recipe alpha", embedding: dims([[0, 1]]), importance: 0.2 }),
      row({ id: ids[3], text: "home is at 742 Evergreen Terrace", embedding: dims([[0, 1]]), sensitive: true }),
      row({ id: ids[4], text: "ty wants terse updates", embedding: dims([[0, 1]]), pinned: true }),
      // The pinned row's twin: same text, vector and importance, no pin — isolates the boost.
      row({ id: "mnemo:test:pin-twin", text: "ty wants terse updates", embedding: dims([[0, 1]]) }),
      row({ id: ids[5], text: "omarchy is the arch install", embedding: dims([[0, 1]]) }),
    ]);
  });

  afterAll(async () => {
    await db.db.execute(sql`delete from memories where id like 'mnemo:test:%'`);
    await db.close();
  });

  it("upserting the same rows twice leaves the count unchanged (idempotent)", async () => {
    const count = sql`select count(*) as n from memories where id like 'mnemo:test:%'`;
    const before = countOf((await db.db.execute(count)).rows);
    await upsertMemories(db, [row({ id: ids[0], text: "serving recipe alpha" })]);
    const after = countOf((await db.db.execute(count)).rows);
    expect(after).toBe(before);
  });

  it("ranks with 0.5·semantic + 0.3·lexical + 0.2·importance: semantic wins here, lexical is close", async () => {
    const hits = await searchMemories(db, { embedding: dims([[0, 1]]), query: "the dgx spark serving status", scopeId: "dana", k: 6 });
    const scored = hits.filter((h) => h.id === ids[0] || h.id === ids[1]);
    expect(scored[0].id).toBe(ids[0]); // 0.5·1 semantic beats 0.3·1 normalized lexical
    // No lexical overlap at all: the weights reduce to 0.5·semantic + 0.2·importance, exactly.
    const quiet = await searchMemories(db, { embedding: dims([[0, 1]]), query: "zzzq unrelated", scopeId: "dana", k: 6 });
    const a = quiet.find((h) => h.id === ids[0])!;
    expect(a.score).toBeCloseTo(0.5 + 0.2 * 0.5, 5);
  });

  it("the pinned boost orders an otherwise-identical row first", async () => {
    const hits = await searchMemories(db, { embedding: dims([[0, 1]]), query: "terse updates", scopeId: "dana", k: 6 });
    const pair = hits.filter((h) => h.id === ids[4] || h.id === "mnemo:test:pin-twin");
    expect(pair.map((h) => h.id)).toEqual([ids[4], "mnemo:test:pin-twin"]);
    expect(pair[0].score! - pair[1].score!).toBeCloseTo(0.1, 5); // exactly the pin boost
  });

  it("never returns sensitive rows unless includeSensitive", async () => {
    const hits = await searchMemories(db, { embedding: dims([[0, 1]]), query: "evergreen terrace home", scopeId: "dana", k: 6 });
    expect(hits.some((h) => h.id === ids[3])).toBe(false);
    const withSensitive = await searchMemories(db, { embedding: dims([[0, 1]]), query: "evergreen terrace home", scopeId: "dana", k: 6, includeSensitive: true });
    expect(withSensitive.some((h) => h.id === ids[3])).toBe(true);
  });

  it("never returns rows below minImportance or outside the scope", async () => {
    const hits = await searchMemories(db, { embedding: dims([[0, 1]]), query: "serving recipe alpha", scopeId: "dana", k: 6 });
    expect(hits.some((h) => h.id === ids[2])).toBe(false); // importance 0.2 < 0.3
    const otherScope = await searchMemories(db, { embedding: dims([[0, 1]]), query: "serving recipe alpha", scopeId: "jonah", k: 6 });
    expect(otherScope).toEqual([]);
  });

  it("Forget soft-deletes: recall and lists stop serving it; Keep pins it back to the top", async () => {
    await decideMemory(db, ids[5], "forgotten");
    const afterForget = await searchMemories(db, { embedding: dims([[0, 1]]), query: "omarchy arch install", scopeId: "dana", k: 6 });
    expect(afterForget.some((h) => h.id === ids[5])).toBe(false);
    const listed = await listMemories(db, { scopeId: "dana", limit: 50 });
    expect(listed.some((m) => m.id === ids[5])).toBe(false);

    await decideMemory(db, ids[5], "kept");
    const afterKeep = await searchMemories(db, { embedding: dims([[0, 1]]), query: "omarchy arch install", scopeId: "dana", k: 6 });
    expect(afterKeep[0].id).toBe(ids[5]); // restored (un-forgotten), pinned, and lexically on top
    const top = await listMemories(db, { scopeId: "dana", limit: 50 });
    expect([ids[4], ids[5]]).toContain(top[0].id); // both pinned now; importance ties, recency decides
  });

  it("lists pinned first, then importance, then recency (the Memory tab order)", async () => {
    const listed = await listMemories(db, { scopeId: "dana", limit: 50 });
    const test = listed.filter((m) => m.id.startsWith("mnemo:test:"));
    expect(test[0].pinned).toBe(true);
    const unpinned = test.filter((m) => !m.pinned);
    for (let i = 1; i < unpinned.length; i++) {
      const prev = unpinned[i - 1], cur = unpinned[i];
      expect(prev.importance).toBeGreaterThanOrEqual(cur.importance);
    }
  });
});
