import {
  ContextSnapshotSchema, ProjectSchema, RegistrySchema, ReportSchema,
  RunEventSchema, RunSchema, TaskSchema, WeaveSnapshotSchema,
  type ContextSnapshot, type FinalizeResponse, type Project, type Registry, type Report, type Run, type RunEvent, type SpliceResponse, type Task, type WeaveSnapshot,
} from "@fabric/contracts";
import { z } from "zod";

export const apiBase = (import.meta.env.VITE_API_URL || "http://localhost:8787").replace(/\/$/, "");
const dev = import.meta.env.DEV;

async function request<T>(path: string, schema: z.ZodType, init?: RequestInit, missing = false): Promise<T> {
  const response = await fetch(`${apiBase}/api${path}`, init);
  if (missing && response.status === 404) return undefined as T;
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  }
  const value: unknown = await response.json();
  if (dev) {
    const checked = schema.safeParse(value);
    if (!checked.success) console.warn(`[api] ${path} contract mismatch`, checked.error.issues);
  }
  return value as T;
}

const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const spliceSchema = z.object({ run: RunSchema, events: z.array(RunEventSchema) });
const finalizeSchema = z.object({ reportId: z.string() });

export const httpApi = {
  getRegistry: () => request<Registry>("/registry", RegistrySchema),
  getWeave: () => request<WeaveSnapshot>("/weave", WeaveSnapshotSchema),
  listProjects: () => request<Project[]>("/projects", z.array(ProjectSchema)),
  createProject: (input: { name: string; goal: string }) => request<Project>("/projects", ProjectSchema, json(input)),
  listTasks: () => request<Task[]>("/tasks", z.array(TaskSchema)),
  listRuns: () => request<Run[]>("/runs", z.array(RunSchema)),
  getTask: (id: string) => request<Task | undefined>(`/tasks/${encodeURIComponent(id)}`, TaskSchema, undefined, true),
  getRun: (id: string) => request<Run | undefined>(`/runs/${encodeURIComponent(id)}`, RunSchema, undefined, true),
  getRunEvents: (id: string) => request<RunEvent[]>(`/runs/${encodeURIComponent(id)}/events`, z.array(RunEventSchema)),
  getSnapshots: (id: string) => request<ContextSnapshot[]>(`/runs/${encodeURIComponent(id)}/snapshots`, z.array(ContextSnapshotSchema)),
  getReport: (id: string) => request<Report | undefined>(`/reports/${encodeURIComponent(id)}`, ReportSchema, undefined, true),
  spliceRun: (id: string, t: number) => request<SpliceResponse>(`/runs/${encodeURIComponent(id)}/splice`, spliceSchema, json({ t })),
  finalizeSplice: (id: string) => request<FinalizeResponse>(`/runs/${encodeURIComponent(id)}/finalize-splice`, finalizeSchema, json({})),
};
