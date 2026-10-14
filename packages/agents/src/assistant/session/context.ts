// The session context (ANY-56 S7): what one model call sees, assembled the way
// `assistant/index.ts` assembled it in-process — the definition's system prompt,
// plus the facts recalled for this turn's newest user text as a memory section.
// An incognito session (PRODUCT §10.7) gets neither the recall nor the section:
// `assembleContext` returns its inputs untouched and never queries.
//
// The assembly rides the model port: `withSessionContext` wraps the worker's
// port, reads the turn's shape off the request (a definition without the recall
// tool has no memory path by construction — see ./definition) and hands the
// inner port the assembled system. A recall failure degrades to no section, the
// way today's turn continues without memory.
import type { ModelPort } from "@fabric/runtime";
import type { RecalledFact } from "../recall";

/** The folded state's slice the assembly reads: whose session, and incognito? */
export type ContextState = {
  session?: { incognito?: boolean } | null;
};

/** The context pieces the caller already has: the system prompt and the
 * conversation. `assembleContext` returns this shape, system amended. */
export type ContextFacts = {
  system: string;
  messages: readonly { role: string; text: string }[];
};

export type RecallFn = (query: string) => Promise<readonly RecalledFact[]>;

/** The memory section: the recalled facts, key/value, one per line. Empty when
 * nothing was recalled — no facts, no section, system untouched. */
export function memorySection(recalled: readonly RecalledFact[]): string {
  if (recalled.length === 0) return "";
  const lines = recalled.map((fact) => `- ${fact.key}: ${fact.value}`);
  return `## What you remember about Ty\n\n${lines.join("\n")}`;
}

/** The turn's context: the system prompt plus this turn's recall, unless the
 * session is incognito — then no recall runs and the section never appears. */
export async function assembleContext(
  state: ContextState,
  facts: ContextFacts,
  recall: RecallFn
): Promise<{ system: string; messages: ContextFacts["messages"] }> {
  if (state.session?.incognito === true) {
    return { system: facts.system, messages: facts.messages };
  }
  const query = [...facts.messages]
    .reverse()
    .find((message) => message.role === "user")
    ?.text?.trim();
  if (query === undefined || query === "") {
    // Nothing to recall with: today's turn skips the memory read entirely.
    return { system: facts.system, messages: facts.messages };
  }
  const recalled = await recall(query);
  const section = memorySection(recalled);
  return {
    system: section === "" ? facts.system : `${facts.system}\n\n${section}`,
    messages: facts.messages,
  };
}

/** The session's model port: the inner port, with the context assembled in
 * front of every call whose definition carries the recall tool. The definition
 * encodes incognito by dropping that tool (PRODUCT §10.7), so its presence is
 * the carrier — a session without `recall` in its tool list is incognito, and
 * the memory store is never queried (A4). A recall failure logs and continues
 * without the section, as the in-process turn did. */
export function withSessionContext(inner: ModelPort, recall: RecallFn): ModelPort {
  return {
    async call(request) {
      const hasRecall = request.tools?.some((tool) => tool.name === "recall") ?? false;
      if (!hasRecall) return inner.call(request);
      try {
        const assembled = await assembleContext({ session: { incognito: false } }, request, recall);
        return await inner.call({ ...request, system: assembled.system });
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        console.log(`[session] recall failed (${why}); continuing without memory`);
        return inner.call(request);
      }
    },
  };
}
