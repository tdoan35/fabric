// exa.search (§5.3 TOOLS 4): the recommended request shape, "fast" only on the live-start path,
// narration lines like the mock's, and the .cache/exa fallback when Exa is slow or down.
import { z } from "zod";
import type { ToolPolicy } from "@fabric/contracts";
import { exaNarration, exaSearch } from "../exa";
import { makeTool } from "../tool-context";
import type { ToolCtx } from "../tool-context";

export function exaSearchTool(policy: ToolPolicy, ctx: ToolCtx) {
  return makeTool(
    {
      name: "exa.search",
      description: "Search the web. Pass fast: true only when latency matters (a live start); leave it off for thorough searches.",
      inputSchema: z.object({
        query: z.string().min(2).describe("What to look for, phrased as retrieval intent"),
        fast: z.boolean().optional().describe("true on the live-start path (type: fast); omit otherwise"),
      }),
      policy,
      summary: (i) => `“${i.query}”${i.fast ? " · fast" : ""}`,
      target: (i) => i.query.slice(0, 60),
      run: async (i, io) => {
        await io.message(exaNarration.start(i.query, !!i.fast));
        const outcome = await exaSearch(i.query, !!i.fast);
        await io.message(exaNarration.done(outcome));
        return {
          count: outcome.results.length,
          cached: outcome.cached,
          ms: outcome.ms,
          results: outcome.results.map((r) => ({ title: r.title, url: r.url, publishedDate: r.publishedDate, highlights: r.highlights })),
        };
      },
    },
    ctx,
  );
}
