// `session.message {sessionId, messageId}` from the app stream (routes/root.tsx), handed to the open
// thread so Dana's results message (CHAT-14) lands without a reload.
type SessionMessage = { sessionId: string; messageId: string };

const listeners = new Set<(e: SessionMessage) => void>();

export function publishSessionMessage(e: SessionMessage) {
  for (const listener of listeners) listener(e);
}

export function onSessionMessage(listener: (e: SessionMessage) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
