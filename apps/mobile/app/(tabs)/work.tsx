import { useMemo } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import type { Project, Run, Task } from "@fabric/contracts";

import { EmptyState, ErrorState, Screen } from "@/components/ui";
import { httpApi } from "@/lib/api";
import { theme } from "@/lib/theme";
import { usePoll } from "@/lib/use-poll";
import { latestRunOf } from "@/components/work/format";
import { TaskRow } from "@/components/work/task-row";

interface WorkData {
  projects: Project[] | undefined;
  tasks: Task[];
  runs: Run[];
}

/** Tasks grouped by project, in the order the server lists them. */
function groupByProject(
  tasks: Task[],
  runsById: Map<string, Run>,
): { projectId: string; tasks: Task[]; runsById: Map<string, Run> }[] {
  const groups = new Map<string, Task[]>();
  for (const task of tasks) {
    const bucket = groups.get(task.projectId);
    if (bucket) bucket.push(task);
    else groups.set(task.projectId, [task]);
  }
  return [...groups].map(([projectId, projectTasks]) => ({ projectId, tasks: projectTasks, runsById }));
}

/** Most recent activity first inside a project: a running loop beats a proposal, a proposal beats a
 * finished one. Mirrors the web board's "needs you first, then recent" spirit with the data we have. */
function byActivity(a: Task, b: Task, runsById: Map<string, Run>): number {
  const rank = (t: Task) => {
    const run = latestRunOf(t, runsById);
    if (run?.status === "running" || run?.status === "blocked") return 0;
    return run ? 1 : 2;
  };
  return rank(a) - rank(b) || lastActivity(b, runsById).localeCompare(lastActivity(a, runsById));
}

const lastActivity = (task: Task, runsById: Map<string, Run>): string => {
  const run = latestRunOf(task, runsById);
  return run?.startedAt ?? task.proposal?.at ?? "";
};

export default function WorkTab() {
  const { data, error, loading, refresh } = usePoll<WorkData>(
    () =>
      Promise.all([
        // Names only: a failed /projects fetch degrades to id headers, never blocks the tab.
        httpApi.listProjects().catch(() => undefined),
        httpApi.listTasks(),
        httpApi.listRuns(),
      ]).then(([projects, tasks, runs]) => ({ projects, tasks, runs })),
  );
  const groups = useMemo(() => {
    if (!data) return [];
    const runsById = new Map(data.runs.map((r) => [r.id, r]));
    const sorted = [...data.tasks].sort((a, b) => byActivity(a, b, runsById));
    return groupByProject(sorted, runsById);
  }, [data]);

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} tintColor={theme.colors.run} />}>
        {!data && !error && (
          <View style={styles.loading}>
            <ActivityIndicator color={theme.colors.run} />
          </View>
        )}
        {error && data === undefined && (
          <ErrorState message={error.message} onRetry={refresh} />
        )}
        {data && data.tasks.length === 0 && (
          <EmptyState title="No tasks yet" hint="Delegate something to a team in a thread — it shows up here." />
        )}
        {groups.map((group) => (
          <View key={group.projectId} style={styles.group}>
            <Text style={styles.project}>
              {data?.projects?.find((project) => project.id === group.projectId)?.name ?? group.projectId}
              <Text style={styles.count}> · {group.tasks.length}</Text>
            </Text>
            {group.tasks.map((task) => (
              <TaskRow key={task.id} task={task} runsById={group.runsById} />
            ))}
          </View>
        ))}
        {error && data !== undefined && <ErrorState message={error.message} onRetry={refresh} />}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { paddingVertical: 16, rowGap: 12 },
  loading: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 48 },
  group: { rowGap: 8 },
  project: {
    color: theme.colors.foreground,
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0.2,
    marginBottom: 2,
  },
  count: { color: theme.colors.mutedForeground, fontWeight: "400" },
});
