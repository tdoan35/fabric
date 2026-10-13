// Shared fixtures for the T1 suite (ANY-67): the card's running example —
// `web_search` over `{ query, limit? }` — kept free of `../index` imports so
// the red run fails per case on the missing exports, not on the fixture.
import { z } from "zod";

/** A caller's opaque scope (workspaceId/streamId/agentId, runDir optional). */
export const scope = { workspaceId: "ws-t1", streamId: "run:t1", agentId: "agent-1" };

/** The full declaration minus the name, so cases can vary just the name. */
export const webSearchSpec = {
  description: "Search the web",
  parameters: z.object({ query: z.string(), limit: z.number().optional() }),
  effect: "read" as const,
  gate: "mode" as const,
  kind: "read" as const,
  step: 0 as const,
  execute: async (args: { query: string; limit?: number }) => ({
    hits: [args.query],
    limit: args.limit ?? 10,
  }),
};
