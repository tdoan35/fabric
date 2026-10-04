// Recent threads: the web sidebar's "Threads" section (registry.sessions without a project).
// A row opens /thread/[id]; rows that link elsewhere on the web (a board) aren't chat threads.
import { useRouter } from "expo-router";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import type { Registry } from "@fabric/contracts";

import { EmptyState, ErrorState, Screen } from "@/components/ui";
import { httpApi } from "@/lib/api";
import { theme } from "@/lib/theme";
import { usePoll } from "@/lib/use-poll";
import { usePeople, personName } from "@/components/weave/people";

export default function ThreadsScreen() {
  const router = useRouter();
  const people = usePeople();
  const { data, error, loading, refresh } = usePoll<Registry>(() => httpApi.getRegistry(), 5000, (e) => e.type === "registry.changed");
  const sessions = (data?.sessions ?? []).filter((s) => !s.projectId && s.href === "/");
  if (error && !data) return <Screen><ErrorState message={error.message} onRetry={refresh} /></Screen>;
  return (
    <Screen>
      <FlatList
        data={sessions}
        keyExtractor={(s) => s.id}
        refreshControl={<RefreshControl refreshing={loading && !!data} onRefresh={refresh} tintColor={theme.colors.run} />}
        ListEmptyComponent={loading ? null : <EmptyState title="No threads yet" hint="Start one from the Chat tab." />}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            onPress={() => router.push({ pathname: "/thread/[id]", params: { id: item.id, title: item.title } })}>
            <View style={[styles.dot, item.status !== "unread" && styles.dotHidden]} />
            <View style={styles.body}>
              <Text style={styles.title} numberOfLines={1}>{item.title}</Text>
              <Text style={styles.meta} numberOfLines={1}>
                {personName(item.agentId, people)} · {item.messages} messages · {item.updated}
              </Text>
            </View>
          </Pressable>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { paddingVertical: 8 },
  row: { flexDirection: "row", alignItems: "center", columnGap: 10, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.border },
  pressed: { opacity: 0.6 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: theme.colors.run },
  dotHidden: { opacity: 0 },
  body: { flex: 1, rowGap: 2 },
  title: { color: theme.colors.foreground, fontSize: 15 },
  meta: { color: theme.colors.mutedForeground, fontSize: 12 },
});
