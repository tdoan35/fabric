// Exa (S7): Megan's search. The request is exactly the skill's recommended shape — query plus
// contents: {highlights: true} and nothing else — with `type: "fast"` only on the live-start
// path, where latency matters (§5.3 TOOLS 4). The last results per query are cached under
// .cache/exa/ and serve as the labelled fallback when Exa is slow or down (ARCH §11).
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import Exa from "exa-js";
import { env } from "./env";

const CACHE_DIR = path.resolve(".cache/exa");
/** Fast is the live-start path (target < 2 s); auto is deeper. Both fall back to the cache. */
const TIMEOUT_MS = 8000;

export interface ExaHit {
  title: string;
  url: string;
  publishedDate?: string;
  highlights: string[];
}

export interface ExaSearchOutcome {
  results: ExaHit[];
  /** True when this came from the cache (Exa timed out or errored). */
  cached: boolean;
  ms: number;
}

export function exaClient(): Exa {
  const key = env("EXA_API_KEY");
  if (!key) throw new Error("EXA_API_KEY is not set: exa.search needs it");
  return new Exa(key);
}

const cacheFile = (query: string, fast: boolean): string =>
  path.join(CACHE_DIR, `${createHash("sha256").update(`${fast ? "fast" : "auto"}\u0000${query}`).digest("hex")}.json`);

async function readCache(query: string, fast: boolean): Promise<ExaHit[] | undefined> {
  try {
    const parsed = JSON.parse(await readFile(cacheFile(query, fast), "utf8")) as { results?: ExaHit[] };
    return Array.isArray(parsed.results) ? parsed.results : undefined;
  } catch {
    return undefined; // no cache yet: the first run of a query has no fallback
  }
}

async function writeCache(query: string, fast: boolean, results: ExaHit[]): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cacheFile(query, fast), JSON.stringify({ query, fast, cachedAt: new Date().toISOString(), results }));
  } catch (err) {
    console.log(`[tools] exa cache write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** One search, with the cache fallback. Never throws: a failure degrades to cached results. */
export async function exaSearch(query: string, fast: boolean, client: Exa = exaClient()): Promise<ExaSearchOutcome> {
  const started = Date.now();
  const body = fast ? { type: "fast" as const, contents: { highlights: true } } : { contents: { highlights: true } };
  try {
    const raw = (await Promise.race([
      client.search(query, body as never) as Promise<{ results: { title?: string; url: string; publishedDate?: string; highlights?: string[] }[] }>,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`exa timed out after ${TIMEOUT_MS} ms`)), TIMEOUT_MS)),
    ])).results;
    const results: ExaHit[] = raw.map((r) => ({
      title: r.title ?? r.url,
      url: r.url,
      publishedDate: r.publishedDate,
      highlights: r.highlights ?? [],
    }));
    await writeCache(query, fast, results);
    return { results, cached: false, ms: Date.now() - started };
  } catch (err) {
    const results = await readCache(query, fast);
    if (!results) throw err;
    return { results, cached: true, ms: Date.now() - started };
  }
}

/** The mock's narration lines, so Megan's lane reads the same live as recorded (§5.3 TOOLS 4). */
export const exaNarration = {
  start: (query: string, fast: boolean) => `exa.search “${query}”${fast ? " · fast" : ""}`,
  done: (outcome: ExaSearchOutcome) =>
    `${outcome.results.length} results · ${outcome.results.filter((r) => r.highlights.length > 0).length} highlights kept${outcome.cached ? " (cached)" : ""}`,
};
