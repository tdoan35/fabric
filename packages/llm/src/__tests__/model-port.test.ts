// ANY-53 S4: the production ModelPort over the AI SDK (RUNTIME §4 `llm.call`):
// one streamText call, tools as schemas only (the SDK returns calls, never runs
// them), per-call cost from the price tables, mapped { status, retryable } errors,
// caller aborts. No network: every model is a MockLanguageModelV4; streams come
// from simulateReadableStream.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APICallError } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { LanguageModelV4CallOptions, LanguageModelV4FinishReason, LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import { createModelPort } from "../model-port";
import { NEON_PRICES } from "../index";

type Chunk = LanguageModelV4StreamPart;

/** The v4 usage block, nested totals — what a provider's finish part carries. */
const v4Usage = (inputTokens: number, outputTokens: number): LanguageModelV4Usage => ({
  inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 },
});

/** A mock model whose doStream emits `chunks` (with optional pacing); counts calls, keeps the request. */
function modelEmitting(
  chunks: Chunk[],
  pacing: { initialDelayInMs?: number; chunkDelayInMs?: number } = {},
) {
  const calls: LanguageModelV4CallOptions[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (callOptions: LanguageModelV4CallOptions) => {
      calls.push(callOptions);
      return { stream: simulateReadableStream({ chunks, ...pacing }) };
    },
  });
  return { model, calls: () => calls };
}

const textStream = (parts: string[], finish: LanguageModelV4FinishReason = "stop", usage = v4Usage(11, 7)): Chunk[] => [
  { type: "stream-start", warnings: [] },
  ...parts.flatMap((delta): Chunk[] => [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta },
    { type: "text-end", id: "t1" },
  ]),
  { type: "finish", finishReason, usage },
];

const toolStream = (calls: { id: string; name: string; input: string }[]): Chunk[] => [
  { type: "stream-start", warnings: [] },
  ...calls.map(({ id, name, input }): Chunk => ({ type: "tool-call", toolCallId: id, toolName: name, input })),
  { type: "finish", finishReason: "tool-calls", usage: v4Usage(3, 2) },
];

