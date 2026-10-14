// The session tools on the ToolPort (ANY-56 S7, ANY-57 S8a): the port the
// worker's `tool.exec` runs behind. `record_disposition` and `ask_user` never
// reach it — decide answers those virtually (S2) — so the registry is the read
// shape plus the proposal writers: `recall` (effect `read`, the in-process
// `recallFacts` body unchanged) and, when the deps carry the proposal store, the
// `propose_*` tools (effect `idempotent`, bodies in ./proposals).
import type { ToolDescriptor, ToolPort, ToolRunResult } from "@fabric/runtime";
import type { ToolSchema } from "./definition";
import { RECALL_TOOL } from "./definition";
import { PROPOSAL_TOOL_SCHEMAS, PROPOSE_TOOLS, runProposeTool, type ProposalLoopDeps } from "./proposals";
import { BRIDGE_TOOLS, BRIDGE_TOOL_SCHEMAS, runBridgeTool, type SessionBridgeEngines } from "./bridges";

export type SessionToolDeps = {
  /** The recall body, injected: the production adapter is today's
   * `recallFacts`; tests inject the fake memory store. */
  recall: (query: string) => Promise<readonly { key: string; value: string; source: string }[]>;
  /** The proposal surface (S8a): the store behind the `propose_*` bodies and
   * the loop seam their facts are announced through. Absent = a read-only port. */
  proposals?: ProposalLoopDeps;
  /** The legacy-engine bridges (S8b): `handoff_to_team` and `browser_task` as
   * `once` tool.exec. Absent = no bridge tools on the port. */
  bridges?: SessionBridgeEngines;
};

/** The session ToolPort: `recall` plus, when wired, the proposal writers and
 * the legacy-engine bridges; the descriptor doubles as the effect fallback when
 * a `tool.call` goes out without one. */
export function sessionTools(deps: SessionToolDeps): ToolPort {
  const descriptors: Record<string, ToolDescriptor> = {
    recall: {
      name: RECALL_TOOL.name,
      effect: "read",
      description: RECALL_TOOL.description,
      parameters: RECALL_TOOL.parameters,
    },
  };
  if (deps.proposals !== undefined) {
    for (const name of PROPOSE_TOOLS) {
      descriptors[name] = { name, effect: "idempotent", ...PROPOSAL_TOOL_SCHEMAS[name] };
    }
  }
  if (deps.bridges !== undefined) {
    for (const name of BRIDGE_TOOLS) {
      descriptors[name] = { name, effect: "once", ...BRIDGE_TOOL_SCHEMAS[name] };
    }
  }

  return {
    async run(name, args, io = {}): Promise<ToolRunResult> {
      if (deps.bridges !== undefined && (BRIDGE_TOOLS as readonly string[]).includes(name)) {
        return runBridgeTool(name, args, io, deps.bridges);
      }
      if (deps.proposals !== undefined && (PROPOSE_TOOLS as readonly string[]).includes(name)) {
        return runProposeTool(name, args, io, deps.proposals);
      }
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
