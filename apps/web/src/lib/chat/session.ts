// Thread identity (IA-5): every thread has a sessionId, kept in the URL (`/?session=<id>`) so a
// reload or a title-bar tab restores it. In http mode its history loads from the server on mount.
import type { ThreadMessageLike } from "@assistant-ui/react";
import type { ChatPart, Session, ThreadMessage } from "@fabric/contracts";
import { httpApi, httpMode } from "@/lib/api";

export const SESSION_PARAM = "session";

/** Ids minted in this page that no turn has been sent on yet: no history, so they mount without a fetch. */
const minted = new Set<string>();

export function newSessionId(): string {
  const id = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  minted.add(id);
  return id;
}

export const threadPath = (sessionId: string) => `/?${SESSION_PARAM}=${encodeURIComponent(sessionId)}`;

/** Where a sidebar row opens: its own thread, unless the row links somewhere specific (a board). */
export const sessionHref = (session: Session) => (session.href === "/" ? threadPath(session.id) : session.href);

/** A stored part as the runtime holds it. */
export function toRuntimePart(p: ChatPart) {
  if (p.type === "text") return { type: "text" as const, text: p.text };
  return {
    type: "tool-call" as const,
    toolCallId: p.toolCallId,
    toolName: p.toolName,
    args: (p.args ?? {}) as Record<string, never>,
    argsText: p.argsText ?? JSON.stringify(p.args ?? {}),
    ...(p.result !== undefined ? { result: p.result } : {}),
  };
}

export const toRuntimeMessage = (m: ThreadMessage): ThreadMessageLike => ({
  id: m.id,
  role: m.role,
  content: m.content.map(toRuntimePart),
  createdAt: new Date(m.createdAt),
});

export async function fetchHistory(sessionId: string): Promise<ThreadMessage[]> {
  return (await httpApi.getSessionMessages(sessionId)).messages;
}

/** True when the thread can't have history: minted here and never sent, or mock mode (nothing is stored). */
export const knownEmpty = (sessionId: string) => !httpMode || minted.has(sessionId);

/** A turn went out on this thread: from now on its history lives on the server. */
export const markSent = (sessionId: string) => { minted.delete(sessionId); };

/** The thread's stored messages (none for a known-empty thread). */
export async function loadThread(sessionId: string): Promise<ThreadMessageLike[]> {
  if (knownEmpty(sessionId)) return [];
  return (await fetchHistory(sessionId)).map(toRuntimeMessage);
}
