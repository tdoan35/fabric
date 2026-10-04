// Offline seam. The 135M log, snapshots and report use the same current bundle as the server.
import { recordings } from "@fabric/fixtures/recordings";
import { myProfiles, communityProfiles } from "@fabric/fixtures/studio";
import { studioTeams, communityTeams, organizations } from "@fabric/fixtures/teams";
import { sessions } from "@fabric/fixtures/sessions";
import { inboxSeed, pulseSeed, presenceSeed, calendarEvents } from "@fabric/fixtures/weave";
import { projects, type Project } from "../mock/sessions";
import { allSnapshots, runEventsById, runs, tasks } from "../mock/work";
import type { ContextSnapshot, Report, Run, RunEvent, Task } from "../types";
import type { Registry, WeaveSnapshot } from "@fabric/contracts";

const delay = <T,>(v: T, ms = 120) => new Promise<T>((r) => setTimeout(() => r(v), ms));
const bundle = recordings["ngram-135m"];
const recordingId = bundle.run.idHint;
const recordingEvents: RunEvent[] = bundle.events.map(({ seqHint, ...event }) => ({ ...event, seq: seqHint, runId: recordingId }));
const recordingSnapshots: ContextSnapshot[] = bundle.snapshots.map(({ idHint, ...snapshot }) => ({ ...snapshot, id: idHint, runId: recordingId }));
const recordingReport: Report = { ...bundle.report, id: bundle.report.idHint, runId: recordingId };
const bundledRuns = runs.map((r) => r.id === recordingId ? {
  ...r, ...bundle.run, id: recordingId, taskId: r.taskId, teamId: r.teamId, n: r.n,
  recorded: r.recorded, segments: r.segments, brief: bundle.run.brief, reportId: recordingReport.id,
} : r);

const registry: Registry = { agents: myProfiles, communityAgents: communityProfiles, teams: studioTeams, communityTeams, organizations, projects, sessions, personaPool: [] };
const weaveSnapshot: WeaveSnapshot = { items: inboxSeed, pulse: pulseSeed, presence: presenceSeed, calendar: calendarEvents };
export const mockApi = {
  getRegistry: (): Promise<Registry> => delay(registry),
  getWeave: (): Promise<WeaveSnapshot> => delay(weaveSnapshot),
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
  listRuns: (): Promise<Run[]> => delay(bundledRuns),
  getTask: (id: string): Promise<Task | undefined> => delay(tasks.find((t) => t.id === id)),
  getRun: (id: string): Promise<Run | undefined> => delay(bundledRuns.find((r) => r.id === id)),
  /** Full ordered event log for a loop. Live mode would tail this over SSE. */
  getRunEvents: (id: string): Promise<RunEvent[]> => delay(id === recordingId ? recordingEvents : runEventsById[id] ?? []),
  getSnapshots: (runId: string): Promise<ContextSnapshot[]> =>
    delay(runId === recordingId ? recordingSnapshots : allSnapshots.filter((s) => s.runId === runId)),
  getReport: (id: string): Promise<Report | undefined> => delay(id === recordingReport.id ? recordingReport : undefined),
  /** No-op offline: mock memory decisions stay client-side (the mock pulse rows have no memoryId). */
  decideMemory: (): Promise<{ ok: true }> => delay({ ok: true }),
};
