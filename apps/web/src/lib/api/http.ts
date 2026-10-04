import {
  ChatStreamLineSchema, ContextSnapshotSchema, OccurrenceSchema, ProjectSchema, RegistrySchema, ReportSchema,
  RunEventSchema, RunSchema, ScheduleFireSchema, ScheduleSchema, SessionMessagesSchema, TaskSchema,
  WeaveSnapshotSchema,
  type ChatRequest, type ChatStreamLine, type ContextSnapshot, type FinalizeResponse, type Occurrence,
  type Project, type Registry, type Report, type Run, type RunEvent, type Schedule, type ScheduleFire,
  type ScheduleInput, type SchedulePatch, type SessionMessages, type SpliceResponse, type Task,
  type WeaveSnapshot,
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

/** POST /api/chat (§4.3): one cumulative snapshot of the assistant message per NDJSON line. */
async function* chatStream(body: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatStreamLine> {
  const response = await fetch(`${apiBase}/api/chat`, { ...json(body), signal }).catch((err: unknown) => {
    if (err instanceof Error && err.name === "AbortError") throw err;
    throw new Error("Can't reach the server. Check that it's running, then send again.");
  });
  if (!response.ok || !response.body) {
    const err = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? `Dana is unavailable (${response.status})`);
  }
  const parse = (line: string) => {
    const value: unknown = JSON.parse(line);
    if (dev) {
      const checked = ChatStreamLineSchema.safeParse(value);
      if (!checked.success) console.warn("[api] /chat line contract mismatch", checked.error.issues);
    }
    return value as ChatStreamLine;
  };
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += value;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield parse(line);
    }
    if (done) break;
  }
  if (buffer.trim()) yield parse(buffer.trim());
}
const spliceSchema = z.object({ run: RunSchema, events: z.array(RunEventSchema) });
const finalizeSchema = z.object({ reportId: z.string() });
const okSchema = z.object({ ok: z.boolean() });

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
  // Schedules (SCH): the routines and the occurrences read model.
  listSchedules: () => request<Schedule[]>("/schedules", z.array(ScheduleSchema)),
  createSchedule: (input: ScheduleInput) => request<Schedule>("/schedules", ScheduleSchema, json(input)),
  updateSchedule: (id: string, patch: SchedulePatch) =>
    request<Schedule>(`/schedules/${encodeURIComponent(id)}`, ScheduleSchema, { ...json(patch), method: "PATCH" }),
  deleteSchedule: (id: string) =>
    request<{ ok: boolean }>(`/schedules/${encodeURIComponent(id)}`, okSchema, { method: "DELETE" }),
  runScheduleNow: (id: string) =>
    request<ScheduleFire>(`/schedules/${encodeURIComponent(id)}/run`, ScheduleFireSchema, json({})),
  skipOccurrence: (id: string, at: string) =>
    request<ScheduleFire>(`/schedules/${encodeURIComponent(id)}/skip`, ScheduleFireSchema, json({ at })),
  listOccurrences: (from: string, to: string) =>
    request<Occurrence[]>(`/schedules/occurrences?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, z.array(OccurrenceSchema)),
  // Chat (UI-CHAT): Dana's thread. Http mode only; mock mode streams the scripted adapter instead.
  chat: chatStream,
  getSessionMessages: (id: string) => request<SessionMessages>(`/sessions/${encodeURIComponent(id)}/messages`, SessionMessagesSchema),
};
