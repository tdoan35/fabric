// The MODEL_PORT=test double (S5): one fixed rule — echo the last user text,
// no tool calls. A test double for CI and smoke scripts, never scripted Dana:
// no recorded transcripts, no branching.
import type { ModelCallRequest, ModelPort, ModelResult } from "@fabric/runtime";

export function createTestModelPort(): ModelPort {
  return {
    async call(request: ModelCallRequest): Promise<ModelResult> {
      const lastUser = [...request.messages].reverse().find((message) => message.role === "user");
      const text = `echo: ${lastUser?.text ?? ""}`;
      request.onDelta?.({ text });
      return {
        text,
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        finishReason: "stop",
      };
    },
  };
}
