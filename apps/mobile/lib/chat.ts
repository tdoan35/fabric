// S13: chat moves onto the durable-session protocol (ARCHITECTURE §10, RUNTIME
// §13 "post, then follow"): createSession / postMessage commands plus the SSE
// session stream, all through @fabric/contracts' platform-neutral session
// client (S12a). The fetch implementation is injected — expo/fetch in the app
// (RN's global fetch can't stream response bodies), node's fetch in
// scripts/chat-smoke.mts — so the smoke script drives the exact send path the
// app uses. The stream half of the protocol lives in lib/session-stream.ts.
// Legacy threads (scripted Dana's /api/chat store: `c1`, `t-*` ids) are
// read-only from here on; S14 retires that path entirely.
import { createSession, postMessage, type FetchLike } from "@fabric/contracts";
import { apiBase } from "./api";

export type { FetchLike };

/** The agent a mobile session hosts. The phone serves Dana only (the Chat tab
 * keeps the other specialists read-only), and createSession snapshots her turn
 * definition (S7) into the session's opening facts. */
export const MOBILE_AGENT_ID = "dana";

/** A fresh local thread key, the web's format (apps/web/src/lib/chat/session.ts
 * newSessionId). The Chat tab mints one only to key the empty ThreadView; the
 * durable session's real id is minted by the server at createSession time. */
export function newSessionId(): string {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * A v4 uuid for `clientMessageId` — the key the server dedupes reposts on
 * (message.received.platformMessageId). Passed explicitly on every post: the
 * contracts client's fallback (`crypto.randomUUID`) doesn't exist on RN/Hermes.
 * Not a secret — Math.random's entropy is plenty for a dedup key.
 */
export function newClientMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  let out = "";
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += "-";
    else if (i === 14) out += "4";
    else out += Math.floor(Math.random() * 16).toString(16);
  }
  return out;
}

/** POST /api/sessions: the server mints the session id and appends the opening
 * facts. Incognito sessions never reach any list (PRODUCT §10.7). */
export async function createChatSession(
  fetchImpl: FetchLike,
  agentId: string = MOBILE_AGENT_ID,
  incognito?: boolean,
): Promise<string> {
  const res = await createSession(fetchImpl, apiBase, { agentId, incognito });
  return res.sessionId;
}

/** POST /api/sessions/:id/messages — idempotent on `clientMessageId` (the
 * retries inside the contracts client reuse it). Returns the appended seq. */
export async function sendChatMessage(
  fetchImpl: FetchLike,
  sessionId: string,
  text: string,
  clientMessageId: string = newClientMessageId(),
): Promise<number> {
  const res = await postMessage(fetchImpl, apiBase, sessionId, { text, clientMessageId });
  return res.seq;
}
