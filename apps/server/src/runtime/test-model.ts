// The MODEL_PORT=test double (S5): one fixed rule — echo the last user text,
// no tool calls. A test double for CI and smoke scripts, never scripted Dana:
// no recorded transcripts, no branching.
//
// S6 adds the chunked shape: the same echo, streamed as N cumulative `onDelta`s
// a fixed interval apart, so the stream endpoint's batching and mid-call join
// have something to bite on. Test infrastructure per the card.
import type { ModelCallRequest, ModelPort, ModelResult } from "@fabric/runtime";

export type TestModelOptions = {
  /** Cumulative onDelta calls per reply; 1 (the S5 shape) by default. */
  chunks?: number;
  /** Milliseconds between chunk deltas. */
  intervalMs?: number;
};

export function createTestModelPort(options: TestModelOptions = {}): ModelPort {
  const chunks = Math.max(1, options.chunks ?? 1);
  const intervalMs = Math.max(0, options.intervalMs ?? 0);
  return {
    async call(request: ModelCallRequest): Promise<ModelResult> {
      const lastUser = [...request.messages].reverse().find((message) => message.role === "user");
      const text = `echo: ${lastUser?.text ?? ""}`;
      const size = Math.ceil(text.length / chunks);
      for (let index = 1; index <= chunks; index += 1) {
        if (index > 1 && intervalMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
        const end = index === chunks ? text.length : Math.min(text.length, index * size);
        request.onDelta?.({ text: text.slice(0, end) });
      }
      return {
        text,
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        finishReason: "stop",
      };
    },
  };
}
