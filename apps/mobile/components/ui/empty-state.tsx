import { StyleSheet, Text, View } from "react-native";
import { theme } from "@/lib/theme";

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <View style={styles.box}>
      <Text style={styles.title}>{title}</Text>
      {hint && <Text style={styles.hint}>{hint}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, rowGap: 6 },
  title: { color: theme.colors.foreground, fontSize: 17, fontWeight: "600" },
  hint: { color: theme.colors.mutedForeground, fontSize: 13, textAlign: "center" },
});
