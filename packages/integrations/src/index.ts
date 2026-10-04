// @fabric/integrations — TOOLS owns this package: tool registry and policies, Sprites, Exa, AgentMail, Executor.
import { NotImplementedError } from "@fabric/contracts";
import type { Report, StudioProfile, ToolName, ToolPolicy } from "@fabric/contracts";
import type { RunWriter } from "@fabric/db";

/** Placeholder until S3 settles the agent framework's tool type. */
export type Tool = unknown;

export interface AgentTools {
  tools: Partial<Record<ToolName, Tool>>;
  policies: { name: ToolName; policy: ToolPolicy }[];
  /** Shown in the inspector, e.g. "sprite/fabric-coder-7f3 · egress: package index + model host only". */
  sandbox?: string;
}

export function toolsFor(_agent: StudioProfile, _ctx: { runId: string; step: string; writer: RunWriter }): AgentTools {
  throw new NotImplementedError("TOOLS", "toolsFor");
}

/** Returns the new address (CARD-3). */
export function createInbox(_agentId: string): Promise<string> {
  throw new NotImplementedError("TOOLS", "createInbox");
}

export function sendReportEmail(_report: Report, _to: string): Promise<void> {
  throw new NotImplementedError("TOOLS", "sendReportEmail");
}
