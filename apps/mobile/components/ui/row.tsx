import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { theme } from "@/lib/theme";

/** A label/value line: muted label left, content right. Content may be any ReactNode. */
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
      <View style={styles.value}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", columnGap: 16 },
  label: { color: theme.colors.mutedForeground, fontSize: 13 },
  value: { flexShrink: 1, flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end" },
});
