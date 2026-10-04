import type { ModelMessage } from "ai";
import type { ContextSnapshot } from "@fabric/contracts";
import { countTokens } from "../context";

export function errandContext(system: string, messages: ModelMessage[]): Omit<ContextSnapshot, "id" | "runId" | "assembledAtS"> {
  const sections = [
    { label: "Identity / routing", source: "Dana's current system prompt", content: system },
    { label: "Outer conversation", source: "AI SDK prepareStep messages", content: JSON.stringify(messages) },
    { label: "Tools & policy", source: "Dana errand tools", content: "record_disposition · recall · browser.task (isolated inner loop)" },
  ].map((s) => ({ ...s, ...countTokens(s.content) }));
  return {
    agentId: "dana", step: "browser.before", sections,
    totalTokens: sections.reduce((n, s) => n + s.tokens, 0),
    tools: [{ name: "recall", policy: "allowed" }, { name: "browser.task", policy: "allowed" }],
    notLoaded: "browser DOM · browser screenshots · browser action history · specialist skills",
    note: "Tokenizer estimate. After compares the returned compact payload with the outer baseline; SDK tool-call/message framing and tool JSON schemas are excluded. Inner browser context stays inside browser.task.",
    sandbox: `sprite/${process.env.SPRITE_ASSISTANT || "fabric-assistant"} · egress: public web via private-network-denying proxy`,
  };
}
