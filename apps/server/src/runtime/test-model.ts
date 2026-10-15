// The MODEL_PORT=test double (S5): one fixed rule — echo the last user text,
// no tool calls. A test double for CI and smoke scripts, never scripted Dana:
// no recorded transcripts, no branching.
//
// S6 added a chunked shape; R16 makes the chunks INCREMENTS — raw text slices,
// the production port's shape — so the `ll.call` worker's accumulation and the
// stream endpoint's batching and mid-call join bite on real-shaped input. The
// emit log (R16) records every increment with the wall clock at the emit, the
// D5/D6 test hook: the runtime constructs the port internally, so tests reset
// and read this module-level log around the run.
import type { ModelCallRequest, ModelPort, ModelResult } from "@fabric/runtime";

export type TestModelOptions = {
  /** Text increments per reply; 1 (the S5 single-shot) by default. */
  chunks?: number;
  /** Milliseconds between chunk emits. */
  intervalMs?: number;
};

/** One emitted increment: the text and the wall clock at the emit (R16). */
export type TestModelEmit = { at: number; text: string };

const emitLog: TestModelEmit[] = [];

/** The increments the test model has emitted, in order, across calls. */
export const testModelEmits = (): readonly TestModelEmit[] => emitLog;

/** Test setup: forget every recorded emit. */
export const resetTestModelEmits = (): void => {
  emitLog.length = 0;
};

export function createTestModelPort(options: TestModelOptions = {}): ModelPort {
  const chunks = Math.max(1, options.chunks ?? 1);
  const intervalMs = Math.max(0, options.intervalMs ?? 0);
  return {
    async call(request: ModelCallRequest): Promise<ModelResult> {
      const lastUser = [...request.messages].reverse().find((message) => message.role === "user");
      const text = `echo: ${lastUser?.text ?? ""}`;
      // never emit an empty trailing increment when the text is shorter than the count
      const count = Math.min(chunks, Math.max(1, text.length));
      const size = Math.ceil(text.length / count);
      let start = 0;
      for (let index = 1; index <= count; index += 1) {
        if (index > 1 && intervalMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
        const end = index === chunks ? text.length : Math.min(text.length, index * size);
        const increment = text.slice(start, end);
        start = end;
        emitLog.push({ at: Date.now(), text: increment });
        request.onDelta?.({ text: increment });
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
