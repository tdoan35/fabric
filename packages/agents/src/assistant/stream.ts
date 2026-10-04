// Pure stream helpers for the forced-disposition pattern (DANA 2): record_disposition is forced
// as the first tool call of every turn, and a turn that somehow produces none is retried once.
// Extracted so the policy is unit-testable without a database.
import type { ToolChoice } from "ai";
import type { ChatStreamLine } from "@fabric/contracts";

/**
 * streamText's prepareStep: step 0 must call record_disposition; later steps choose freely.
 * (Mastra re-applies `required` on every loop step, which is exactly what this avoids — S1.)
 */
export function prepareDispositionFirstStep<TOOLS extends Record<string, unknown>>(
  stepNumber: number,
): { toolChoice: ToolChoice<TOOLS> } | {} {
  return stepNumber === 0 ? { toolChoice: { type: "tool", toolName: "record_disposition" as Extract<keyof TOOLS, string> } } : {};
}

/**
 * Runs one attempt (which yields nothing until its record_disposition call has landed) and retries
 * the whole turn once if no disposition ever appeared. Lines are buffered per attempt, so a retry
 * never leaves the first attempt's text on screen: every line is a full cumulative snapshot.
 */
export async function* withForcedDisposition(
  attempt: () => AsyncGenerator<ChatStreamLine>,
  onRetry?: () => void,
): AsyncGenerator<ChatStreamLine> {
  let lines: ChatStreamLine[] = [];
  for (let tries = 0; tries < 2; tries++) {
    lines = [];
    for await (const line of attempt()) lines.push(line);
    if (lines.length) break;
    if (tries === 0) onRetry?.();
  }
  yield* lines;
}
