// The session tools on the ToolPort (ANY-56 S7, ANY-57 S8a): the port the
// worker's `tool.exec` runs behind. `record_disposition` and `ask_user` never
// reach it — decide answers those virtually (S2) — so the registry is the read
// shape plus the proposal writers: `recall` (effect `read`, the in-process
// `recallFacts` body unchanged) and, when the deps carry the proposal store, the
// `propose_*` tools (effect `idempotent`, bodies in ./proposals).
import type { ToolDescriptor, ToolPort, ToolRunResult } from "@fabric/runtime";
import type { ToolRegistry, ToolScope } from "@fabric/tools";
import type { ToolSchema } from "./definition";
import { RECALL_TOOL } from "./definition";
import { PROPOSAL_TOOL_SCHEMAS, PROPOSE_TOOLS, runProposeTool, type ProposalLoopDeps } from "./proposals";
import { BRIDGE_TOOLS, BRIDGE_TOOL_SCHEMAS, runBridgeTool, type SessionBridgeEngines } from "./bridges";
import type { SessionMcpRunner } from "./mcp";

/** The registry seam (T14): the server's tool registry plus the scope factory
 * a session call is bound through. Absent = no registry tools on the port. */
export type SessionToolRegistry = {
  tools: ToolRegistry;
  scope(io: { workspaceId: string; streamId: string; agentId: string; callId?: string }): Promise<ToolScope>;
};

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
  /** The tool registry (T14): the step-0 and host tools behind their scopes.
   * Absent = the port serves the session tools only. */
  registry?: SessionToolRegistry;
  /** The MCP run hook (M6): resolves the dynamic `mcp_*` names the static
   * registry doesn't carry — serverOfToolName, the discovery cache, a
   * one-def registry port. Absent = no MCP tools on the port. */
  mcp?: SessionMcpRunner;
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
    async run(
      name: string,
      args: Record<string, unknown>,
      io: {
        onLine?: (line: string) => void;
        callId?: string;
        streamId?: string;
        /** R14: the lease's workspace and the folded session agent. */
        workspaceId?: string;
        agentId?: string;
      } = {},
    ): Promise<ToolRunResult> {
      if (deps.bridges !== undefined && (BRIDGE_TOOLS as readonly string[]).includes(name)) {
        return runBridgeTool(name, args, io, deps.bridges);
      }
      if (deps.proposals !== undefined && (PROPOSE_TOOLS as readonly string[]).includes(name)) {
        return runProposeTool(name, args, io, deps.proposals);
      }
      // T14: a registry tool runs behind the scope the caller's factory builds —
      // the session's identity, no store read. No agentId, no call.
      const registry = deps.registry;
      if (registry !== undefined && registry.tools.get(name) !== undefined) {
        if (io.agentId === undefined || io.agentId === "") {
          return { ok: false, error: "session tools need the session's agent" };
        }
        const scope = await registry.scope({
          workspaceId: io.workspaceId ?? "",
          streamId: io.streamId ?? "",
          agentId: io.agentId,
          callId: io.callId,
        });
        return registry.tools.toolPort(scope).run(name, args, { onLine: io.onLine, callId: io.callId });
      }
      // M6: a dynamic mcp_* name resolves through the MCP hook; undefined
      // lets the port's own tools (recall) answer below.
      if (deps.mcp !== undefined) {
        const resolved = await deps.mcp(name, args, io);
        if (resolved !== undefined) return resolved;
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
    // the session descriptors first, then the registry's (metas give the effect)
    describe: (name) =>
      descriptors[name] ?? registryDescriptor(name, deps.registry),
    // T16: a tool holds a sandbox slot exactly when the registry's declaration
    // runs it in the workspace sandbox (step 2); every other tool — the
    // session's own, the bridges, the MCP discoveries — never queues.
    needsSlot: (name) => deps.registry?.tools.meta(name)?.step === 2,
  };
}

/** The registry half of `describe`: the declaration plus the effect, or
 * undefined for a name the registry does not carry. */
function registryDescriptor(name: string, registry: SessionToolRegistry | undefined): ToolDescriptor | undefined {
  if (registry === undefined || registry.tools.get(name) === undefined) return undefined;
  const meta = registry.tools.meta(name);
  const model = registry.tools.modelTools([name])[0];
  if (meta === undefined || model === undefined) return undefined;
  return { name: model.name, effect: meta.effect, description: model.description, parameters: model.parameters };
}

/** Re-exported so the server wiring and the tests agree on one declaration. */
export type { ToolSchema };
