import { StyleSheet, Text, View } from "react-native";
import type { Report } from "@fabric/contracts";

import { theme } from "@/lib/theme";

/**
 * The report's results as a compact table (the web's "Held-out perplexity" table, one row per
 * configuration). Validity is never colour alone: the cell reads `valid` or `contaminated`.
 */
export function ResultTable({ results }: { results: Report["results"] }) {
  return (
    <View style={styles.table}>
      <View style={styles.headRow}>
        <Text style={[styles.head, styles.config]}>Configuration</Text>
        <Text style={[styles.head, styles.num]}>PPL</Text>
        <Text style={[styles.head, styles.num]}>Δ</Text>
        <Text style={[styles.head, styles.valid]}>Valid</Text>
      </View>
      {results.map((r) => (
        <View key={r.config} style={styles.row}>
          <Text style={styles.config} numberOfLines={1}>
            {r.config}
          </Text>
          <Text style={styles.num}>{r.ppl}</Text>
          <Text style={styles.num}>{r.delta}</Text>
          <View style={styles.valid}>
            <Text style={[styles.validText, { color: r.valid ? theme.colors.ok : theme.colors.warn }]}>
              {r.valid ? "valid" : "contaminated"}
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  table: {
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  headRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.colors.secondary,
    paddingVertical: 7,
    paddingHorizontal: 10,
    columnGap: 8,
  },
  head: { color: theme.colors.mutedForeground, fontSize: 11, fontWeight: "600" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    paddingHorizontal: 10,
    columnGap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
  },
  config: { flex: 1, color: theme.colors.foreground, fontSize: 12.5, fontWeight: "500" },
  num: { color: theme.colors.foreground, fontSize: 12.5, fontVariant: ["tabular-nums"], width: 52, textAlign: "right" },
  valid: { width: 84, alignItems: "flex-end" },
  validText: { fontSize: 11, fontWeight: "600" },
});
