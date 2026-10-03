// DANA owns this folder: model access through the Neon AI Gateway, and per-call usage metering (ARCH §10).
import { NotImplementedError } from "@fabric/contracts";

/** Placeholder until S1 settles the SDK; expected to become an AI SDK language model. */
export type LanguageModel = unknown;

export interface Usage { model: string; inputTokens: number; outputTokens: number; costUsd?: number; estimated?: boolean }
export interface UsageSink { record(u: Usage): void }

export function model(_modelId: string): LanguageModel {
  throw new NotImplementedError("DANA", "llm.model");
}

/** Tags every call with where it happened; TEAM turns the totals into budget.update events. */
export function meter(_ctx: { runId?: string; agentId: string; step?: string }): UsageSink {
  throw new NotImplementedError("DANA", "llm.meter");
}
