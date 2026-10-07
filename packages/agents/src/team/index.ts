// TEAM owns this folder: the data-driven team workflow, over the real
// services — CTX context, TOOLS tools, the llm meter — writing every event through RunWriter.
// S3 verdict: plain async orchestration (the fallback), no Mastra.
export { createTeamRuntime } from "./engine";
export { bounceOutcome, planPasses, stepLabel, stepKind } from "./labels";
export type { TeamRuntime, TeamRuntimeDeps, TeamRunOptions } from "./engine";
export type { Pass, StagePlan } from "./labels";
export { stepPrompt } from "./steps";
export type { RunCtx, StepSpec } from "./steps";
