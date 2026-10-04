import { useMemo } from "react";
import { RefreshControl, SectionList, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";

import { EmptyState, ErrorState, Screen } from "@/components/ui";
import { httpApi } from "@/lib/api";
import { theme } from "@/lib/theme";
import { usePoll } from "@/lib/use-poll";
import { groupByKind, KIND_META } from "@/components/weave/group";
import { InboxRow } from "@/components/weave/inbox-row";
import { usePeople } from "@/components/weave/people";
import { useWeaveLocal } from "@/components/weave/store";

/**
 * Weave list (MOBILE-PLAN §2 M0): items grouped by kind, each row with the unread dot, the
 * agent, the title, the blocking cost-of-delay line and the time. 3 s focus poll plus
 * pull-to-refresh; tap opens the detail. Web counterpart: components/weave/inbox.tsx.
 */
export default function WeaveTab() {
  const { data, error, loading, refresh } = usePoll(() => httpApi.getWeave(), 3000);
  const local = useWeaveLocal();
  const people = usePeople();
  const router = useRouter();
  const sections = useMemo(() => groupByKind(data?.items ?? []), [data]);

  return (
    <Screen>
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <InboxRow
            item={item}
            resolution={local.resolved[item.id]}
            read={!!local.read[item.id]}
            people={people}
            onPress={() => router.push(`/weave/${item.id}`)}
          />
        )}
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>{KIND_META[section.kind].label}</Text>
            <Text style={styles.sectionCount}>{section.data.length}</Text>
          </View>
        )}
        ItemSeparatorComponent={Separator}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={refresh} tintColor={theme.colors.mutedForeground} />
        }
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          error && !data ? (
            <View style={styles.centered}>
              <ErrorState message={error.message} onRetry={refresh} />
            </View>
          ) : data ? (
            <EmptyState
              title="Nothing is waiting on you"
              hint="Your agents will ask here when something does."
            />
          ) : (
            <Text style={styles.loading}>Loading…</Text>
          )
        }
      />
    </Screen>
  );
}

function Separator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
  list: { paddingBottom: 24 },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    columnGap: 6,
    paddingTop: 18,
    paddingBottom: 4,
  },
  sectionTitle: { color: theme.colors.mutedForeground, fontSize: 12, fontWeight: "600" },
  sectionCount: { color: theme.colors.mutedForeground, fontSize: 12, fontVariant: ["tabular-nums"] },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.border,
    marginLeft: 8,
  },
  centered: { paddingTop: 32 },
  loading: { color: theme.colors.mutedForeground, fontSize: 13, textAlign: "center", paddingTop: 32 },
});
