// Dana on the real server (WORK-PLAN §4.3): POST /api/chat {sessionId, messages} through lib/api and
// read the NDJSON stream. Each line is a cumulative snapshot of the assistant message, so it replaces
// the content. The human-tool flow is unchanged: a card's addResult stamps {decision} on its part and
// starts the next run, which re-sends the thread with the result; the server diffs it against its own copy.
import type { ChatModelAdapter, ThreadMessage } from "@assistant-ui/react";
import type { ChatPart } from "@fabric/contracts";
import { httpApi } from "@/lib/api";
import { mockAssistant, mockContext } from "@/lib/mock/chat";
import { takeFixture } from "./fixture";
import { markSent, toRuntimePart } from "./session";

/** The thread as the server reads it: text and tool-call parts only. */
export function toWire(messages: readonly ThreadMessage[]) {
  return messages.map((m) => ({
    role: m.role,
    content: m.content.flatMap((p): ChatPart[] => {
      if (p.type === "text") return [{ type: "text", text: p.text }];
      if (p.type === "tool-call") {
        return [{ type: "tool-call", toolCallId: p.toolCallId, toolName: p.toolName, args: p.args, ...(p.result !== undefined ? { result: p.result } : {}) }];
      }
      return [];
    }),
  }));
}

export function httpAssistant(sessionId: string): ChatModelAdapter {
  return {
    async *run(options) {
      // Phase 1 serves Dana only: direct and team chats with anyone else keep the mock placeholder.
      if (mockContext.agent !== "Dana") {
        yield* mockAssistant.run(options) as AsyncGenerator<{ content: never[] }>;
        return;
      }
      const fixture = takeFixture();
      markSent(sessionId);
      let any = false;
      for await (const line of httpApi.chat({ sessionId, messages: toWire(options.messages), ...(fixture ? { fixture: true } : {}) }, options.abortSignal)) {
        any = true;
        yield { content: line.content.map(toRuntimePart) };
      }
      if (!any) throw new Error("Dana didn't answer. Send it again, or press Ctrl+Shift+F for scripted Dana.");
    },
  };
}
