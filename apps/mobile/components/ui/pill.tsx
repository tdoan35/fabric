import { StyleSheet, Text } from "react-native";
import { theme } from "@/lib/theme";

export type PillVariant = "run" | "ok" | "warn" | "replay" | "muted";

const tint: Record<PillVariant, string> = {
  run: theme.colors.run,
  ok: theme.colors.ok,
  warn: theme.colors.warn,
  replay: theme.colors.replay,
  muted: theme.colors.mutedForeground,
};
const soft: Record<PillVariant, string> = {
  run: theme.colors.runSoft,
  ok: theme.colors.okSoft,
  warn: theme.colors.warnSoft,
  replay: theme.colors.replaySoft,
  muted: theme.colors.secondary,
};

/** Compact status label: running/blocked/accepted/stopped, budgets, ownership tags. */
export function Pill({ children, variant = "muted" }: { children: string; variant?: PillVariant }) {
  return <Text style={[styles.pill, { color: tint[variant], backgroundColor: soft[variant] }]}>{children}</Text>;
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: "flex-start",
    fontSize: 12,
    borderRadius: theme.radius.full,
    paddingVertical: 2,
    paddingHorizontal: 8,
    overflow: "hidden",
  },
});
