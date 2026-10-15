// One chat thread over the durable-session stream (S13), shared by the Chat
// tab's new thread and /thread/[id]. lib/session-stream.ts follows
// /api/sessions/:id/stream and renders projectThread + applyDelta (the same
// projection as web); sending is createSession / postMessage then the stream
// replays it (RUNTIME §13 — post, then follow). Legacy /api/chat-era threads
// and incognito-purged ones render read-only. Approvals stay on the desktop:
// cards render read-only (components/chat/parts.tsx).
// Web counterpart: components/chat/assistant-thread.tsx + lib/chat (S12b).
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { SessionThreadMessage, ThreadMessage } from "@fabric/contracts";

import { MessageBubble } from "@/components/chat/parts";
import { useSessionThread } from "@/lib/session-stream";
import { theme } from "@/lib/theme";

/** Legacy threads predate the session stream; the composer is web-first now. */
const LEGACY_NOTE = "This thread predates live sessions — it's read-only here. Start a new thread from the Chat tab.";
const PURGED_NOTE = "This incognito session was purged — its log is gone.";

export function ThreadView({ sessionId, fresh, placeholder, agentName = "Dana", disabledNote, renderEmpty, onStarted }: {
  sessionId: string;
  /** Minted on this device and never sent: the durable session is created on the first send. */
  fresh?: boolean;
  placeholder: string;
  agentName?: string;
  /** Set when this agent can't be messaged from the phone; replaces the composer. */
  disabledNote?: string;
  /** The empty-thread body; `fill` puts a prompt in the composer. */
  renderEmpty?: (fill: (text: string) => void) => ReactNode;
  onStarted?: () => void;
}) {
  const thread = useSessionThread(sessionId, { fresh });
  const [draft, setDraft] = useState("");
  const [focusTick, setFocusTick] = useState(0);
  const listRef = useRef<FlatList<SessionThreadMessage>>(null);
  const inputRef = useRef<TextInput>(null);

  const readOnly =
    !!disabledNote ||
    thread.status.kind === "legacy" ||
    thread.status.kind === "purged" ||
    thread.status.kind === "probing";
  const note =
    disabledNote ??
    (thread.status.kind === "legacy" ? LEGACY_NOTE : thread.status.kind === "purged" ? PURGED_NOTE : undefined);

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text || thread.busy) return;
    setDraft("");
    onStarted?.();
    void thread.send(text);
  }, [draft, thread, onStarted]);

  const fill = useCallback((text: string) => {
    setDraft(text);
    setFocusTick((tick) => tick + 1); // the effect below focuses, off the render path
  }, []);
  useEffect(() => {
    if (focusTick > 0) inputRef.current?.focus();
  }, [focusTick]);

  // Follow the thread: every projection update (event or delta) grows the
  // list, so an effect on `messages` scrolls like the old onContentSizeChange
  // without touching a ref during render (react-hooks/refs).
  useEffect(() => {
    listRef.current?.scrollToEnd({ animated: false });
  }, [thread.messages]);

  const data = thread.messages;
  const empty = data.length === 0;
  const loading = thread.status.kind === "probing";

  return (
    <View style={styles.fill}>
      {empty ? (
        <View style={styles.fill}>{loading ? <Text style={styles.hint}>Loading…</Text> : renderEmpty?.(fill)}</View>
      ) : (
        <FlatList
          ref={listRef}
          style={styles.fill}
          data={data}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            // The projection's parts are ChatPart plus session-only shapes
            // (ask-human); MessageBubble's defensive renderer degrades the
            // extras visibly instead of crashing (parts.tsx).
            <MessageBubble message={item as ThreadMessage} />
          )}
          contentContainerStyle={styles.list}
          keyboardDismissMode="interactive"
          ListFooterComponent={
            thread.busy ? (
              <View style={styles.thinking}>
                <ActivityIndicator size="small" color={theme.colors.run} />
                <Text style={styles.thinkingText}>{agentName} is typing…</Text>
              </View>
            ) : null
          }
        />
      )}
      {thread.error ? <Text style={styles.error}>{thread.error}</Text> : null}
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={8}>
        {readOnly ? (
          note ? <Text style={styles.note}>{note}</Text> : null
        ) : (
          <View style={styles.composer}>
            <TextInput
              ref={inputRef}
              style={styles.input}
              value={draft}
              onChangeText={setDraft}
              placeholder={placeholder}
              placeholderTextColor={theme.colors.mutedForeground}
              multiline
              editable={!thread.busy}
            />
            <Pressable
              hitSlop={8}
              onPress={send}
              disabled={thread.busy || !draft.trim()}
              style={[styles.sendButton, (thread.busy || !draft.trim()) && styles.sendDisabled]}
              accessibilityLabel="Send">
              {thread.busy ? <ActivityIndicator size="small" color={theme.colors.primaryForeground} /> : <Text style={styles.sendGlyph}>↑</Text>}
            </Pressable>
          </View>
        )}
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  list: { paddingVertical: 12, paddingBottom: 16, rowGap: 4 },
  thinking: { flexDirection: "row", alignItems: "center", columnGap: 6, paddingVertical: 6 },
  thinkingText: { color: theme.colors.run, fontSize: 12 },
  hint: { color: theme.colors.mutedForeground, fontSize: 13, textAlign: "center", paddingTop: 48 },
  error: { color: theme.colors.destructive, fontSize: 12, paddingVertical: 4 },
  note: { color: theme.colors.mutedForeground, fontSize: 13, textAlign: "center", paddingVertical: 16, lineHeight: 19 },
  // The web composer: a rounded card-on-glass box with the send button inside it.
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    columnGap: 8,
    marginVertical: 8,
    padding: 6,
    paddingLeft: 14,
    backgroundColor: "rgba(23,23,23,0.7)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.input,
    borderRadius: theme.radius.xxl,
  },
  input: { flex: 1, color: theme.colors.foreground, fontSize: 15, paddingTop: 8, paddingBottom: 8, maxHeight: 120 },
  sendButton: {
    width: 34,
    height: 34,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  sendDisabled: { opacity: 0.35 },
  sendGlyph: { color: theme.colors.primaryForeground, fontSize: 18, fontWeight: "700", marginTop: -1 },
});
