// llm unit tests: thinking request bodies per level, defaults, model mapping, metering.
// No network: fetch is stubbed at the provider boundary.
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { generateObject, generateText, streamText } from "ai";
import { z } from "zod";
import { defaultThinking, model, modelFamily, providerModelId, neonAnthropicOptions, runCostUsd, runUsages, sparkThinkingBody, type MeterContext, type ThinkingLevel } from "../llm";

const sparkCompletion = (usage: Record<string, unknown> = { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 }) => ({
  id: "cmpl-1",
  object: "chat.completion",
  created: 1,
  model: "qwen3.8-flash-next",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage,
});

type Body = Record<string, unknown>;
type Call = { url: string; body: Body };

/** Stubs global fetch; every POST body is captured and answered with the canned payload. */
function stubFetch(respond: (call: Call) => unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
    // the provider always POSTs a JSON object here
    const body = JSON.parse(String(init?.body ?? "{}")) as Body;
    const call = { url: String(url), body };
    calls.push(call);
    const payload = respond(call);
    return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": typeof payload === "string" ? "text/event-stream" : "application/json" },
    });
  });
  return calls;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("LLM_PROVIDER", "spark");
  vi.stubEnv("SPARK_BASE_URL", "http://spark.test/v1");
  vi.stubEnv("SPARK_API_KEY", "test-key");
  vi.stubEnv("SPARK_MODEL", "qwen3.8-flash-next");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("sparkThinkingBody", () => {
  it("maps every level to the probed request body and never sends none", () => {
    expect(sparkThinkingBody({}, "off")).toEqual({ chat_template_kwargs: { enable_thinking: false } });
    expect(sparkThinkingBody({}, "low")).toEqual({ reasoning_effort: "low" });
    expect(sparkThinkingBody({}, "medium")).toEqual({ reasoning_effort: "medium" });
    expect(sparkThinkingBody({}, "high")).toEqual({});
    for (const level of ["off", "low", "medium", "high"] as const) {
      expect(JSON.stringify(sparkThinkingBody({ model: "m" }, level))).not.toContain("none");
    }
  });

  it("merges chat_template_kwargs instead of clobbering it", () => {
    expect(sparkThinkingBody({ chat_template_kwargs: { other: true } }, "off")).toEqual({
      chat_template_kwargs: { other: true, enable_thinking: false },
    });
  });
});