const call = (
  port: ReturnType<typeof createModelPort>,
  request: Partial<Parameters<ReturnType<typeof createModelPort>["call"]>[0]> & { signal?: AbortSignal } = {},
) =>
  port.call({
    system: "You are Dana.",
    messages: [{ role: "user", text: "hi" }],
    tools: [],
    ...request,
  });

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("LLM_PROVIDER", "spark");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createModelPort", () => {
  it("M1: a text-only stream yields the text, no tool calls, stop, and the stream's usage tokens", async () => {
    const { model } = modelEmitting(textStream(["Hello ", "there"]));
    const port = createModelPort({ modelFor: () => model });

    const result = await call(port);

    expect(result.text).toBe("Hello there");
    expect(result.toolCalls).toEqual([]);
    expect(result.finishReason).toBe("stop");
    expect(result.usage.inputTokens).toBe(11);
    expect(result.usage.outputTokens).toBe(7);
  });

  it("M2: two tool calls come back parsed, in order, and no tool is executed", async () => {
    const { model } = modelEmitting(
      toolStream([
        { id: "c1", name: "lookup", input: JSON.stringify({ q: "dana" }) },
        { id: "c2", name: "shout", input: JSON.stringify({}) },
      ]),
    );
    const port = createModelPort({ modelFor: () => model });
    // Schema-only declarations: no `execute` anywhere, so the port cannot run one.
    const tools = [
      { name: "lookup", description: "find a thing", parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
      { name: "shout", parameters: { type: "object", properties: {} } },
    ];
    for (const t of tools) expect("execute" in t).toBe(false);

    const result = await call(port, { tools });

    expect(result.toolCalls).toEqual([
      { id: "c1", name: "lookup", args: { q: "dana" } },
      { id: "c2", name: "shout", args: {} },
    ]);
  });

  it("M3: deltas reach the callback in order and join to the final text", async () => {
    const { model } = modelEmitting(textStream(["a", "b", "c"]));
    const port = createModelPort({ modelFor: () => model });
    const deltas: string[] = [];

    const result = await call(port, { onDelta: (d: { text: string }) => void deltas.push(d.text) });

    expect(deltas).toEqual(["a", "b", "c"]);
    expect(deltas.join("")).toBe(result.text);
    expect(result.text).toBe("abc");
  });

  it("M4: costUsd is the price table times the tokens on a priced lane, and 0 where no price exists", async () => {
    // Neon: claude-sonnet-5 is in NEON_PRICES.
    vi.stubEnv("LLM_PROVIDER", "neon");
    const priced = modelEmitting(textStream(["x"], "stop", v4Usage(2_000_000, 1_000_000)));
    const neonPort = createModelPort({ modelFor: () => priced.model });
    const neon = await call(neonPort);
    const price = NEON_PRICES["claude-sonnet-5"];
    // 2M input and 1M output tokens at the table's per-Mtok rates.
    expect(neon.usage.costUsd).toBe(2 * price!.inputPerMtok + 1 * price!.outputPerMtok);

    // Spark: the lane carries no per-token price, so the cost is 0 — without throwing.
    vi.stubEnv("LLM_PROVIDER", "spark");
    const free = modelEmitting(textStream(["y"], "stop", v4Usage(5, 9)));
    const sparkPort = createModelPort({ modelFor: () => free.model });
    const spark = await call(sparkPort);
    expect(spark.usage.costUsd).toBe(0);
  });

  it("M5: a 429 with retry-after maps to retryable with the header's seconds; a 503 is retryable with none", async () => {
    const throttled = modelEmitting([
      { type: "stream-start", warnings: [] },
      { type: "error", error: new APICallError({ message: "slow down", url: "x", requestBodyValues: {}, statusCode: 429, responseHeaders: { "retry-after": "30" }, isRetryable: true }) },
    ]);
    const rateLimited = createModelPort({ modelFor: () => throttled.model });
    const err429 = await call(rateLimited).then(
      () => undefined,
      (e) => e,
    );
    expect(err429).toMatchObject({ status: 429, retryable: true, retryAfter: 30 });

    const down = modelEmitting([
      { type: "stream-start", warnings: [] },
      { type: "error", error: new APICallError({ message: "unavailable", url: "x", requestBodyValues: {}, statusCode: 503, responseHeaders: {}, isRetryable: true }) },
    ]);
    const maintenance = createModelPort({ modelFor: () => down.model });
    const err503 = await call(maintenance).then(
      () => undefined,
      (e) => e,
    );
    expect(err503).toMatchObject({ status: 503, retryable: true });
    expect(err503.retryAfter).toBeUndefined();
  });

  it("M6: a 400 is a hard failure — retryable false", async () => {
    const bad = modelEmitting([
      { type: "stream-start", warnings: [] },
      { type: "error", error: new APICallError({ message: "bad request", url: "x", requestBodyValues: {}, statusCode: 400, responseHeaders: {}, isRetryable: false }) },
    ]);
    const port = createModelPort({ modelFor: () => bad.model });

    const err = await call(port).then(
      () => undefined,
      (e) => e,
    );

    expect(err).toMatchObject({ status: 400, retryable: false });
  });

  it("M7: aborting mid-stream rejects promptly and no delta lands after the abort", async () => {
    const { model } = modelEmitting(textStream(["slow", "mo", "tion"], "stop", v4Usage(1, 1)), {
      initialDelayInMs: 5,
      chunkDelayInMs: 50,
    });
    const port = createModelPort({ modelFor: () => model });
    const deltas: string[] = [];
    const ctl = new AbortController();

    const pending = call(port, { onDelta: (d: { text: string }) => void deltas.push(d.text), signal: ctl.signal });
    await vi.waitFor(() => expect(deltas.length).toBeGreaterThan(0));
    ctl.abort();
    await expect(pending).rejects.toThrow();
    const atAbort = deltas.length;
    await new Promise((r) => setTimeout(r, 120)); // longer than one chunk delay
    expect(deltas.length).toBe(atAbort);
  });

  it("M8: the model is called exactly once, even when the stream ends in tool calls", async () => {
    const { model, calls } = modelEmitting(
      toolStream([{ id: "c1", name: "lookup", input: JSON.stringify({ q: "once" }) }]),
    );
    const port = createModelPort({ modelFor: () => model });

    const result = await call(port, {
      tools: [{ name: "lookup", parameters: { type: "object", properties: { q: { type: "string" } } } }],
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(calls()).toHaveLength(1);
  });

  it("passes the system prompt, the rebuilt messages and the schema-only tools to that one call", async () => {
    const { model, calls } = modelEmitting(textStream(["ok"]));
    const port = createModelPort({ modelFor: () => model });

    await call(port, {
      messages: [
        { role: "user", text: "first" },
        { role: "assistant", text: "second" },
      ],
      tools: [{ name: "lookup", parameters: { type: "object", properties: {} } }],
    });

    const prompt = JSON.stringify(calls()[0]?.prompt ?? []);
    expect(prompt).toContain("You are Dana.");
    expect(prompt).toContain("first");
    expect(prompt).toContain("second");
    expect(calls()[0]?.tools).toHaveLength(1);
  });
});
