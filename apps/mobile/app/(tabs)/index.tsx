// The landing screen: a new thread, the web's `/` (routes/home.tsx + assistant-thread.tsx ThreadBody).
// Empty state = agent hero (portrait + name pill, chevrons cycle Dana · Jonah · Megan · Carlos), the
// agent's greeting, suggestion chips that fill the composer. The first send turns it into the thread.
// "New thread" in the header mints a fresh session id, like the web's bare `/`.
import { useMemo, useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Tabs, useRouter } from "expo-router";
import type { ChatAgent, Registry, Suggestion } from "@fabric/contracts";

import { ThreadView } from "@/components/chat/thread-view";
import { Screen } from "@/components/ui";
import { httpApi } from "@/lib/api";
import { avatar } from "@/lib/avatar";
import { newSessionId } from "@/lib/chat";
import { theme } from "@/lib/theme";
import { usePoll } from "@/lib/use-poll";

/** The web's chatAgents() order (apps/web/src/lib/registry.ts). */
const CHAT_AGENT_IDS = ["dana", "jonah", "megan", "carlos"];

/** First three of the fixtures' suggestionPool (the demo path), for agents without their own chips. */
const DEFAULT_SUGGESTIONS: Suggestion[] = [
  { label: "What's an n-gram, in one line?", prompt: "What's an n-gram, in one line?" },
  {
    label: "Test my n-gram / Engram idea",
    prompt:
      "I want to test an idea: graft an n-gram / Engram lookup table onto a much smaller open model to boost its capability. The table could live on NAND instead of RAM.",
  },
  { label: "Recap my memory grafting work", prompt: "Summarize where I left off on memory grafting and what's still open." },
];

/** Used until the registry answers (and if it can't), so the screen never waits on the network. */
const DANA_FALLBACK = { id: "dana", name: "Dana", role: "Executive assistant", greeting: "What's on your plate?", placeholder: "Tell Dana what you need…" } as ChatAgent;

export default function NewThreadTab() {
  const router = useRouter();
  const { data: registry } = usePoll<Registry>(() => httpApi.getRegistry(), 30000, (e) => e.type === "registry.changed");
  const agents = useMemo(() => {
    const found = CHAT_AGENT_IDS.map((id) => registry?.agents.find((p) => p.agent.id === id)?.agent).filter((a): a is ChatAgent => !!a);
    return found.length ? found : [DANA_FALLBACK];
  }, [registry]);
  const [index, setIndex] = useState(0);
  const [sessionId, setSessionId] = useState(newSessionId);
  const [started, setStarted] = useState(false);
  const agent = agents[index % agents.length];
  // Phase 1 serves Dana only on the server (web http-assistant.ts keeps others on a mock).
  const live = agent.id === "dana";

  return (
    <Screen>
      <Tabs.Screen
        options={{
          headerRight: () => (
            <View style={styles.headerActions}>
              <Pressable hitSlop={12} onPress={() => router.push("/threads")} accessibilityLabel="Threads">
                <Text style={styles.headerText}>☰</Text>
              </Pressable>
              <Pressable
                hitSlop={12}
                disabled={!started}
                accessibilityLabel="New thread"
                onPress={() => {
                  setSessionId(newSessionId());
                  setStarted(false);
                  setIndex(0);
                }}>
                <Text style={[styles.headerText, !started && styles.headerDisabled]}>✎</Text>
              </Pressable>
            </View>
          ),
        }}
      />
      <ThreadView
        key={sessionId}
        sessionId={sessionId}
        fresh
        agentName={agent.name}
        placeholder={agent.placeholder}
        disabledNote={live ? undefined : `Chatting with ${agent.name} from the phone is coming. Dana's live here; brief ${agent.name} on the desktop for now.`}
        onStarted={() => setStarted(true)}
        renderEmpty={(fill) => (
          <ScrollView contentContainerStyle={styles.empty} keyboardShouldPersistTaps="handled">
            <View style={styles.hero}>
              {agents.length > 1 ? (
                <Pressable hitSlop={12} style={styles.chevron} onPress={() => setIndex((i) => (i - 1 + agents.length) % agents.length)} accessibilityLabel="Previous agent">
                  <Text style={styles.chevronText}>‹</Text>
                </Pressable>
              ) : null}
              <View style={styles.portraitWrap}>
                {avatar(agent.id) ? (
                  <Image source={avatar(agent.id)} style={styles.portrait} />
                ) : (
                  <View style={[styles.portrait, styles.initial]}>
                    <Text style={styles.initialText}>{agent.name[0]}</Text>
                  </View>
                )}
                <View style={styles.namePill}>
                  <Text style={styles.nameText}>{agent.name}</Text>
                  <Text style={styles.roleText}>{agent.role}</Text>
                </View>
              </View>
              {agents.length > 1 ? (
                <Pressable hitSlop={12} style={styles.chevron} onPress={() => setIndex((i) => (i + 1) % agents.length)} accessibilityLabel="Next agent">
                  <Text style={styles.chevronText}>›</Text>
                </Pressable>
              ) : null}
            </View>
            <Text style={styles.heading}>{agent.greeting}</Text>
            {live ? (
              <View style={styles.chips}>
                {(agent.suggestions?.length ? agent.suggestions : DEFAULT_SUGGESTIONS).slice(0, 3).map((s) => (
                  <Pressable key={s.label} style={styles.chip} onPress={() => fill(s.prompt)}>
                    <Text style={styles.chipText} numberOfLines={1}>{s.label}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </ScrollView>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  empty: { flexGrow: 1, alignItems: "center", justifyContent: "center", paddingVertical: 24 },
  hero: { flexDirection: "row", alignItems: "center", columnGap: 16, marginBottom: 20 },
  chevron: {
    width: 36,
    height: 36,
    borderRadius: theme.radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.input,
    backgroundColor: "rgba(23,23,23,0.7)",
    alignItems: "center",
    justifyContent: "center",
  },
  chevronText: { color: theme.colors.foreground, fontSize: 22, marginTop: -2 },
  portraitWrap: { alignItems: "center" },
  // The web's portrait: size-28 circle, 3px foreground/30 ring, bg-ok-soft behind the art.
  portrait: { width: 112, height: 112, borderRadius: 56, borderWidth: 3, borderColor: "rgba(250,250,250,0.3)", backgroundColor: theme.colors.okSoft },
  initial: { alignItems: "center", justifyContent: "center" },
  initialText: { color: theme.colors.ok, fontSize: 40, fontWeight: "600" },
  namePill: {
    marginTop: -10,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.input,
    alignItems: "center",
  },
  nameText: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" },
  roleText: { color: theme.colors.mutedForeground, fontSize: 11 },
  heading: { color: theme.colors.foreground, fontSize: 24, fontWeight: "600", letterSpacing: -0.4, textAlign: "center", marginBottom: 20 },
  chips: { alignSelf: "stretch", rowGap: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: theme.radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.input,
    backgroundColor: "rgba(23,23,23,0.55)",
  },
  chipText: { color: theme.colors.foreground, fontSize: 14 },
  headerActions: { flexDirection: "row", alignItems: "center", columnGap: 20, marginRight: 16 },
  headerText: { color: theme.colors.foreground, fontSize: 17 },
  headerDisabled: { opacity: 0.35 },
});
