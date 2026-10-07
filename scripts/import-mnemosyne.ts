#!/usr/bin/env node
// npm run memory:import [-- --dry-run] [--branch <name>]   (MEM)
//
// Imports Ty's Hermes Agent memory (the Mnemosyne plugin's SQLite store) into Neon as Fabric's
// `memories` table. The source holds PII: it is opened READ-ONLY, never copied into the repo,
// and `session_id` is never read (some values embed a phone number). Every kept row is
// re-embedded with bge-small-en-v1.5 (the stored vectors cover only rows we drop, and the int8
// vec_* tables aren't portable). Ids are `mnemo:<table>:<origin id>`, so re-running upserts the
// same rows: run it twice, the count doesn't move. --branch resolves URLs through the neon CLI;
// like seed, it never prints a connection string.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, loadRootEnv, upsertMemories } from "@fabric/db";
import type { MemoryUpsert } from "@fabric/db";
import { embed } from "@fabric/agents/memory";

const NEON_PROJECT = "solitary-meadow-39146227";
const DEFAULT_DB = "~/Desktop/fabric/mnemosyne/mnemosyne.db";
const EMBED_BATCH = 32;

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const dryRun = args.includes("--dry-run");

// ---- selection rules ----

interface Candidate {
  id: string;
  kind: string;
  text: string;
  source: string;
  importance: number;
  pinned: boolean;
  eventAt?: Date;
  /** Set by a selection rule (identity/* canonical facts); the regex pass adds more below. */
  sensitive?: boolean;
}

/** Rows that mention PII-flavored strings are stored but never recalled or listed. */
const SENSITIVE: [RegExp, string][] = [
  [/\+?1?[-. (]?\d{3}[-. )]\d{3}[-.]\d{4}/, "phone"],
  [/[\w.+-]+@[\w-]+\.[\w.]+/, "email"],
  [/\b\d{1,5}\s+\w+( \w+)* (st|street|ave|avenue|blvd|boulevard|rd|road|ln|lane|dr|drive|ct|court|way|ter|terrace|pl|place)\b/i, "address"],
  [/\b(password|passwd|api[ -]?key|apikey|token|secret|credential)s?\b/i, "credential"],
];

const flaggedSensitive = (text: string) =>
  SENSITIVE.filter(([re]) => re.test(text)).map(([, what]) => what);

const toDate = (s: string | null | undefined): Date | undefined => {
  if (!s) return undefined;
  const d = new Date(s); // the store's timestamps are naive → local, which is where they were written
  return Number.isNaN(d.getTime()) ? undefined : d;
};

async function candidates(): Promise<Candidate[]> {
  const file = (process.env.MNEMOSYNE_DB ?? DEFAULT_DB).replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
  const lite = new DatabaseSync(file, { readOnly: true });
  const out: Candidate[] = [];
  try {
    // Raw chat turns (`[USER] …` / `[ASSISTANT] …`) are noise, superseded rows are stale versions.
    const working = lite.prepare(`
      select id, content, memory_type, importance, timestamp, pinned from working_memory
      where superseded_by is null and content not like '[USER]%' and content not like '[ASSISTANT]%'`).all() as
      { id: string; content: string; memory_type: string; importance: number; timestamp: string; pinned: number }[];
    for (const r of working) {
      out.push({
        id: `mnemo:working_memory:${r.id}`, kind: r.memory_type || "context", text: r.content,
        source: `Mnemosyne · working/${r.memory_type || "context"}`, importance: r.importance,
        pinned: r.pinned === 1, eventAt: toDate(r.timestamp),
      });
    }

    // Consolidated episode summaries: keep all.
    const episodes = lite.prepare(`select id, content, importance, timestamp from episodic_memory`).all() as
      { id: string; content: string; importance: number; timestamp: string }[];
    for (const r of episodes) {
      out.push({
        id: `mnemo:episodic_memory:${r.id}`, kind: "episode", text: r.content,
        source: "Mnemosyne · episodic", importance: r.importance, pinned: false, eventAt: toDate(r.timestamp),
      });
    }

    // Current canonical facts only (valid_until set = a past version); identity/* is the address book.
    const canonical = lite.prepare(`select id, category, body, confidence, valid_from from canonical_facts where valid_until is null`).all() as
      { id: number; category: string; body: string; confidence: number; valid_from: string }[];
    for (const r of canonical) {
      out.push({
        id: `mnemo:canonical_facts:${r.id}`, kind: "canonical", text: r.body,
        source: `Mnemosyne · canonical/${r.category}`, importance: r.confidence, pinned: false,
        eventAt: toDate(r.valid_from), sensitive: r.category.startsWith("identity/"),
      });
    }

    // Fragments ("need to enable them") aren't worth a slot; dead instructions less so.
    const instructions = lite.prepare(`
      select min(id) as id, instruction from memoria_instructions
      where active = 1 and length(coalesce(instruction, '')) >= 25 group by instruction`).all() as
      { id: number; instruction: string }[];
    for (const r of instructions) {
      out.push({
        id: `mnemo:memoria_instructions:${r.id}`, kind: "instruction", text: r.instruction,
        source: "Mnemosyne · instructions", importance: 0.5, pinned: false,
      });
    }

    // Dedupe repeats; low importance so preference noise never crowds out facts in recall.
    const preferences = lite.prepare(`
      select min(id) as id, preference from memoria_preferences
      where length(coalesce(preference, '')) >= 25 group by preference`).all() as
      { id: number; preference: string }[];
    for (const r of preferences) {
      out.push({
        id: `mnemo:memoria_preferences:${r.id}`, kind: "preference", text: r.preference,
        source: "Mnemosyne · preferences", importance: 0.3, pinned: false,
      });
    }
  } finally {
    lite.close();
  }
  return out;
}

