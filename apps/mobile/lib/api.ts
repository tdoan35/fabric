// Mirrors apps/web/src/lib/api/http.ts: same endpoints, same @fabric/contracts schemas, same
// dev-only validation warnings, and the same "404 → undefined" behaviour for single resources.
// The base URL comes from EXPO_PUBLIC_API_URL (inlined by Metro; see .env.example).
import {
  ProjectSchema, RegistrySchema, ReportSchema, RunSchema, SessionMessagesSchema, TaskSchema, WeaveSnapshotSchema,
  type Project, type Registry, type Report, type Run, type SessionMessages, type Task, type WeaveSnapshot,
} from "@fabric/contracts";
import { z } from "zod";

export const apiBase = (process.env.EXPO_PUBLIC_API_URL || "http://localhost:8787").replace(/\/$/, "");

async function request<T>(path: string, schema: z.ZodType, init?: RequestInit, missing = false): Promise<T> {
  const response = await fetch(`${apiBase}/api${path}`, init);
  if (missing && response.status === 404) return undefined as T;
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  }
  const value: unknown = await response.json();
  if (__DEV__) {
    const checked = schema.safeParse(value);
    if (!checked.success) console.warn(`[api] ${path} contract mismatch`, checked.error.issues);
  }
  return value as T;
}

/** The M0 surface (MOBILE-PLAN §2) plus `getRegistry`/`listProjects`, closing the Requests in
 * docs/status/mobile-weave.md and mobile-work.md. Chat (POST /api/chat) and SSE (/api/stream) arrive with M1. */
export const httpApi = {
  getRegistry: () => request<Registry>("/registry", RegistrySchema),
  getWeave: () => request<WeaveSnapshot>("/weave", WeaveSnapshotSchema),
  listProjects: () => request<Project[]>("/projects", z.array(ProjectSchema)),
  listTasks: () => request<Task[]>("/tasks", z.array(TaskSchema)),
  listRuns: () => request<Run[]>("/runs", z.array(RunSchema)),
  getRun: (id: string) => request<Run | undefined>(`/runs/${encodeURIComponent(id)}`, RunSchema, undefined, true),
  getReport: (id: string) => request<Report | undefined>(`/reports/${encodeURIComponent(id)}`, ReportSchema, undefined, true),
  getSessionMessages: (id: string) => request<SessionMessages>(`/sessions/${encodeURIComponent(id)}/messages`, SessionMessagesSchema),
};
