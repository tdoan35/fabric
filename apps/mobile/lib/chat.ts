// Chat with Dana over the real server (MOBILE-PLAN §2 M1). Mirrors apps/web/src/lib/api/http.ts
// `chatStream` and apps/web/src/lib/chat/http-assistant.ts `toWire`: POST /api/chat with
// ChatRequestSchema, NDJSON where every line is a CUMULATIVE snapshot of the assistant message —
// replace the in-progress message, never append. The fetch implementation is injected (expo/fetch
// in the app; RN's global fetch can't stream response bodies), so scripts/chat-smoke.mts drives
// this exact generator headlessly under node.
import type { ChatRequest, ChatStreamLine, ThreadMessage } from "@fabric/contracts";
import { ChatRequestSchema, ChatStreamLineSchema } from "@fabric/contracts";
import { apiBase } from "./api";

export type FetchLike = typeof globalThis.fetch;

/**
 * The demo session (MOB-E "Session choice"): **`c1`**. The web mints fresh `t-*` ids per thread
 * (apps/web/src/lib/chat/session.ts newSessionId) and the seed writes no chat rows, so the one
 * session id the demo path uses end to end is `c1` — scripts/check-chat.ts drives its turns and
 * reads /api/sessions/c1/messages, and the task Dana hands off points back at it. Any id works
 * (the server creates the session row on the first turn); this one keeps the phone on the demo
 * thread the desktop shows.
 */
export const DEMO_SESSION_ID = "c1";

/** A fresh thread id, the web's format (apps/web/src/lib/chat/session.ts newSessionId). The server
 * creates the session row on the first turn, so a minted id has no history to fetch. */
export function newSessionId(): string {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

const dev = typeof __DEV__ !== "undefined" && __DEV__;

/** The thread as the server reads it (http-assistant.ts toWire): role + text/tool-call parts only.
 * The server diffs against its own stored thread (assistant/thread.ts) — it takes nothing else. */
export function toWire(messages: ThreadMessage[]): ChatRequest["messages"] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

/** POST /api/chat (§4.3): yields one cumulative ChatStreamLine snapshot per NDJSON line. */
export async function* chatStream(
  fetchImpl: FetchLike,
  body: ChatRequest,
  signal?: AbortSignal,
): AsyncGenerator<ChatStreamLine> {
  const request = ChatRequestSchema.parse(body);
  const response = await fetchImpl(`${apiBase}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    signal,
  }).catch((err: unknown) => {
    if (err instanceof Error && err.name === "AbortError") throw err;
    throw new Error("Can't reach the server. Check that it's running, then send again.");
  });
  if (!response.ok || !response.body) {
    const err = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Dana is unavailable (${response.status})`);
  }
  const parse = (line: string): ChatStreamLine => {
    const value: unknown = JSON.parse(line);
    if (dev) {
      const checked = ChatStreamLineSchema.safeParse(value);
      if (!checked.success) console.warn("[api] /chat line contract mismatch", checked.error.issues);
    }
    return value as ChatStreamLine;
  };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield parse(line);
    }
    if (done) break;
  }
  if (buffer.trim()) yield parse(buffer.trim());
}
