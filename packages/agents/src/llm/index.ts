// DANA owns this folder: model access through the Neon AI Gateway, and per-call usage metering (ARCH §10).
//
// One factory over three providers, chosen by LLM_PROVIDER (WORK-PLAN §2.1 item 5):
//   spark      — the DGX Spark lane (vLLM, OpenAI-compatible). Every display model maps to SPARK_MODEL.
//   openrouter — anthropic/claude-* ids, usage accounting on (usage.cost comes back).
//   neon       — the Neon AI Gateway at the venue (@neon/ai-sdk-provider, NEON_AI_GATEWAY_* env).
import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import type { JSONObject, LanguageModelV3, LanguageModelV4, LanguageModelV4StreamPart, SharedV4ProviderMetadata } from "@ai-sdk/provider";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createNeon } from "@neon/ai-sdk-provider";

/** A model instance (AI SDK spec v4), as returned by model(). */
export type LanguageModel = LanguageModelV4;
export type Provider = "spark" | "openrouter" | "neon";
export type ThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh";
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "low", "medium", "high", "xhigh"];

export interface Usage {
  /** The model that actually ran, `provider:modelId` — not the intended display model (ARCH §10). */
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  /** Cost is computed from a price table, not reported by the provider. */
  estimated?: boolean;
  /** Where the call happened (from the meter context). */
  agentId?: string;
  step?: string;
}
export interface UsageSink {
  record(u: Usage): void;
  /** What this sink has recorded so far (read-only). */
  readonly usages: readonly Usage[];
}
export interface MeterContext {
  runId?: string;
  agentId: string;
  step?: string;
}

export interface ModelOptions {
  thinking?: ThinkingLevel;
  /** Given: every generate/stream call through the returned model is recorded. */
  meter?: MeterContext;
}

export const DANA = "dana";

/** Thinking defaults (WORK-PLAN DANA 1): Dana off for latency, everyone else medium. */
export function defaultThinking(agentId: string | undefined): ThinkingLevel {
  return agentId === DANA ? "off" : "medium";
}

/** The active provider from LLM_PROVIDER (spark unless told otherwise). */
export function providerName(): Provider {
  const p = (process.env.LLM_PROVIDER ?? "spark").trim().toLowerCase();
  if (p !== "spark" && p !== "openrouter" && p !== "neon") {
    throw new Error(`LLM_PROVIDER must be spark | openrouter | neon (got "${p}")`);
  }
  return p;
}

// ---- Display model → provider model id ----

export type ModelFamily = "sonnet" | "haiku" | "opus" | "fable" | "glm";

/** The agent row's display model ("Sonnet 5.5", "Haiku 4.5", "Opus 5.5", "Fable 5.1", "GLM 5.3 Flash"; "" means Sonnet 5.5). */
export function modelFamily(displayModelId: string): ModelFamily {
  const id = displayModelId.trim().toLowerCase();
  if (id.includes("glm")) return "glm";
  if (id.includes("haiku")) return "haiku";
  if (id.includes("fable")) return "fable";
  if (id.includes("opus")) return "opus";
  return "sonnet";
}

/** The model id the current provider actually serves for a display model. */
export function providerModelId(family: ModelFamily, provider: Provider = providerName()): string {
  switch (provider) {
    case "spark":
      return requireSparkModel();
    case "openrouter":
      return {
        sonnet: "anthropic/claude-sonnet-5.5",
        haiku: "anthropic/claude-haiku-4.5",
        opus: "anthropic/claude-opus-5.5",
        fable: "anthropic/claude-fable-5.1",
        glm: "anthropic/claude-sonnet-5.5", // GLM's OpenRouter id is unverified: the backup lane runs Sonnet
      }[family];
    case "neon":
      // Gateway catalog ids, checked against GET /v1/models (2026-10-04): no claude-sonnet-5-5 yet, so Sonnet runs on 5.
      return {
        sonnet: "claude-sonnet-5",
        haiku: "claude-haiku-4-5",
        opus: "claude-opus-5-5",
        fable: "claude-fable-5-1",
        glm: "glm-5-3-flash", // zhipu, via the gateway's unified chat route
      }[family];
  }
}

function requireSparkModel(): string {
  const m = process.env.SPARK_MODEL?.trim();
  if (!m) throw new Error("SPARK_MODEL is not set (the Spark lane needs it in .env)");
  return m;
}

// ---- Spark thinking controls (probed Oct 4; never send "none" anywhere) ----

/**
 * Spark/vLLM thinking knobs, applied to the request body:
 * - "off":    chat_template_kwargs.enable_thinking = false (the only way to get zero reasoning tokens)
 * - "low"/"medium": top-level reasoning_effort
 * - "high"/"xhigh": nothing — the template's xhigh default
 */
