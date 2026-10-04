// MEM unit tests: recallForDana against a fake embedder (offline) and buildSystemPrompt's memory
// section — present when memory is recalled, absent otherwise, and never carrying sensitive text.
// DB-gated (like the db suite): recall runs the real searchMemories against the memories table.
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, loadRootEnv, searchMemories, upsertMemories } from "@fabric/db";
import type { MemoryUpsert } from "@fabric/db";
import { profileById } from "@fabric/fixtures/studio";
import { assistantContextSections, countTokens, measureAssistantContext } from "../context";
import { recallForDana, renderMemorySection } from "../memory";
import { buildSystemPrompt } from "../assistant/prompt";

loadRootEnv();
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

const vector = (axis: number): number[] => {
  const v = new Array<number>(384).fill(0);
  v[axis] = 1;
  return v;
};
/** The fake embedder: DGX queries map to axis 0, everything else to axis 0 at slightly less than 1. */
const fakeEmbed = async (query: string): Promise<number[]> => vector(0).map((x) => (x ? (/spark|dgx/i.test(query) ? 1 : 0.999) : x));
const upsert = (over: Partial<MemoryUpsert> & { id: string; text: string }): MemoryUpsert => ({
  scope: "personal", scopeId: "dana", kind: "canonical", source: "Mnemosyne · canonical/task:progress",
  importance: 1, eventAt: new Date("2026-09-22T19:00:00Z"), embedding: vector(0), ...over,
});

describe.skipIf(!migrated)("recallForDana with a fake embedder", () => {
  const db = (process.env.DATABASE_URL ? createDb() : undefined)!;

  beforeAll(async () => {
    await db.db.execute(sql`delete from memories where id like 'mnemo:agent-test:%'`);
    await upsertMemories(db, [
      upsert({ id: "mnemo:agent-test:dgx", text: "GLM-5.3-Flash TP2 is running on the DGX Spark pair" }),
      upsert({ id: "mnemo:agent-test:quiet", text: "unrelated note about an omarchy window fix", embedding: vector(1) }),
      // Sensitive rows are stored but never recalled, whatever the embedder says.
      upsert({ id: "mnemo:agent-test:secret", text: "Ty's address is 742 Evergreen Terrace", sensitive: true }),
      upsert({ id: "mnemo:agent-test:forgot", text: "GLM-5.3-Flash TP2 is running on the DGX Spark pair (stale copy)" }),
    ]);
    await db.db.execute(sql`update memories set forgotten_at = now() where id = 'mnemo:agent-test:forgot'`);
  });

  afterAll(async () => {
    await db.db.execute(sql`delete from memories where id like 'mnemo:agent-test:%'`);
    await db.close();
  });

  it("embeds the query once, returns ranked items, and renders the prompt section", async () => {
    const queries: string[] = [];
    const recall = await recallForDana(db, "what's running on my DGX Spark right now?", {
      embed: async (q) => { queries.push(q); return fakeEmbed(q); },
      k: 6,
    });
    expect(queries).toEqual(["what's running on my DGX Spark right now?"]);
    expect(recall.items[0].id).toBe("mnemo:agent-test:dgx"); // the axis-0 row wins on semantics alone
    expect(recall.items.some((m) => m.id === "mnemo:agent-test:forgot")).toBe(false); // forgotten
    expect(recall.items.some((m) => m.id === "mnemo:agent-test:secret")).toBe(false); // sensitive
    expect(recall.content).toContain("## What you remember about Ty");
    expect(recall.content).toContain("Mnemosyne · canonical/task:progress · Sep 22"); // source and date
    expect(recall.tokens).toBe(countTokens(recall.content).tokens);
    expect(recall.tokens).toBeGreaterThan(0);
  });

  it("the prompt carries the memory section with no sensitive text; without memory there is none", async () => {
    const dana = profileById("dana");
    const registry = { agents: [], teams: [], personaPool: [] };
    const memory = await recallForDana(db, "what's running on my DGX Spark right now?", { embed: fakeEmbed });
    const withMemory = buildSystemPrompt(dana, registry, memory);
    expect(withMemory).toContain("## What you remember about Ty");
    expect(withMemory).toContain("DGX Spark");
    expect(withMemory).not.toMatch(/Evergreen|742/); // the sensitive row's text never reaches the prompt
    expect(withMemory).toContain("never repeat sensitive details");
    expect(withMemory.indexOf("What you remember")).toBeGreaterThan(-1);
    expect(withMemory.indexOf("## Who exists")).toBeGreaterThan(withMemory.indexOf("What you remember")); // after her files

    const without = buildSystemPrompt(dana, registry);
    expect(without).not.toContain("What you remember");
  });

  it("searchMemories with the same fake embedder agrees with the recall", async () => {
    const embedding = await fakeEmbed("dgx");
    const hits = await searchMemories(db, { embedding, query: "dgx", scopeId: "dana" });
    expect(hits[0].id).toBe("mnemo:agent-test:dgx");
  });
});

describe("memory helpers (no DB)", () => {
  it("renderMemorySection renders items with source and date, or nothing", () => {
    const base = {
      id: "mnemo:x:1", scope: "personal", scopeId: "dana", kind: "canonical", text: "Ty runs models on a DGX Spark pair",
      source: "Mnemosyne · canonical/task:progress", importance: 1, pinned: false, sensitive: false,
      eventAt: new Date("2026-09-22T19:00:00Z"), createdAt: new Date("2026-09-24T00:00:00Z"),
    };
    expect(renderMemorySection([])).toBe("");
    const one = renderMemorySection([base]);
    expect(one).toContain("- Ty runs models on a DGX Spark pair (Mnemosyne · canonical/task:progress · Sep 22)");
    expect(one).toContain("never repeat sensitive details");
    const many = renderMemorySection(Array.from({ length: 8 }, (_, i) => ({ ...base, id: `mnemo:x:${i}`, text: `memory ${i}` })));
    expect(many.match(/^- memory \d \(/gm)).toHaveLength(8); // the renderer renders what it's given; the ≤6 cap is searchMemories' k
  });

  it("measureAssistantContext counts the recalled section; sections label it Mnemosyne · N items", () => {
    const dana = profileById("dana");
    const memory = {
      content: "## What you remember about Ty\n\n- GLM-5.3-Flash TP2 is running on the DGX Spark pair (Mnemosyne · canonical/task:progress · Sep 22)",
      items: 1,
    };
    const without = measureAssistantContext(dana);
    const withMemory = measureAssistantContext(dana, memory);
    expect(withMemory).toBeGreaterThan(without);

    const bare = assistantContextSections(dana);
    expect(bare.some((s) => s.label === "Personal memory")).toBe(false);
    const sections = assistantContextSections(dana, memory);
    const personal = sections.find((s) => s.label === "Personal memory")!;
    expect(personal.source).toBe("Mnemosyne · 1 items");
    expect(personal.tokens).toBe(countTokens(memory.content).tokens);
    expect(personal.estimated).toBe(true);
  });
});
