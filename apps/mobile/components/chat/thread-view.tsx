// One chat thread over the real server (MOBILE-PLAN §2 M1), shared by the Chat tab's new thread
// and /thread/[id]. History loads from GET /api/sessions/:id/messages (skipped for a freshly
// minted id); sending POSTs /api/chat and replaces the in-progress assistant message on every
// NDJSON line — each line is a CUMULATIVE snapshot (§4.3), never an append. Approvals stay on the
// desktop: cards render read-only (components/chat/parts.tsx).
// Web counterpart: components/chat/assistant-thread.tsx + lib/chat/http-assistant.ts.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { fetch as expoFetch } from "expo/fetch";
import type { ThreadMessage } from "@fabric/contracts";

import { MessageBubble } from "@/components/chat/parts";
import { httpApi } from "@/lib/api";
import { chatStream, toWire } from "@/lib/chat";
import { theme } from "@/lib/theme";
import { useAppEvents } from "@/lib/app-stream";

const now = () => new Date().toISOString();

export function ThreadView({ sessionId, fresh, placeholder, agentName = "Dana", disabledNote, renderEmpty, onStarted }: {
  sessionId: string;
  /** Minted on this device and never sent: no history to fetch. */
  fresh?: boolean;
  placeholder: string;
  agentName?: string;
  /** Set when this agent can't be messaged from the phone; replaces the composer. */
  disabledNote?: string;
  /** The empty-thread body; `fill` puts a prompt in the composer. */
  renderEmpty?: (fill: (text: string) => void) => ReactNode;
  onStarted?: () => void;
}) {
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [streaming, setStreaming] = useState<ThreadMessage | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(!fresh);
  const sentRef = useRef(!fresh);
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const listRef = useRef<FlatList<ThreadMessage>>(null);
  const inputRef = useRef<TextInput>(null);

  const load = useCallback(async () => {
    if (!sentRef.current) return;
    try {
      const history = await httpApi.getSessionMessages(sessionId);
      setMessages(history.messages);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
    return () => {
      abortRef.current?.abort(); // leaving the thread mid-turn cancels the request
    };
  }, [load]);

  // Live while idle: the results message (CHAT-14) and decisions made on the desktop both change
  // this thread's history — `session.message` for it, or `registry.changed`. Never mid-own-turn.
  useAppEvents(
    (e) => e.type === "registry.changed" || (e.type === "session.message" && e.sessionId === sessionId),
    () => {
      if (!busyRef.current) void load();
    },
  );

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || busyRef.current) return;
    const user: ThreadMessage = { id: `local-${Date.now()}`, role: "user", content: [{ type: "text", text }], createdAt: now() };
    const wire = toWire([...messages, user]);
    setMessages((prev) => [...prev, user]);
    setDraft("");
    setError(undefined);
    setBusy(true);
    busyRef.current = true;
    sentRef.current = true;
    onStarted?.();
    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming({ id: "streaming", role: "assistant", content: [], createdAt: now() });
    try {
      let any = false;
      for await (const line of chatStream(expoFetch, { sessionId, messages: wire }, controller.signal)) {
        any = true;
        setStreaming({ id: "streaming", role: "assistant", content: line.content, createdAt: now() });
      }
      if (!any) throw new Error(`${agentName} didn't answer. Send it again.`);
      // The stored thread is authoritative (real ids, decisions stamped by the desktop): reload it.
      await load();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStreaming(undefined);
      setBusy(false);
      busyRef.current = false;
    }
  }, [draft, messages, load, sessionId, agentName, onStarted]);

  const fill = useCallback((text: string) => {
    setDraft(text);
    inputRef.current?.focus();
  }, []);

  const data = streaming ? [...messages, streaming] : messages;
  const empty = data.length === 0;

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
          renderItem={({ item }) => <MessageBubble message={item} />}
          contentContainerStyle={styles.list}
          keyboardDismissMode="interactive"
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          ListFooterComponent={
            busy ? (
              <View style={styles.thinking}>
                <ActivityIndicator size="small" color={theme.colors.run} />
                <Text style={styles.thinkingText}>{agentName} is typing…</Text>
              </View>
            ) : null
          }
        />
      )}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={8}>
        {disabledNote ? (
          <Text style={styles.note}>{disabledNote}</Text>
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
              editable={!busy}
            />
            <Pressable
              hitSlop={8}
              onPress={() => void send()}
              disabled={busy || !draft.trim()}
              style={[styles.sendButton, (busy || !draft.trim()) && styles.sendDisabled]}
              accessibilityLabel="Send">
              {busy ? <ActivityIndicator size="small" color={theme.colors.primaryForeground} /> : <Text style={styles.sendGlyph}>↑</Text>}
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
