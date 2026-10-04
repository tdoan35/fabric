// Pure stream helpers for Dana's turn (DANA 2). record_disposition is asked for first in the prompt
// but not forced: Opus 5.5 / Fable 5.1 reject forced tool use, and a model that answers without it
// still gets its reply shown, with a fallback disposition inferred from what it did. A turn that
// comes out unusable — nothing at all, or a tool call the turn didn't allow (the lane sometimes
// hallucinates one) — is retried once. Extracted so the policy is unit-testable without a database.
import type { ChatStreamLine, DispositionArgs } from "@fabric/contracts";

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
export async function* withOneRetry(attempt: Attempt, onRetry?: () => void): AsyncGenerator<ChatStreamLine> {
  for (let tries = 0; tries < 2; tries++) {
    const control: AttemptControl = { invalid: false };
    for await (const line of attempt(control)) yield line;
    if (!control.invalid) return;
    if (tries === 0) onRetry?.();
  }
}

/** The disposition a turn implies when the model replied without recording one. */
export function fallbackDisposition(toolNames: readonly string[]): DispositionArgs {
  const disposition =
    toolNames.includes("handoff_to_team") ? "delegate_team"
    : toolNames.includes("propose_team") ? "propose_team"
    : toolNames.includes("propose_specialist") ? "propose_specialist"
    : "handle_directly";
  return { disposition, reason: "Inferred: the model replied without recording a disposition", considered: [] };
}
