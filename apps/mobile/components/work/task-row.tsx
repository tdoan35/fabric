import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import type { Run, Task } from "@fabric/contracts";

import { Card, Pill } from "@/components/ui";
import type { PillVariant } from "@/components/ui/pill";
import { theme } from "@/lib/theme";
import { etaAt, latestRunOf, money, reworkUsed, when } from "./format";

/** The web's StatePill tones (apps/web/src/components/work/parts.tsx), mapped onto the Pill variants. */
export const STATUS_VARIANT: Record<Run["status"], PillVariant> = {
  running: "run",
  blocked: "warn",
  accepted: "ok",
  stopped: "muted",
};

const statusLabel: Record<Run["status"], string> = {
  running: "Running",
  blocked: "Blocked",
  accepted: "Accepted",
  stopped: "Stopped",
};

/**
 * One task on the Work list: title, then its latest loop (the last entry of runIds) with the
 * numbers that matter away from the desk — status, spend against budget, rework, ETA. A recorded
 * loop is marked with a small replay pill (DEMO-SCRIPT §4: replay is always badged). The loop row
 * opens the report when one exists; otherwise it says the rest lives on desktop.
 */
export function TaskRow({ task, runsById }: { task: Task; runsById: Map<string, Run> }) {
  const router = useRouter();
  const run = latestRunOf(task, runsById);
  const overBudget = run !== undefined && run.costUsd > run.budget.costUsd;

  const meta: string[] = [];
  if (run) {
    meta.push(`rework ${reworkUsed(run)}/${run.reworkBudget}`);
    const eta = etaAt(run);
    if (eta) meta.push(`ETA ${when(eta)}`);
    if (task.runIds.length > 1) meta.push(`loop ${run.n}`);
  }

  return (
    <Card>
      <View style={styles.head}>
        <Text style={styles.title} numberOfLines={2}>
          {task.title}
        </Text>
        {run && (
          <Text style={styles.started} numberOfLines={1}>
            {when(run.startedAt)}
          </Text>
        )}
      </View>

      {run ? (
        <>
          <View style={styles.pills}>
            <Pill variant={STATUS_VARIANT[run.status]}>{statusLabel[run.status]}</Pill>
            {run.recorded && <Pill variant="replay">replay</Pill>}
            {task.preview && <Pill variant="muted">preview</Pill>}
          </View>
          <Text style={styles.meta} numberOfLines={1}>
            {meta.join(" · ")}
          </Text>
          <Pressable
            disabled={run.reportId === undefined}
            onPress={run.reportId ? () => router.push(`/report/${run.reportId}`) : undefined}
            hitSlop={4}>
            <View style={styles.runRow}>
              <Text style={[styles.cost, overBudget && styles.costOver]} numberOfLines={1}>
                {money(run.costUsd)} <Text style={styles.costBudget}>/ {money(run.budget.costUsd)}</Text>
              </Text>
              <Text style={run.reportId ? styles.openReport : styles.openDesktop} numberOfLines={1}>
                {run.reportId ? "Report ›" : "Open on desktop"}
              </Text>
            </View>
          </Pressable>
        </>
      ) : (
        <>
          <View style={styles.pills}>
            <Pill variant="replay">Proposed</Pill>
          </View>
          {task.proposal && (
            <Text style={styles.proposal} numberOfLines={2}>
              {task.proposal.purpose}
            </Text>
          )}
          <Text style={styles.openDesktop}>Waiting for your yes — decide in Weave or on desktop</Text>
        </>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "flex-start", columnGap: 12 },
  title: { flex: 1, color: theme.colors.foreground, fontSize: 14, fontWeight: "600", lineHeight: 19 },
  started: { color: theme.colors.mutedForeground, fontSize: 12, fontVariant: ["tabular-nums"], paddingTop: 2 },
  pills: { flexDirection: "row", flexWrap: "wrap", columnGap: 6, rowGap: 4 },
  meta: { color: theme.colors.mutedForeground, fontSize: 12, fontVariant: ["tabular-nums"] },
  runRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", columnGap: 12, paddingTop: 2 },
  cost: { color: theme.colors.foreground, fontSize: 13, fontVariant: ["tabular-nums"] },
  costOver: { color: theme.colors.warn },
  costBudget: { color: theme.colors.mutedForeground },
  openReport: { color: theme.colors.run, fontSize: 12, fontWeight: "600" },
  openDesktop: { color: theme.colors.mutedForeground, fontSize: 12 },
  proposal: { color: theme.colors.mutedForeground, fontSize: 12, lineHeight: 17 },
});
