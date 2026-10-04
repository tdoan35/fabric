// Pure stream helpers for the forced-disposition pattern (DANA 2): record_disposition is forced
// as the first tool call of every turn, and a turn that comes out unusable — no disposition call,
// or a tool call the turn didn't allow (the lane sometimes hallucinates one) — is retried once.
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

/** The attempt flips `invalid` when its output can't be used; the wrapper then retries once. */
export interface AttemptControl {
  invalid: boolean;
}

export type Attempt = (control: AttemptControl) => AsyncGenerator<ChatStreamLine>;

/**
 * Runs one attempt and retries the whole turn once when it comes out invalid. Lines stream through
 * as they are produced; every line is a full cumulative snapshot, so a retry's lines simply replace
 * the unusable attempt's on screen.
 */
export async function* withForcedDisposition(attempt: Attempt, onRetry?: () => void): AsyncGenerator<ChatStreamLine> {
  for (let tries = 0; tries < 2; tries++) {
    const control: AttemptControl = { invalid: false };
    for await (const line of attempt(control)) yield line;
    if (!control.invalid) return;
    if (tries === 0) onRetry?.();
  }
}
