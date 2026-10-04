import { useEffect } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";

import { EmptyState, ErrorState, Screen } from "@/components/ui";
import { httpApi } from "@/lib/api";
import { theme } from "@/lib/theme";
import { usePoll } from "@/lib/use-poll";
import { ItemDetail } from "@/components/weave/item-detail";
import { markRead } from "@/components/weave/store";

/**
 * One Weave item (MOBILE-PLAN §2 M0): the same snapshot as the list, polled while focused, so a
 * fresh "results ready" item is never stale. Opening it clears the unread dot; resolutions made
 * here live in the local store (components/weave/store.ts) and survive polling.
 */
export default function WeaveItemScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, error, refresh } = usePoll(() => httpApi.getWeave(), 3000);
  const item = id ? data?.items.find((entry) => entry.id === id) : undefined;

  useEffect(() => {
    if (item) markRead(item.id);
  }, [item?.id]);

  return (
    <Screen>
      {!data ? (
        error ? (
          <View style={styles.centered}>
            <ErrorState message={error.message} onRetry={refresh} />
          </View>
        ) : (
          <Text style={styles.loading}>Loading…</Text>
        )
      ) : item ? (
        <ScrollView contentContainerStyle={styles.body}>
          <ItemDetail item={item} />
        </ScrollView>
      ) : (
        <EmptyState title="Item not found" hint="It may have been resolved or removed on the desktop." />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 16 },
  centered: { paddingTop: 32, paddingHorizontal: 16 },
  loading: { color: theme.colors.mutedForeground, fontSize: 13, textAlign: "center", paddingTop: 32 },
});