// ---- branch / env (same rules as seed.ts) ----

loadRootEnv();
const branch = flag("branch") ?? process.env.NEON_BRANCH;
const pooled = branch
  ? execFileSync("neon", ["connection-string", "--project-id", NEON_PROJECT, "--branch", branch, "--pooled"], { encoding: "utf8" }).trim().split("\n").pop()!.trim()
  : process.env.DATABASE_URL;
if (!pooled) throw new Error("DATABASE_URL missing (or pass --branch)");

const rows = await candidates();
const isSensitive = (r: Candidate) => !!r.sensitive || flaggedSensitive(r.text).length > 0;

const counts = (list: Candidate[]) => {
  const byKind: Record<string, number> = {};
  for (const r of list) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
  return byKind;
};

console.log(`mnemosyne import: ${rows.length} rows pass the selection rules`);
console.log(`  per kind: ${JSON.stringify(counts(rows))}`);
console.log(`  sensitive: ${rows.filter(isSensitive).length}`);

if (dryRun) {
  // Samples show selection quality; sensitive rows are exactly the ones we don't print.
  const byKind = new Map<string, Candidate[]>(rows.map((r) => [r.kind, []]));
  for (const r of rows) byKind.get(r.kind)!.push(r);
  for (const [kind, list] of [...byKind].sort()) {
    console.log(`\n[${kind}] ${list.length} rows, first 5:`);
    for (const r of list.slice(0, 5)) {
      console.log(`  ${r.id} · imp ${r.importance}${isSensitive(r) ? " · sensitive (withheld)" : ""}`);
      if (!isSensitive(r)) console.log(`    ${r.text.replace(/\s+/g, " ").slice(0, 140)}`);
    }
  }
  process.exit(0);
}

// ---- migrate, embed, upsert ----

{
  const unpooled = branch
    ? execFileSync("neon", ["connection-string", "--project-id", NEON_PROJECT, "--branch", branch], { encoding: "utf8" }).trim().split("\n").pop()!.trim()
    : process.env.DATABASE_URL_UNPOOLED;
  if (!unpooled) throw new Error("DATABASE_URL_UNPOOLED missing (or pass --branch)");
  const mig = createDb(unpooled);
  await migrate(mig.db, { migrationsFolder: path.resolve(import.meta.dirname, "../packages/db/drizzle") });
  await mig.close();
}

const db = createDb(pooled);
const started = Date.now();
const batch: MemoryUpsert[] = [];
let n = 0;
const flush = async () => {
  if (!batch.length) return;
  const vectors = await embed(batch.map((r) => r.text));
  n += await upsertMemories(db, batch.map((r, i) => ({ ...r, embedding: vectors[i] })));
  batch.length = 0;
};
for (const r of rows) {
  batch.push({
    id: r.id, scope: "personal", scopeId: "dana", kind: r.kind, text: r.text, source: r.source,
    importance: r.importance, pinned: r.pinned,
    sensitive: isSensitive(r), eventAt: r.eventAt ?? null,
  });
  if (batch.length >= EMBED_BATCH) await flush();
}
await flush();
await db.close();
console.log(`upserted ${n} memories in ${((Date.now() - started) / 1000).toFixed(1)}s${branch ? ` on branch ${branch}` : ""}`);
