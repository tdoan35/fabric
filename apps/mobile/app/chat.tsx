// Chat with Dana (MOBILE-PLAN §2 M1): a minimal thread on the demo session `c1`. History loads
// from GET /api/sessions/:id/messages; sending POSTs /api/chat and replaces the in-progress
// assistant message on every NDJSON line — each line is a CUMULATIVE snapshot (§4.3), never an
// append. Approvals stay on the desktop: cards render read-only (components/chat/parts.tsx).
// Web counterpart: components/chat/assistant-thread.tsx + lib/chat/http-assistant.ts.
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Stack } from "expo-router";
import { fetch as expoFetch } from "expo/fetch";
import type { ThreadMessage } from "@fabric/contracts";

import { Screen } from "@/components/ui";
import { MessageBubble } from "@/components/chat/parts";
import { httpApi } from "@/lib/api";
import { chatStream, DEMO_SESSION_ID, toWire } from "@/lib/chat";
import { theme } from "@/lib/theme";
import { useAppEvents } from "@/lib/app-stream";

const now = () => new Date().toISOString();

export default function ChatScreen() {
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [streaming, setStreaming] = useState<ThreadMessage | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const listRef = useRef<FlatList<ThreadMessage>>(null);

  const load = useCallback(async () => {
    try {
      const history = await httpApi.getSessionMessages(DEMO_SESSION_ID);
      setMessages(history.messages);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      abortRef.current?.abort(); // leaving the screen mid-turn cancels the request
    };
  }, [load]);

  // Live while idle: the results message (CHAT-14) and decisions made on the desktop both change
  // this thread's history — `session.message` for it, or `registry.changed` (chat turns publish it
  // at session creation and at every turn end, assistant/index.ts). Never mid-own-turn.
  useAppEvents(
    (e) => e.type === "registry.changed" || (e.type === "session.message" && e.sessionId === DEMO_SESSION_ID),
    () => {
      if (!busyRef.current) void load();
    },
  );

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || busyRef.current) return;
    const user: ThreadMessage = {
      id: `local-${Date.now()}`,
      role: "user",
      content: [{ type: "text", text }],
      createdAt: now(),
    };
    const wire = toWire([...messages, user]);
    setMessages((prev) => [...prev, user]);
    setDraft("");
    setError(undefined);
    setBusy(true);
    busyRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming({ id: "streaming", role: "assistant", content: [], createdAt: now() });
    try {
      let any = false;
      for await (const line of chatStream(expoFetch, { sessionId: DEMO_SESSION_ID, messages: wire }, controller.signal)) {
        any = true;
        setStreaming({ id: "streaming", role: "assistant", content: line.content, createdAt: now() });
      }
      if (!any) throw new Error("Dana didn't answer. Send it again.");
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
  }, [draft, messages, load]);

  const data = streaming ? [...messages, streaming] : messages;

  return (
    <Screen>
      <Stack.Screen options={{ title: "Dana" }} />
      <View style={styles.sessionRow}>
        <Text style={styles.session} numberOfLines={1}>
          Demo thread · {DEMO_SESSION_ID}
        </Text>
        {busy ? (
          <View style={styles.thinking}>
            <ActivityIndicator size="small" color={theme.colors.run} />
            <Text style={styles.thinkingText}>Dana is typing…</Text>
          </View>
        ) : null}
      </View>
      <FlatList
        ref={listRef}
        data={data}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <MessageBubble message={item} />}
        contentContainerStyle={styles.list}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        ListEmptyComponent={
          loading ? (
            <Text style={styles.hint}>Loading…</Text>
          ) : (
            <Text style={styles.hint}>Ask Dana anything — she can answer directly or propose a team.</Text>
          )
        }
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={8}>
        <View style={styles.composer}>
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder="Message Dana…"
            placeholderTextColor={theme.colors.mutedForeground}
            multiline
            editable={!busy}
          />
          <Pressable hitSlop={8} onPress={() => void send()} disabled={busy || !draft.trim()} style={styles.sendWrap}>
            {busy ? (
              <ActivityIndicator size="small" color={theme.colors.mutedForeground} />
            ) : (
              <Text style={[styles.send, !draft.trim() && styles.sendDisabled]}>Send</Text>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  sessionRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 6 },
  session: { color: theme.colors.mutedForeground, fontSize: 12 },
  thinking: { flexDirection: "row", alignItems: "center", columnGap: 6 },
  thinkingText: { color: theme.colors.run, fontSize: 12 },
  list: { paddingVertical: 8, paddingBottom: 16, rowGap: 4 },
  hint: { color: theme.colors.mutedForeground, fontSize: 13, textAlign: "center", paddingTop: 48, lineHeight: 19 },
  error: { color: theme.colors.destructive, fontSize: 12, paddingVertical: 4 },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    columnGap: 8,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
  },
  input: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: 15,
    backgroundColor: theme.colors.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.xl,
    paddingHorizontal: 12,
    paddingTop: 9,
    paddingBottom: 9,
    maxHeight: 120,
  },
  sendWrap: { padding: 8 },
  send: { color: theme.colors.run, fontSize: 15, fontWeight: "600" },
  sendDisabled: { color: theme.colors.mutedForeground, opacity: 0.5 },
});
