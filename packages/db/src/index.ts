// @fabric/db — DATA owns this package: Drizzle schema, migrations, seed profiles and the RunWriter.
import type { Brief, ContextSnapshot, Run, RunEvent, RunEventPayloads, RunEventType, RunStatus, Task } from "@fabric/contracts";
import { createDb } from "./db";
import type { Db } from "./db";
import { createRunWriterWith } from "./writer";
/** The only way anything writes to a run (WORK-PLAN §4.6). Stamps seq and t; validates payloads. */
export interface RunWriter {
  createTask(i: { projectId: string; teamId: string; title: string; sessionId?: string; recordingKey?: string }): Promise<Task>;
  /**
   * Dana's own base context (P1-3), from CTX's measureAssistantContext. When given it is stored in
   * runs.assistant_tokens instead of brief.tokens. Additive option.
   */
  startRun(taskId: string, brief: Brief, budget: { costUsd: number; timeS: number; rework: number }, opts?: { assistantTokens?: number }): Promise<Run>;
  emit<T extends RunEventType>(runId: string, type: T, actor: string | undefined, payload: RunEventPayloads[T]): Promise<RunEvent>;
  /** Also emits context.snapshot. Call it before the model call that uses the context. */
  saveSnapshot(s: Omit<ContextSnapshot, "id">): Promise<ContextSnapshot>;
  saveArtifact(runId: string, a: { name: string; by: string; content: Uint8Array | string }): Promise<{ id: string }>;
  end(runId: string, status: Exclude<RunStatus, "running">, outcome?: string): Promise<void>;
}

/** The server wires these: onEvent feeds the SSE hub, onEnd runs finalizeRun. Packages never import apps/server. */
export interface RunWriterHooks {
  onEvent?: (e: RunEvent) => void;
  onEnd?: (runId: string, status: Exclude<RunStatus, "running">) => void | Promise<void>;
}

/** Spec entry point (§4.6): builds its own pool from DATABASE_URL. The server uses createRunWriterWith. */
export function createRunWriter(hooks: RunWriterHooks = {}): RunWriter {
  return createRunWriterWith(createDb(), hooks);
}

export { createDb, loadRootEnv } from "./db";
export type { Db } from "./db";
export { sql } from "drizzle-orm";
export { createRunWriterWith, emitAt, slugId, rowToRun } from "./writer";
export { deriveSegments } from "./derive";
export { openStepsAt, spliceEvents } from "./splice";
export { importRecording, exportRecording } from "./recordings";
export { provisionTeam } from "./provision";
export type { ProvisionTeamInput, ProvisionTeamResult } from "./provision";
export { RunClosedError } from "./errors";
export {
  getRunRow, latestRecordingRun, listProjects, listRuns, listSnapshots, listStoredEvents, listTasks,
  mergedEvents, readArtifact, readRegistry, readReport, readRun, readTask, readWeave,
} from "./read";
export { decideMemory, listMemories, searchMemories, upsertMemories } from "./memory";
export type { MemoryHit, MemoryList, MemorySearch, MemoryUpsert } from "./memory";
export type { RunRowLike } from "./read";
export * as schema from "./schema";
export type { AgentToolRow } from "./schema";
