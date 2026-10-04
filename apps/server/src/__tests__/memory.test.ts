// MEM contract: POST /memories/:id/decision (validation, 404, kept/forgotten side effects) and the
// /registry additive change — dana's workspace.memories carry `id`s that the Memory tabs act on.
// DB-gated: runs where DATABASE_URL points at a migrated branch, like contract.test.ts.
import { createDb, sql, upsertMemories } from "@fabric/db";
import type { MemoryUpsert } from "@fabric/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { RegistrySchema } from "@fabric/contracts";
import type { Registry } from "@fabric/contracts";
import { corsOrigins } from "../env";
import { memory } from "../routes/memory";
import { registry } from "../routes/registry";

const db = process.env.DATABASE_URL ? createDb() : undefined;

const migrated = db ? await (async () => {
  try {
    await db.db.execute(sql`select 1 from memories limit 1`);
    return true;
  } catch {
    return false;
  }
})() : false;
if (!migrated) await db?.close(); // a skipped suite leaves no pool open

const upsert = (over: Partial<MemoryUpsert> & { id: string; text: string }): MemoryUpsert => ({
  scope: "personal", scopeId: "dana", kind: "canonical", source: "Mnemosyne · canonical/task:progress",
  importance: 1, eventAt: new Date("2026-09-22T19:00:00Z"), embedding: Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)),
  ...over,
});

describe.skipIf(!migrated)("contract: memory decisions and registry memory ids", () => {
  const app = new Hono()
    .route("/api", new Hono().route("/", registry).route("/", memory));

  const post = async (path: string, body: unknown): Promise<Response> =>
    app.request(path, { method: "POST", headers: { "Content-Type": "application/json", Origin: "app://fabric" }, body: JSON.stringify(body) });

  beforeAll(async () => {
    if (!db) return;
    await db.db.execute(sql`delete from memories where id like 'mnemo:contract-test:%'`);
    await upsertMemories(db, [
      upsert({ id: "mnemo:contract-test:keep", text: "contract test row to keep" }),
      upsert({ id: "mnemo:contract-test:forget", text: "contract test row to forget" }),
    ]);
  });

  afterAll(async () => {
    if (!db) return;
    await db.db.execute(sql`delete from memories where id like 'mnemo:contract-test:%'`);
    await db.close();
  });

  it("POST /api/memories/:id/decision rejects a bad body (400) and an unknown id (404)", async () => {
    expect((await post("/api/memories/x/decision", { decision: "deleted" })).status).toBe(400);
    expect((await post("/api/memories/x/decision", {})).status).toBe(400);
    const missing = await post("/api/memories/mnemo:contract-test:none/decision", { decision: "kept" });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { owner?: string }).owner).toBe("MEM");
  });

  it("kept pins and forgotten soft-deletes, and the response says which", async () => {
    const kept = await post("/api/memories/mnemo:contract-test:keep/decision", { decision: "kept" });
    expect(kept.status).toBe(200);
    expect(await kept.json()).toEqual({ ok: true, id: "mnemo:contract-test:keep", decision: "kept" });
    const pinnedRow = (await db!.db.execute(sql`select pinned from memories where id = 'mnemo:contract-test:keep'`)).rows[0];
    expect(!!pinnedRow && "pinned" in pinnedRow && Boolean(pinnedRow.pinned)).toBe(true);

    const forgotten = await post("/api/memories/mnemo:contract-test:forget/decision", { decision: "forgotten" });
    expect(forgotten.status).toBe(200);
    const goneRow = (await db!.db.execute(sql`select forgotten_at from memories where id = 'mnemo:contract-test:forget'`)).rows[0];
    expect(!!goneRow && "forgotten_at" in goneRow && goneRow.forgotten_at !== null).toBe(true);
  });

  it("GET /api/registry serves dana's memories with ids that validate against the contract", async () => {
    const res = await app.request("/api/registry", { headers: { Origin: "app://fabric" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Registry;
    expect(() => RegistrySchema.parse(body)).not.toThrow();
    // `id` is additive: branches with the Mnemosyne import serve mnemo: ids; un-imported branches
    // keep the seeded JSON (no ids). Both must validate.
    const imported = await db!.db.execute(sql`select count(*) as n from memories where not sensitive`);
    const first = imported.rows[0];
    const hasRows = !!first && "n" in first && Number(first.n) > 0;
    const dana = body.agents.find((p) => p.agent.id === "dana")!;
    const ids = dana.workspace.memories.filter((m) => m.id !== undefined).map((m) => m.id!);
    if (hasRows) expect(ids.some((id) => id.startsWith("mnemo:"))).toBe(true);
    else expect(ids).toEqual([]);
  });
});
