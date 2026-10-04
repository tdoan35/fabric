// toolsFor (§4.6/§5.3 TOOLS 1): one agent's tool set, built from its DB row's policies. The keys
// are provider-safe (sprite_exec — Anthropic/OpenAI reject dots); toolNameOf maps them back to
// the canonical names for policies and events. Blocked and approval-only tools stay IN the set:
// the model can attempt them, and the wrapper's tool.denied is the record (§5.3 TOOLS 2).
import { isToolName } from "@fabric/contracts";
import type { StudioProfile, ToolName, ToolPolicy } from "@fabric/contracts";
import type { Db, RunWriter } from "@fabric/db";
import type { Tool } from "ai";
import { sandboxIdFor } from "./sprites";
import { TOOL_KEYS } from "./names";
import type { ToolCtx } from "./tool-context";
import { agentMailSendTool } from "./tools/agentmail-tool";
import { artifactsReadTool, artifactsWriteTool } from "./tools/artifacts";
import { exaSearchTool } from "./tools/exa-tool";
import { networkFetchTool } from "./tools/net";
import { spriteExecTool, workspaceWriteTool } from "./tools/sprite";

export interface ToolsForCtx {
  runId: string;
  step: string;
  writer: RunWriter;
  /** Additive (§5.3 TOOLS 6): artifacts.read lists/reads the run's artifacts by name. */
  db?: Db;
}

/** The §4.6 interface, with `tools` keyed for providers (see names.ts). */
export interface AgentTools {
  tools: Partial<Record<string, Tool>>;
  policies: { name: ToolName; policy: ToolPolicy }[];
  /** The inspector's sandbox line: the Sprite name for Jonah and Sana. */
  sandbox?: string;
}

export function toolsFor(agent: StudioProfile, ctx: ToolsForCtx): AgentTools {
  const row = new Map(agent.agent.tools.filter((t) => isToolName(t.name)).map((t) => [t.name as ToolName, t.policy]));
  const policyOf = (name: ToolName): ToolPolicy => row.get(name) ?? "blocked";
  const tctx: ToolCtx = { runId: ctx.runId, step: ctx.step, writer: ctx.writer, actor: agent.agent.id };
  const tools: Partial<Record<string, Tool>> = {};
  const put = (name: ToolName, make: (policy: ToolPolicy) => Tool) => {
    if (row.has(name)) tools[TOOL_KEYS[name]] = make(policyOf(name));
  };

  put("sprite.exec", (p) => spriteExecTool(agent, p, tctx));
  put("workspace.write", (p) => workspaceWriteTool(agent, p, tctx));
  put("artifacts.read", (p) => artifactsReadTool(p, tctx, ctx.db));
  put("artifacts.write", (p) => artifactsWriteTool(p, tctx));
  put("exa.search", (p) => exaSearchTool(p, tctx));
  put("agentmail.send", (p) => agentMailSendTool(p, tctx));
  put("network.fetch", (p) => networkFetchTool(p, tctx));
  // team.assign is TEAM's: teamAssignTool(agent, policy, ctx, itsCallback) builds it.

  return {
    tools,
    policies: [...row.entries()].map(([name, policy]) => ({ name, policy })),
    sandbox: sandboxIdFor(agent.agent.id) ? `sprite/${sandboxIdFor(agent.agent.id)} · egress: package index + model host only` : undefined,
  };
}
