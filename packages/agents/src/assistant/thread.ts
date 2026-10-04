// Pure thread logic (DANA 2): the server's stored thread is authoritative, so each request is
// diffed against it instead of trusted. Only two things are ever taken from the client (§7.0 brief):
//   1. the latest user message, when the client put a new one last;
//   2. the {decision} results on human tool calls the server itself stored as pending.
// Everything else the client sends is ignored. No IO here — unit-tested in isolation.
import type { ModelMessage } from "ai";
import type { ChatPart, ProposalDecision, ThreadMessage } from "@fabric/contracts";

/** What the request's messages claim, parsed defensively (the web runtime's own shape). */
export interface IncomingPart {
  type: "text" | "tool-call";
  text?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
}

export interface IncomingMessage {
  role: "user" | "assistant" | "system";
  parts: IncomingPart[];
}

/** Human tools whose results arrive as {decision} on the next request (D2). */
export const HUMAN_TOOLS = new Set(["propose_team", "propose_specialist"]);

const parsePart = (p: unknown): IncomingPart | undefined => {
  if (!p || typeof p !== "object") return undefined;
  const part = p as Record<string, unknown>;
  if (part.type === "text" && typeof part.text === "string") return { type: "text", text: part.text };
  if (part.type === "tool-call" && typeof part.toolCallId === "string" && typeof part.toolName === "string") {
    return { type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, args: part.args, result: part.result };
  }
  return undefined;
};

/** Accepts the thread as the web runtime holds it; unknown shapes drop out, never throw. */
export function parseIncoming(messages: unknown[]): IncomingMessage[] {
  const out: IncomingMessage[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const msg = m as Record<string, unknown>;
    const role = msg.role;
    if (role !== "user" && role !== "assistant" && role !== "system") continue;
    const rawContent = msg.content;
    const rawParts = Array.isArray(rawContent)
      ? rawContent
      : typeof rawContent === "string"
        ? [{ type: "text", text: rawContent }]
        : Array.isArray(msg.parts)
          ? msg.parts
          : [];
    const parts = rawParts.map(parsePart).filter((p): p is IncomingPart => !!p);
    out.push({ role, parts });
  }
  return out;
}

export interface DecisionDelta {
  toolCallId: string;
  toolName: string;
  decision: ProposalDecision;
}

export interface ThreadDelta {
  /** Set when the client put a new user message last (the mock runtime's "run" contract). */
  newUserText?: string;
  /** Decisions on human tool calls the server stored pending and hasn't seen a result for. */
  decisions: DecisionDelta[];
}

const textOf = (parts: IncomingPart[]): string =>
  parts.filter((p): p is IncomingPart & { type: "text" } => p.type === "text").map((p) => p.text ?? "").join(" ").trim();

const decisionOf = (part: IncomingPart): ProposalDecision | undefined => {
  const d = (part.result as { decision?: unknown } | undefined)?.decision;
  return d === "approved" || d === "declined" || d === "discuss" ? d : undefined;
};

/** Diffs the request against the stored thread. Pure; the persistence layer acts on the result. */
export function diffThread(stored: ThreadMessage[], incoming: IncomingMessage[]): ThreadDelta {
  // ---- decisions: results on stored human-tool calls that the stored copy doesn't carry yet ----
  const storedCalls = new Map<string, { result?: unknown }>();
  for (const m of stored) {
    for (const p of m.content) {
      if (p.type === "tool-call") storedCalls.set(p.toolCallId, { result: p.result });
    }
  }
  const decisions: DecisionDelta[] = [];
  for (const m of incoming) {
    if (m.role !== "assistant") continue;
    for (const p of m.parts) {
      if (p.type !== "tool-call" || !p.toolCallId || !p.toolName) continue;
      if (!HUMAN_TOOLS.has(p.toolName)) continue;
      const decision = decisionOf(p);
      if (!decision) continue;
      const known = storedCalls.get(p.toolCallId);
      if (!known) continue; // the server never stored this call: not ours to decide
      if (known.result !== undefined) continue; // already applied
      decisions.push({ toolCallId: p.toolCallId, toolName: p.toolName, decision });
    }
  }

  // ---- the latest user message: new only when it lands last and isn't the stored tail ----
  let newUserText: string | undefined;
  const last = incoming[incoming.length - 1];
  if (last && last.role === "user") {
    const text = textOf(last.parts);
    const lastStoredUser = [...stored].reverse().find((m) => m.role === "user");
    const lastStoredText = lastStoredUser
      ? (lastStoredUser.content.filter((p) => p.type === "text") as { type: "text"; text: string }[]).map((p) => p.text).join(" ").trim()
      : "";
    if (text && text !== lastStoredText) newUserText = text;
  }

  return { newUserText, decisions };
}

/** Maps the stored thread onto AI SDK model messages; human-tool results ride as tool messages. */
export function toModelMessages(stored: ThreadMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of stored) {
    if (m.role === "user") {
      const text = (m.content.filter((p) => p.type === "text") as { type: "text"; text: string }[]).map((p) => p.text).join(" ");
      out.push({ role: "user", content: text });
      continue;
    }
    const content: Extract<ModelMessage, { role: "assistant" }>["content"] = [];
    const results: Extract<ModelMessage, { role: "tool" }>["content"] = [];
    for (const p of m.content) {
      if (p.type === "text") content.push({ type: "text", text: p.text });
      else {
        content.push({ type: "tool-call", toolCallId: p.toolCallId, toolName: p.toolName, input: p.args as Record<string, unknown> });
        if (p.result !== undefined) results.push({ type: "tool-result", toolCallId: p.toolCallId, toolName: p.toolName, output: { type: "json", value: JSON.parse(JSON.stringify(p.result)) } });
      }
    }
    if (content.length) out.push({ role: "assistant", content });
    if (results.length) out.push({ role: "tool", content: results });
  }
  return out;
}

/** The text parts of a stored or incoming message, joined — for titles and fixture branching. */
export function joinedText(content: ChatPart[]): string {
  return (content.filter((p) => p.type === "text") as { type: "text"; text: string }[]).map((p) => p.text).join(" ").trim();
}
