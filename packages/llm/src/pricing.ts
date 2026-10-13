// Per-call pricing (ARCH §10): the tables, never the in-memory run totals.
// Spark is free; OpenRouter reports usage.cost; Neon comes from the table below.
// Shared by the usage meter (index.ts) and the model port (model-port.ts).
import type { SharedV4ProviderMetadata } from "@ai-sdk/provider";
import type { Provider } from "./index";

export const NEON_PRICES: Record<string, { inputPerMtok: number; outputPerMtok: number }> = {
  // Placeholder list prices (DANA re-checks against GET /v1/models pricing at the venue); metered costs are flagged estimated.
  "claude-sonnet-5": { inputPerMtok: 3, outputPerMtok: 15 },
  "claude-haiku-4-5": { inputPerMtok: 1, outputPerMtok: 5 },
  "claude-opus-5-5": { inputPerMtok: 5, outputPerMtok: 25 },
};

export function costOf(
  provider: Provider,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  meta: SharedV4ProviderMetadata | undefined,
): { costUsd?: number; estimated?: boolean } {
  if (provider === "spark") return { costUsd: 0 };
  if (provider === "openrouter") {
    const usage = meta && "openrouter" in meta ? (meta as { openrouter?: { usage?: { cost?: unknown } } }).openrouter?.usage : undefined;
    const cost = typeof usage?.cost === "number" ? usage.cost : undefined;
    return cost != null ? { costUsd: cost } : {};
  }
  const price = NEON_PRICES[modelId];
  if (!price) return { estimated: true };
  return { costUsd: (inputTokens / 1e6) * price.inputPerMtok + (outputTokens / 1e6) * price.outputPerMtok, estimated: true };
}
