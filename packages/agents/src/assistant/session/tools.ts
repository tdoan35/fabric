// The session tools on the ToolPort (ANY-56 S7): the port the worker's
// `tool.exec` runs behind, seeded with Dana's one executable tool. The
// `record_disposition` and `ask_user` calls never reach it — decide answers
// those virtually (S2) — so the registry is the read-shaped tools alone, today
// `recall`, whose body is the in-process `recallFacts` passed in unchanged.
import type { ToolDescriptor, ToolPort, ToolRunResult } from "@fabric/runtime";
import type { ToolSchema } from "./definition";
import { RECALL_TOOL } from "./definition";

export type SessionToolDeps = {
  /** The recall body, injected: the production adapter is today's
   * `recallFacts`; tests inject the fake memory store. */
  recall: (query: string) => Promise<readonly { key: string; value: string; source: string }[]>;
};

/** The session ToolPort: `recall` with effect `read`, everything else a loud
 * miss. The descriptor doubles as the effect fallback when a `tool.call` goes
 out without one. */
export function sessionTools(deps: SessionToolDeps): ToolPort {
  const descriptors: Record<string, ToolDescriptor> = {
    recall: {
      name: RECALL_TOOL.name,
      effect: "read",
      description: RECALL_TOOL.description,
      parameters: RECALL_TOOL.parameters,
    },
  };

  return {
    async run(name, args): Promise<ToolRunResult> {
      if (name !== "recall") return { ok: false, error: `unknown session tool: ${name}` };
      const query = typeof args.query === "string" ? args.query : "";
      if (query === "") return { ok: false, error: "recall needs a query" };
      try {
        // Today's execute body, unchanged: the facts in, the `{facts}` wrapper out.
        return { ok: true, result: { facts: await deps.recall(query) } };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    describe: (name) => descriptors[name],
  };
}

/** Re-exported so the server wiring and the tests agree on one declaration. */
export type { ToolSchema };
