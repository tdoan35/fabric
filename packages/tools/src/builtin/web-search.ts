// web_search (ANY-72, ANY-44 D1 step 0): Exa search inside `tool.exec` on the
// server — no machine, no broker. The key comes from the vault through
// `scope.secret("exa")`; the client is injectable for tests.
import { z } from "zod";
import { defineTool } from "../define";
import type { ToolScope } from "../define";
import { defaultClients, type ExaLike } from "./clients";

/** The scope may carry a ready `exa` client (test injection); else the
 * default constructor builds one per call from the vault key. */
const exaFor = (scope: ToolScope, key: string): ExaLike => {
  const injected = (scope as Record<string, unknown>).exa as ExaLike | undefined;
  return injected ?? defaultClients.exa(key);
};

export const webSearchTool = () =>
  defineTool({
    name: "web_search",
    description:
      "Search the web. Returns the top hits as { title, url, snippet } — snippets are query-relevant excerpts, not full pages.",
    parameters: z.object({
      query: z.string().min(1).describe("The search query"),
      limit: z.number().int().min(1).max(10).optional().describe("Results to return (default 5)"),
    }),
    effect: "read",
    gate: "none",
    kind: "read",
    step: 0,
    async execute(args, ctx) {
      let key: string | undefined;
      try {
        key = await ctx.scope.secret?.("exa");
      } catch {
        key = undefined;
      }
      if (key === undefined) {
        return { ok: false, error: "web search is not configured (vault: exa)" };
      }

      const exa = exaFor(ctx.scope, key);
      const { results } = await exa.search(args.query, {
        numResults: args.limit ?? 5,
        contents: { highlights: true },
      });
      return {
        ok: true,
        results: results.map((hit) => ({
          title: hit.title ?? "",
          url: hit.url,
          snippet: hit.highlights?.[0] ?? hit.text ?? "",
        })),
      };
    },
  });
