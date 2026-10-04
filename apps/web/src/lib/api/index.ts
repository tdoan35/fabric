// Mock implementations of the backend seam. Swap these for real fetch/SSE
// calls (Mastra server + Neon) at integration time; callers don't change.
import { report } from "../mock/run";
import { projects, type Project } from "../mock/sessions";
import { allSnapshots, runEventsById, runs, tasks } from "../mock/work";
import type { ContextSnapshot, Report, Run, RunEvent, Task } from "../types";

const delay = <T,>(v: T, ms = 120) => new Promise<T>((r) => setTimeout(() => r(v), ms));

export const api = {
  listProjects: (): Promise<Project[]> => delay(projects),
  createProject: ({ name, goal }: { name: string; goal: string }): Promise<Project> => {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
    const id = projects.some((p) => p.id === base) ? `${base}-${projects.length + 1}` : base;
    const project = { id, name, goal };
    projects.push(project);
    return delay(project);
  },
  /** Every task (board card), with its loops' ids. */
  listTasks: (): Promise<Task[]> => delay(tasks),
  /** Every loop of every task. */
  listRuns: (): Promise<Run[]> => delay(runs),
  getTask: (id: string): Promise<Task | undefined> => delay(tasks.find((t) => t.id === id)),
  getRun: (id: string): Promise<Run | undefined> => delay(runs.find((r) => r.id === id)),
  /** Full ordered event log for a loop. Live mode would tail this over SSE. */
  getRunEvents: (id: string): Promise<RunEvent[]> => delay(runEventsById[id] ?? []),
  getSnapshots: (runId: string): Promise<ContextSnapshot[]> =>
    delay(allSnapshots.filter((s) => s.runId === runId)),
  getReport: (id: string): Promise<Report | undefined> => delay(id === report.id ? report : undefined),
};
export type Api = typeof api;