describe("thinking levels on the wire (model → request body)", () => {
  async function requestBody(opts: { thinking?: ThinkingLevel; meter?: MeterContext }): Promise<Body> {
    const calls = stubFetch(() => sparkCompletion());
    await generateText({ model: model("Sonnet 5.5", opts), prompt: "route this" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("http://spark.test/v1");
    return calls[0].body;
  }

  it("off sends chat_template_kwargs.enable_thinking=false and no reasoning_effort", async () => {
    const body = await requestBody({ thinking: "off" });
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("low and medium send top-level reasoning_effort", async () => {
    expect((await requestBody({ thinking: "low" })).reasoning_effort).toBe("low");
    expect((await requestBody({ thinking: "medium" })).reasoning_effort).toBe("medium");
  });

  it("high sends nothing extra (the template's xhigh default)", async () => {
    const body = await requestBody({ thinking: "high" });
    expect(body.chat_template_kwargs).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("defaults: dana off, everyone else medium, without opts.thinking", async () => {
    expect((await requestBody({ meter: { agentId: "dana" } })).chat_template_kwargs).toEqual({ enable_thinking: false });
    expect((await requestBody({ meter: { agentId: "jonah", step: "Setup" } })).reasoning_effort).toBe("medium");
    expect(defaultThinking("dana")).toBe("off");
    expect(defaultThinking("jonah")).toBe("medium");
    expect(defaultThinking(undefined)).toBe("medium");
  });
});

describe("neonAnthropicOptions", () => {
  it("always asks for JSON-tool structured output (the gateway rejects output_config.format)", () => {
    for (const level of ["off", "low", "medium", "high"] as const) {
      expect(neonAnthropicOptions("claude-sonnet-5", level).structuredOutputMode).toBe("jsonTool");
    }
  });
  it("off disables thinking", () => {
    expect(neonAnthropicOptions("claude-opus-5-5", "off").thinking).toEqual({ type: "disabled" });
  });
  it("5-series: adaptive thinking steered by effort", () => {
    expect(neonAnthropicOptions("claude-sonnet-5", "low")).toMatchObject({ thinking: { type: "adaptive" }, effort: "low" });
  });
  it("Haiku 4.5: a token budget per level", () => {
    expect(neonAnthropicOptions("claude-haiku-4-5", "medium")).toMatchObject({ thinking: { type: "enabled", budgetTokens: 4096 } });
  });
});

describe("neon wire: structured output (model → request body)", () => {
  const anthropicReply = (input: unknown) => ({
    id: "msg_1", type: "message", role: "assistant", model: "m", stop_reason: "tool_use", stop_sequence: null,
    content: [{ type: "tool_use", id: "tu_1", name: "json", input }],
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  beforeEach(() => {
    vi.stubEnv("LLM_PROVIDER", "neon");
    vi.stubEnv("NEON_AI_GATEWAY_BASE_URL", "https://gw.test");
    vi.stubEnv("NEON_AI_GATEWAY_TOKEN", "nt_test");
  });
  const schema = z.object({ verdict: z.enum(["accept", "request_changes"]) });

  it("Opus 5.5 schema calls run on claude-opus-5 as a forced JSON tool, thinking off", async () => {
    const calls = stubFetch(() => anthropicReply({ verdict: "accept" }));
    const { object } = await generateObject({ model: model("Opus 5.5", { thinking: "medium" }), schema, prompt: "verdict?" });
    expect(object).toEqual({ verdict: "accept" });
    expect(calls[0].body.model).toBe("claude-opus-5");
    expect(calls[0].body.thinking).toEqual({ type: "disabled" });
    expect(calls[0].body.output_config).toBeUndefined();
  });

  it("a forced tool choice (Dana's first step) on Opus 5.5 stays on Opus 5.5", async () => {
    const calls = stubFetch(() => anthropicReply({ verdict: "accept" }));
    await generateText({
      model: model("Opus 5.5", { thinking: "high" }), prompt: "route",
      tools: { json: { description: "d", inputSchema: schema } }, toolChoice: { type: "tool", toolName: "json" },
    });
    expect(calls[0].body.model).toBe("claude-opus-5-5");
  });

  it("Fable 5.1 free calls stay on claude-fable-5-1 with adaptive xhigh effort", async () => {
    const calls = stubFetch(() => anthropicReply({ verdict: "accept" }));
    await generateText({ model: model("Fable 5.1", { thinking: "xhigh" }), prompt: "hi" });
    expect(calls[0].body.model).toBe("claude-fable-5-1");
    expect(calls[0].body.thinking).toEqual({ type: "adaptive" });
    expect(calls[0].body.output_config).toMatchObject({ effort: "xhigh" });
  });

  it("a forced tool choice on Sonnet keeps the force and turns thinking off", async () => {
    const calls = stubFetch(() => anthropicReply({ verdict: "accept" }));
    await generateText({
      model: model("Sonnet 5.5", { thinking: "high" }), prompt: "route",
      tools: { json: { description: "d", inputSchema: schema } }, toolChoice: { type: "tool", toolName: "json" },
    });
    expect(calls[0].body.thinking).toEqual({ type: "disabled" });
    expect(calls[0].body.tool_choice).toMatchObject({ type: "tool", name: "json" });
  });

  it("Sonnet schema calls stay on their model with thinking off", async () => {
    const calls = stubFetch(() => anthropicReply({ verdict: "accept" }));
    await generateObject({ model: model("Sonnet 5.5", { thinking: "high" }), schema, prompt: "verdict?" });
    expect(calls[0].body.model).toBe("claude-sonnet-5");
    expect(calls[0].body.thinking).toEqual({ type: "disabled" });
  });
});

describe("model mapping", () => {
  it("spark maps every display model to SPARK_MODEL", () => {
    expect(providerModelId(modelFamily("Sonnet 5.5"), "spark")).toBe("qwen3.8-flash-next");
    expect(providerModelId(modelFamily(""), "spark")).toBe("qwen3.8-flash-next");
    expect(providerModelId(modelFamily("Haiku 4.5"), "spark")).toBe("qwen3.8-flash-next");
    expect(providerModelId(modelFamily("Opus 5.5"), "spark")).toBe("qwen3.8-flash-next");
  });

  it("openrouter and neon map display families to their catalog ids", () => {
    expect(providerModelId("sonnet", "openrouter")).toBe("anthropic/claude-sonnet-5.5");
    expect(providerModelId("haiku", "openrouter")).toBe("anthropic/claude-haiku-4.5");
    expect(providerModelId("opus", "openrouter")).toBe("anthropic/claude-opus-5.5");
    expect(providerModelId("sonnet", "neon")).toBe("claude-sonnet-5");
    expect(providerModelId(modelFamily("Fable 5.1"), "neon")).toBe("claude-fable-5-1");
    expect(providerModelId("haiku", "neon")).toBe("claude-haiku-4-5");
  });

  it("neon without the venue env throws a clear configuration error", () => {
    vi.stubEnv("LLM_PROVIDER", "neon");
    vi.stubEnv("NEON_AI_GATEWAY_BASE_URL", "");
    vi.stubEnv("NEON_AI_GATEWAY_TOKEN", "");
    expect(() => model("Sonnet 5.5")).toThrow(/NEON_AI_GATEWAY/);
  });
});

describe("meter", () => {
  it("records usage with the model that actually ran, and accumulates run cost (generate)", async () => {
    vi.stubEnv("LLM_PROVIDER", "openrouter");
    vi.stubEnv("OPENROUTER_API_KEY", "or-key");
    const calls = stubFetch(() => ({
      ...sparkCompletion(),
      model: "anthropic/claude-haiku-4.5",
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, cost: 0.00021 },
    }));
    await generateText({ model: model("Haiku 4.5", { meter: { runId: "run-or", agentId: "megan", step: "Survey" } }), prompt: "hi" });
    await generateText({ model: model("Haiku 4.5", { meter: { runId: "run-or", agentId: "megan" } }), prompt: "hi" });
    expect(calls[0].body.usage).toEqual({ include: true }); // usage accounting requested
    const usages = runUsages("run-or");
    expect(usages).toHaveLength(2);
    expect(usages[0]).toMatchObject({ model: "openrouter:anthropic/claude-haiku-4.5", inputTokens: 10, outputTokens: 20, costUsd: 0.00021 });
    expect(runCostUsd("run-or")).toBeCloseTo(0.00042, 9);
  });

  it("spark costs $0 and still records tokens", async () => {
    stubFetch(() => sparkCompletion({ prompt_tokens: 12, completion_tokens: 34, total_tokens: 46, completion_tokens_details: { reasoning_tokens: 20 } }));
    await generateText({ model: model("Opus 5.5", { thinking: "off", meter: { runId: "run-sp", agentId: "jonah" } }), prompt: "hi" });
    expect(runUsages("run-sp")).toHaveLength(1);
    expect(runUsages("run-sp")[0]).toMatchObject({ model: "spark:qwen3.8-flash-next", inputTokens: 12, outputTokens: 34, costUsd: 0 });
    expect(runCostUsd("run-sp")).toBe(0);
  });

  it("records exactly once per stream, from the finish part", async () => {
    const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 1, model: "qwen3.8-flash-next", choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
    const sse = [
      chunk({ content: "He" }),
      chunk({}, { finish: true, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 } }),
      "data: [DONE]\n\n",
    ].join("");
    stubFetch(() => sse);
    const result = streamText({ model: model("Sonnet 5.5", { thinking: "off", meter: { runId: "run-st", agentId: "elliot", step: "Plan" } }), prompt: "hi" });
    expect(await result.text).toBe("He");
    expect(runUsages("run-st")).toEqual([{ agentId: "elliot", step: "Plan", model: "spark:qwen3.8-flash-next", inputTokens: 7, outputTokens: 5, costUsd: 0 }]);
  });
});
