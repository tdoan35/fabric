import { Pressable, StyleSheet, Text, View } from "react-native";
import { theme } from "@/lib/theme";

/** Inline failure state with a retry — used under list content, not instead of it. */
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <View style={styles.box}>
      <Text style={styles.message}>Couldn&apos;t load — {message}</Text>
      {onRetry && (
        <Pressable hitSlop={8} onPress={onRetry}>
          <Text style={styles.retry}>Try again</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    backgroundColor: theme.colors.card,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    padding: 14,
    rowGap: 8,
  },
  message: { color: theme.colors.destructive, fontSize: 13 },
  retry: { color: theme.colors.run, fontSize: 13, fontWeight: "600" },
});
