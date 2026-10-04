// DANA's personal memory: a lazy bge-small embedder plus recall (MEM). The embedder lives here, not
// in @fabric/db — db takes raw vectors, so tests inject a fake and stay offline. Loaded once per
// process (q8, ~33 MB): the server warms it at boot so the first turn doesn't pay the load.
import { searchMemories } from "@fabric/db";
import type { MemoryHit } from "@fabric/db";
import type { Db } from "@fabric/db";
import type { FeatureExtractionPipeline } from "@huggingface/transformers";
import { countTokens } from "../context";

/** bge passage-search queries must carry this prefix; documents never do (bge-small card). */
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

let extractor: Promise<FeatureExtractionPipeline> | undefined;

/** The singleton pipeline: Xenova/bge-small-en-v1.5, 384-d, q8, CPU, lazy. */
function pipeline(): Promise<FeatureExtractionPipeline> {
  extractor ??= import("@huggingface/transformers").then(({ pipeline }) =>
    pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", { dtype: "q8" }));
  return extractor;
}

/** Document embeddings (the importer's path): no prefix. */
export async function embed(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  const run = await pipeline();
  return run(texts, { pooling: "cls", normalize: true }).then((t) => t.tolist());
}

/** Query embedding: the bge passage-search prefix, then the same model. */
export async function embedQuery(text: string): Promise<number[]> {
  const [vector] = await embed([QUERY_PREFIX + text]);
  return vector;
}

/** Loads the model once at server boot, so the first recall costs a query embed (~20–50 ms). */
export async function warmEmbedder(): Promise<void> {
  await pipeline();
}

export interface MemoryRecall {
  items: MemoryHit[];
  /** The rendered prompt section ("" when nothing was recalled). */
  content: string;
  tokens: number;
}

export interface RecallOpts {
  /** Injectable for offline tests; defaults to the real query embedder. */
  embed?: (query: string) => Promise<number[]>;
  k?: number;
}

/** The ≤ 6 item section appended to Dana's prompt, each with its source and date. */
export function renderMemorySection(items: MemoryHit[]): string {
  if (!items.length) return "";
  const day = (d: Date | null) =>
    d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
  const lines = items.map((m) => {
    const when = day(m.eventAt ?? m.createdAt);
    return `- ${m.text} (${m.source}${when ? ` · ${when}` : ""})`;
  });
  return [
    "## What you remember about Ty",
    "",
    ...lines,
    "",
    "Use these only when they're relevant to the request, and never repeat sensitive details (addresses, phone numbers, credentials), not even to confirm them.",
  ].join("\n");
}

/** Dana's recall for one turn: embed the query, hybrid-search her personal scope, render the section. */
export async function recallForDana(db: Db, text: string, opts: RecallOpts = {}): Promise<MemoryRecall> {
  const embedding = await (opts.embed ?? embedQuery)(text);
  const items = await searchMemories(db, {
    embedding, query: text, scope: "personal", scopeId: "dana", k: opts.k ?? 6,
  });
  const content = renderMemorySection(items);
  return { items, content, tokens: countTokens(content).tokens };
}