export function sparkThinkingBody(body: Record<string, unknown>, level: ThinkingLevel): Record<string, unknown> {
  if (level === "off") {
    const kwargs = (body.chat_template_kwargs as Record<string, unknown> | undefined) ?? {};
    return { ...body, chat_template_kwargs: { ...kwargs, enable_thinking: false } };
  }
  if (level === "low" || level === "medium") return { ...body, reasoning_effort: level };
  return body;
}

function sparkModel(level: ThinkingLevel): LanguageModel {
  const baseURL = process.env.SPARK_BASE_URL?.trim();
  if (!baseURL) throw new Error("SPARK_BASE_URL is not set (the Spark lane is required for LLM_PROVIDER=spark)");
  const p = createOpenAICompatible({
    name: "spark",
    baseURL,
    apiKey: process.env.SPARK_API_KEY ?? "",
    includeUsage: true, // vLLM then reports usage on the stream's final chunk
    supportsStructuredOutputs: true, // vLLM guided json (response_format json_schema)
    transformRequestBody: (body) => sparkThinkingBody(body as Record<string, unknown>, level),
  });
  return p(requireSparkModel());
}

function openrouterModel(level: ThinkingLevel, id: string): LanguageModel {
  if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set (required for LLM_PROVIDER=openrouter)");
  const p = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });
  // Claude thinking is opt-in: "off" sends nothing. Effort levels map to OpenRouter's reasoning effort.
  const reasoning = level === "off" ? undefined : { effort: level === "xhigh" ? "high" : level };
  return p.chat(id, { usage: { include: true }, ...(reasoning ? { reasoning } : {}) });
}

// ---- Neon thinking + structured output (probed Oct 4 against GET /v1/models and live calls) ----

/**
 * Anthropic provider options for a gateway call:
 * - structuredOutputMode "jsonTool": the gateway's upstream rejects native output_config.format.
 * - "off": thinking disabled. Haiku 4.5 predates adaptive thinking, so it gets a token budget;
 *   the 5-series take adaptive thinking steered by effort (they reject sampling params anyway).
 * Calls that force a tool (generateObject's jsonTool, Dana's record_disposition first step) run with
 * thinking off: Anthropic refuses a forced tool choice alongside thinking.
 */
export function neonAnthropicOptions(id: string, level: ThinkingLevel): JSONObject {
  const base = { structuredOutputMode: "jsonTool" };
  if (level === "off") return { ...base, thinking: { type: "disabled" } };
  if (id.startsWith("claude-haiku-4")) {
    return { ...base, thinking: { type: "enabled", budgetTokens: { low: 1024, medium: 4096, high: 16000, xhigh: 32000 }[level] } };
  }
  return { ...base, thinking: { type: "adaptive" }, effort: level };
}

/**
 * Models the Anthropic SDK treats as always-adaptive with no forced tool use (Opus 5.5, Fable 5.1):
 * it sends their structured output as native output_config.format, which the gateway rejects, so
 * their JSON-schema calls run on the nearest model that takes jsonTool. A forced tool choice in a
 * normal call stays on the picked model (the SDK relaxes it to auto): claude-opus-5 refuses Dana's
 * forced record_disposition step (stop_reason "refusal", Oct 4).
 */
const NEON_JSON_FALLBACK: Record<string, string> = { "claude-opus-5-5": "claude-opus-5", "claude-fable-5-1": "claude-opus-5" };

function neonOptionsMiddleware(id: string, level: ThinkingLevel): LanguageModelMiddleware {
  const fallbackId = NEON_JSON_FALLBACK[id];
  const fallback = fallbackId ? wrapLanguageModel({ model: neonModel(fallbackId), middleware: [] }) : undefined;
  const forced = (params: { responseFormat?: { type: string }; toolChoice?: { type: string } }) =>
    params.responseFormat?.type === "json" || params.toolChoice?.type === "tool" || params.toolChoice?.type === "required";
  const jsonCall = (params: { responseFormat?: { type: string } }) => fallback != null && params.responseFormat?.type === "json";
  return {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate, params }) => (jsonCall(params) ? fallback!.doGenerate(params) : doGenerate()),
    wrapStream: async ({ doStream, params }) => (jsonCall(params) ? fallback!.doStream(params) : doStream()),
    transformParams: async ({ params }) => {
      const anthropic = params.providerOptions?.anthropic ?? {};
      return {
        ...params,
        // Caller-set anthropic options win over the level defaults.
        providerOptions: {
          ...params.providerOptions,
          anthropic: { ...neonAnthropicOptions(id, forced(params) ? "off" : level), ...anthropic },
        },
      };
    },
  };
}

