// team.assign belongs to TEAM's orchestration (§5.3 TOOLS 1): the runtime decides what an
// assignment means, so the factory takes TEAM's callback and wraps it in the same spine as every
// other tool — tool.call first, policy from the agent row, tool.denied on a block.
import { z } from "zod";
import type { StudioProfile, ToolPolicy } from "@fabric/contracts";
import { makeTool } from "../tool-context";
import type { ToolCtx } from "../tool-context";

export interface TeamAssignInput {
  agentId: string;
  step: string;
  note?: string;
}

/** What TEAM hands us: run the assignment (start a step, track it, whatever its runtime does). */
export type TeamAssign = (input: TeamAssignInput) => Promise<unknown>;

export function teamAssignTool(agent: StudioProfile, policy: ToolPolicy, ctx: ToolCtx, assign: TeamAssign) {
  return makeTool(
    {
      name: "team.assign",
      description: "Hand one workflow step to a member of your team.",
      inputSchema: z.object({
        agentId: z.string().describe("Who takes the step"),
        step: z.string().describe("The step's label, e.g. Survey"),
        note: z.string().optional().describe("One line of context for the member"),
      }),
      policy,
      summary: (i) => `${i.step} → ${i.agentId}`,
      target: (i) => i.agentId,
      run: async (i) => ({ result: await assign(i) ?? null }),
    },
    ctx,
  );
}
