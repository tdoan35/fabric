// The production ModelPort (RUNTIME §4 `llm.call`, ANY-53 S4): ONE streamText
// call per `call()`, tools handed over as schemas only — the SDK returns tool
// calls, never runs them (`tool.exec` does). Deltas stream through the port's
// callback as raw text deltas; the cost is priced per call from the tables in
// ./pricing, never from the in-memory run meter.
//
// The port instance is bound to one provider endpoint: `llm.requested`'s
// `model` picks the wiring at construction (the `modelFor` closure), not per
// call — so `call()` carries no model and the id slot below stays empty.
import { streamText, stepCountIs, tool as defineTool, jsonSchema } from "ai";
import type { ModelMessage as SdkModelMessage, Tool, ToolSet } from "ai";
import { ModelError } from "@fabric/runtime";
import type { ModelCallRequest, ModelMessage, ModelPort, ModelResult } from "@fabric/runtime";
import { costOf } from "./pricing";
import { model, modelFamily, providerModelId, providerName, type LanguageModel, type ThinkingLevel } from "./index";

/** Picks the endpoint for this port; defaults to today's `model()`. */
export type ModelFor = (modelId: string, thinking?: ThinkingLevel) => LanguageModel;

export type ModelPortOptions = {
  modelFor?: ModelFor;
};

/** The caller's request plus the abort handle (RUNTIME §4: the call cancels). */
export type ModelCallOptions = ModelCallRequest & { signal?: AbortSignal };

export function createModelPort(opts: ModelPortOptions = {}): ModelPort {
  const modelFor: ModelFor = opts.modelFor ?? ((id, thinking) => model(id, { thinking }));

  const call = async (request: ModelCallOptions): Promise<ModelResult> => {
    const { system, messages, tools, onDelta, signal } = request;
    const result = streamText({
      model: modelFor(""),
      system,
      messages: toSdkMessages(messages ?? []),
      tools: toSdkTools(tools ?? []),
      // One model call: tool calls come back, they do not run (RUNTIME §4).
      stopWhen: stepCountIs(1),
      // Retry policy lives in the queue's backoff, not here.
      maxRetries: 0,
      // Errors surface by rejecting `call`; no log side channel.
      onError: () => {},
      abortSignal: signal,
    });

    let text = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason = "unknown";
    let providerMetadata: Record<string, Record<string, unknown>> | undefined;
    const toolCalls: { id: string; name: string; args: Record<string, unknown> }[] = [];

    try {
      for await (const part of result.fullStream) {
        switch (part.type) {
          case "text-delta":
            text += part.text;
            onDelta?.({ text: part.text });
            break;
          case "tool-call":
            toolCalls.push({
              id: part.toolCallId,
              name: part.toolName,
              args: (part.input ?? {}) as Record<string, unknown>,
            });
            break;
          case "finish-step":
            providerMetadata = part.providerMetadata as typeof providerMetadata;
            break;
          case "finish":
            finishReason = part.finishReason;
            inputTokens = part.totalUsage.inputTokens ?? 0;
            outputTokens = part.totalUsage.outputTokens ?? 0;
            break;
          case "error":
            throw part.error;
          case "abort":
            throw new Error("model call aborted");
        }
      }
    } catch (err) {
      throw toModelError(err);
    }

    // Priced per call from the tables; the port never touches the run meter.
    const provider = providerName();
    const cost = costOf(
      provider,
      providerModelId(modelFamily(""), provider),
      inputTokens,
      outputTokens,
      providerMetadata as never,
    );

    return {
      text,
      toolCalls,
      usage: { inputTokens, outputTokens, costUsd: cost.costUsd ?? 0 },
      finishReason,
    };
  };

  return { call };
}

/** Maps any failure to the port's error contract: { status?, retryAfter?, retryable }. */
function toModelError(err: unknown): ModelError {
  const e = err as { message?: string; statusCode?: unknown; responseHeaders?: Record<string, string> } | undefined;
  const message = e?.message ?? "model call failed";
  const status = typeof e?.statusCode === "number" ? e.statusCode : undefined;
  if (status === undefined) {
    // No HTTP surface — network drop or abort: transient, no backoff hint.
    return new ModelError(message, { retryable: true });
  }
  const retryable = status === 429 || status >= 500;
  const retryAfter = parseRetryAfter(e?.responseHeaders?.["retry-after"]);
  return new ModelError(message, {
    status,
    retryable,
    ...(retryable && retryAfter !== undefined ? { retryAfter } : {}),
  });
}

function parseRetryAfter(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

type AssistantContent = Extract<SdkModelMessage, { role: "assistant" }>["content"];

/** Schema-only tools: a declaration the model can call, never an `execute`. */
function toSdkTools(tools: readonly { name: string; description?: string; parameters?: unknown }[]): ToolSet {
  const sdkTools: Record<string, Tool> = {};
  for (const t of tools) {
    sdkTools[t.name] = defineTool({
      ...(t.description ? { description: t.description } : {}),
      inputSchema: jsonSchema((t.parameters ?? { type: "object" }) as Parameters<typeof jsonSchema>[0]),
    });
  }
  return sdkTools;
}

/** Rebuilds the log's messages as the SDK's prompt (RUNTIME §5.1). */
function toSdkMessages(messages: readonly ModelMessage[]): SdkModelMessage[] {
  return messages.map((m): SdkModelMessage => {
    if (m.role === "user") return { role: "user", content: m.text };
    if (m.role === "tool") {
      return {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: m.toolCallId ?? "", toolName: "tool", output: { type: "text", value: m.text } }],
      };
    }
    // Assistant: the text plus the calls it asked for, verbatim from the log.
    const parts: Extract<AssistantContent, unknown[]> = [];
    if (m.text) parts.push({ type: "text", text: m.text });
    for (const call of m.toolCalls ?? []) {
      const c = call as { id?: unknown; toolCallId?: unknown; name?: unknown; toolName?: unknown; args?: unknown; input?: unknown };
      parts.push({
        type: "tool-call",
        toolCallId: String(c.toolCallId ?? c.id ?? ""),
        toolName: String(c.toolName ?? c.name ?? ""),
        input: (c.input ?? c.args ?? {}) as Record<string, never>,
      });
    }
    return { role: "assistant", content: parts };
  });
}
