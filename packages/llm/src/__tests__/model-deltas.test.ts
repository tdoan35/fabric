// ANY-94 R16 — D1: the production port's `onDelta` carries raw text INCREMENTS,
// the provider stream's natural shape — not the text so far. Everything
// downstream (the `ll.call` worker's accumulator, the live bus, the wire)
// treats text as cumulative; this pins the boundary between them. A card pin:
// it may pass at the red commit.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { createModelPort } from "../model-port";

type Chunk = LanguageModelV4StreamPart;

const v4Usage = (inputTokens: number, outputTokens: number): LanguageModelV4Usage => ({
  inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 },
});

function modelEmitting(chunks: Chunk[]) {
  const calls: LanguageModelV4CallOptions[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (callOptions: LanguageModelV4CallOptions) => {
      calls.push(callOptions);
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
  return { model, calls: () => calls };
}

const textStream = (parts: string[]): Chunk[] => [
  { type: "stream-start", warnings: [] },
  ...parts.flatMap((delta): Chunk[] => [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta },
    { type: "text-end", id: "t1" },
  ]),
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: v4Usage(11, 7) },
];

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("LLM_PROVIDER", "spark");
  vi.stubEnv("SPARK_BASE_URL", "http://spark.test/v1");
  vi.stubEnv("SPARK_API_KEY", "test-key");
  vi.stubEnv("SPARK_MODEL", "qwen3.8-flash-next");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

it("D1: the production port emits increments — onDelta receives exactly the stream's text deltas, in order", async () => {
  const { model } = modelEmitting(textStream(["Hel", "lo ", "world"]));
  const port = createModelPort({ modelFor: () => model });
  const deltas: string[] = [];

  const result = await port.call({
    system: "You are Dana.",
    messages: [{ role: "user", text: "hi" }],
    tools: [],
    onDelta: (delta: { text: string }) => void deltas.push(delta.text),
  });

  expect(deltas).toEqual(["Hel", "lo ", "world"]);
  // the increments join to the text the port returns
  expect(deltas.join("")).toBe(result.text);
  expect(result.text).toBe("Hello world");
});