function neonModel(id: string): LanguageModelV3 {
  const baseURL = process.env.NEON_AI_GATEWAY_BASE_URL?.trim();
  const apiKey = process.env.NEON_AI_GATEWAY_TOKEN?.trim();
  if (!baseURL || !apiKey) {
    throw new Error(
      "Neon AI Gateway is not configured: set NEON_AI_GATEWAY_BASE_URL and NEON_AI_GATEWAY_TOKEN " +
        "(neon env pull / neon deploy writes them once the gateway is enabled on a paid plan). " +
        "Until the venue, use LLM_PROVIDER=spark or openrouter.",
    );
  }
  return createNeon({ baseURL, apiKey })(id);
}

// ---- Cost (ARCH §10): Spark is free, OpenRouter reports usage.cost, Neon comes from a table in code ----

export const NEON_PRICES: Record<string, { inputPerMtok: number; outputPerMtok: number }> = {
  // Placeholder list prices (DANA re-checks against GET /v1/models pricing at the venue); metered costs are flagged estimated.
  "claude-sonnet-5": { inputPerMtok: 3, outputPerMtok: 15 },
  "claude-haiku-4-5": { inputPerMtok: 1, outputPerMtok: 5 },
  "claude-opus-5-5": { inputPerMtok: 5, outputPerMtok: 25 },
};

function costOf(
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

// ---- Metering ----

const runCosts = new Map<string, number>();
const runRecords = new Map<string, Usage[]>();

/** Tags every call with where it happened; TEAM turns the totals into budget.update events. */
export function meter(ctx: MeterContext): UsageSink {
  const usages: Usage[] = [];
  return {
    get usages() {
      return usages;
    },
    record(u) {
      const tagged: Usage = { agentId: ctx.agentId, step: ctx.step, ...u };
      usages.push(tagged);
      if (ctx.runId) {
        runCosts.set(ctx.runId, (runCosts.get(ctx.runId) ?? 0) + (u.costUsd ?? 0));
        runRecords.set(ctx.runId, [...(runRecords.get(ctx.runId) ?? []), tagged]);
      }
    },
  };
}

/** Everything metered under a run so far — the model that ran, tokens and cost per call. */
export function runUsages(runId: string): readonly Usage[] {
  return runRecords.get(runId) ?? [];
}

/**
 * The run's in-process running total, so TEAM can emit budget.update {costUsd: <running total>}.
 * DATA accumulates budget.update monotonically and treats costUsd as the run's total, not a delta.
 */
export function runCostUsd(runId: string): number {
  return runCosts.get(runId) ?? 0;
}

function meteringMiddleware(sink: UsageSink, provider: Provider, modelId: string): LanguageModelMiddleware {
  const tag = `${provider}:${modelId}`;
  const record = (usage: { inputTokens: { total: number | undefined }; outputTokens: { total: number | undefined } }, meta?: SharedV4ProviderMetadata) => {
    const inputTokens = usage.inputTokens.total ?? 0;
    const outputTokens = usage.outputTokens.total ?? 0;
    sink.record({ model: tag, inputTokens, outputTokens, ...costOf(provider, modelId, inputTokens, outputTokens, meta) });
  };
  return {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();
      record(result.usage, result.providerMetadata);
      return result;
    },
    wrapStream: async ({ doStream }) => {
      const { stream, ...rest } = await doStream();
      const observed = stream.pipeThrough(
        new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
          transform(part, controller) {
            if (part.type === "finish") record(part.usage, part.providerMetadata);
            controller.enqueue(part);
          },
        }),
      );
      return { ...rest, stream: observed };
    },
  };
}

// ---- The factory ----

/** An AI SDK language model for an agent row's display model, on the current provider. */
export function model(modelId: string, opts: ModelOptions = {}): LanguageModel {
  const provider = providerName();
  const family = modelFamily(modelId);
  const id = providerModelId(family, provider);
  const level = opts.thinking ?? defaultThinking(opts.meter?.agentId);
  const base: LanguageModelV4 | LanguageModelV3 =
    provider === "spark" ? sparkModel(level)
    : provider === "openrouter" ? openrouterModel(level, id)
    : neonModel(id); // the neon provider is spec v3; wrapLanguageModel normalizes it to v4
  const middleware: LanguageModelMiddleware[] = [
    ...(opts.meter ? [meteringMiddleware(meter(opts.meter), provider, id)] : []),
    ...(provider === "neon" ? [neonOptionsMiddleware(id, level)] : []),
  ];
  return wrapLanguageModel({ model: base, middleware });
}
