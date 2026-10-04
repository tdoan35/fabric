import { randomUUID } from "node:crypto";
import { sql } from "@fabric/db";
import { z } from "zod";
import { countTokens } from "../context";
import { replayBrowserTask } from "./errand-replay";
import { runCostUsd, runUsages } from "../llm";
import type { Db, RunWriter } from "@fabric/db";
import type { AppEvent, Brief, ContextSnapshot } from "@fabric/contracts";
import { runBrowserTask, resumeBrowserTask, cancelBrowserTask, browserTaskResultSchema } from "@fabric/integrations";
import type { BrowserDeps, BrowserTaskInput, BrowserTaskResult } from "@fabric/integrations";

export interface SessionDesktop {
  url: string | null;
  runId: string | null;
  screenshotArtifactId: string | null;
  replay: boolean;
}
export const idleDesktop = (): SessionDesktop => ({ url: null, runId: null, screenshotArtifactId: null, replay: false });

export type ErrandResult = Omit<BrowserTaskResult, "pendingAction"> & { runId: string };
interface ErrandMetadata {
  kind: "errand";
  sessionId: string;
  operationKey: string;
  desktop?: SessionDesktop;
  result?: ErrandResult;
  pendingAction?: BrowserTaskResult["pendingAction"];
  approvalCallId?: string;
  approvalClaimed?: boolean;
}
const desktopSchema = z.object({ url: z.string().nullable(), runId: z.string().nullable(), screenshotArtifactId: z.string().nullable(), replay: z.boolean() });
const errandResultSchema = browserTaskResultSchema.omit({ pendingAction: true }).extend({ runId: z.string().min(1) });
const metadataSchema = z.object({
  kind: z.literal("errand"), sessionId: z.string(), operationKey: z.string(),
  desktop: desktopSchema.optional(), result: errandResultSchema.optional(),
  pendingAction: z.object({ token: z.string().min(1) }).optional(), approvalCallId: z.string().optional(), approvalClaimed: z.boolean().optional(),
});
const desktopRowSchema = z.object({ desktop: desktopSchema.nullish() }).optional();
const metadataRowSchema = z.object({ budget: metadataSchema }).optional();
const priorRunSchema = z.object({ id: z.string(), result: errandResultSchema.nullish() }).optional();
const projectRowSchema = z.object({ id: z.string() }).optional();
const claimRowSchema = z.object({ id: z.string(), budget: metadataSchema }).optional();
const elapsedRowSchema = z.object({ t: z.coerce.number() });
type BrowserConfig = Omit<BrowserDeps, "writer" | "runId" | "actor" | "step" | "onDesktop">;
interface ErrandDeps {
  db: Db;
  writer: RunWriter;
  publish: (event: AppEvent) => void;
  sessionId: string;
  projectId?: string | null;
  operationKey: string;
  snapshot: Omit<ContextSnapshot, "id" | "runId" | "assembledAtS">;
  browser: BrowserConfig | ((runId: string) => BrowserConfig);
  fixture?: boolean;
}

// Same process as the event hub. Duplicate model calls/retries share the exact operation;
// persisted operationKey prevents an HTTP retry from making a second reservation.
const running = new Map<string, Promise<ErrandResult>>();

export async function readSessionDesktop(db: Db, sessionId: string): Promise<SessionDesktop> {
  const rows = await db.db.execute(sql`
    select budget->'desktop' as desktop from runs
    where budget->>'kind' = 'errand' and budget->>'sessionId' = ${sessionId}
      and status = 'running' and finalized_at is null
    order by started_at desc limit 1`);
  const row = desktopRowSchema.parse(rows.rows[0]);
  return row?.desktop ?? idleDesktop();
}


async function patch(db: Db, runId: string, fields: Partial<ErrandMetadata>): Promise<void> {
  await db.db.execute(sql`update runs set budget = budget || ${JSON.stringify(fields)}::jsonb where id = ${runId}`);
}

async function metadata(db: Db, runId: string): Promise<ErrandMetadata | undefined> {
  const rows = await db.db.execute(sql`select budget from runs where id = ${runId} and budget->>'kind' = 'errand'`);
  const row = metadataRowSchema.parse(rows.rows[0]);
  return row?.budget;
}

export function runErrand(input: BrowserTaskInput, deps: ErrandDeps): Promise<ErrandResult> {
  const key = `${deps.sessionId}:${deps.operationKey}`;
  const active = running.get(key);
  if (active) return active;
  const operation = executeErrand(input, deps).finally(() => running.delete(key));
  running.set(key, operation);
  return operation;
}

async function executeErrand(input: BrowserTaskInput, deps: ErrandDeps): Promise<ErrandResult> {
  const { db, writer, sessionId, publish } = deps;
  const prior = await db.db.execute(sql`
    select id, budget->'result' as result from runs where budget->>'kind' = 'errand'
    and budget->>'sessionId' = ${sessionId} and budget->>'operationKey' = ${deps.operationKey}
    order by started_at desc limit 1`);
  const existing = priorRunSchema.parse(prior.rows[0]);
  if (existing) return existing.result ?? { runId: existing.id, status: "blocked", summary: "This errand is already running or interrupted; it was not submitted again.", finalUrl: input.startUrl ?? "", screenshotArtifactId: null };

  const projectRow = deps.projectId ? undefined : (await db.db.execute(sql`select id from projects order by ord limit 1`)).rows[0];
  const projectId = deps.projectId ?? projectRowSchema.parse(projectRow)?.id;
  if (!projectId) throw new Error("Seed a Fabric project before starting an errand");
  const task = await writer.createTask({ title: input.goal.slice(0, 100), projectId, teamId: "dana", sessionId });
  const brief: Brief = { objective: input.goal, constraints: ["Bounded browser tool; no specialist delegation"], criteria: ["Report only observed reservation confirmation"], preferences: [], stayed: ["Browser transcript and page observations remain inside browser.task"], tokens: deps.snapshot.totalTokens };
  const budget = { costUsd: 2, timeS: 240, rework: 0, kind: "errand" as const, sessionId, operationKey: deps.operationKey };
  const run = await writer.startRun(task.id, brief, budget, { assistantTokens: deps.snapshot.totalTokens });
  if (deps.fixture) await db.db.execute(sql`update runs set recorded = true, recording_kind = 'real' where id = ${run.id}`);
  publish({ type: "task.changed", taskId: task.id });
  publish({ type: "run.changed", runId: run.id });
  publish({ type: "registry.changed" });
  await writer.saveSnapshot({ ...deps.snapshot, runId: run.id, assembledAtS: 0 });
  return await executeBrowser(run.id, deps, () => deps.fixture
    ? replayBrowserTask(input, browserDeps(run.id, deps))
    : runBrowserTask(input, browserDeps(run.id, deps)));
}

function browserDeps(runId: string, deps: ErrandDeps): BrowserDeps {
  return {
    ...(typeof deps.browser === "function" ? deps.browser(runId) : deps.browser), writer: deps.writer, runId, actor: "dana", step: "browser",
    onDesktop: async (view) => {
      const desktop: SessionDesktop = { url: view.url, runId, screenshotArtifactId: view.screenshotArtifactId ?? null, replay: view.replay ?? false };
      await patch(deps.db, runId, { desktop });
      deps.publish({ type: "session.desktop", sessionId: deps.sessionId, ...desktop });
    },
  };
}

async function executeBrowser(runId: string, deps: ErrandDeps, execute: () => Promise<BrowserTaskResult>): Promise<ErrandResult> {
  const { writer, db, publish, sessionId } = deps;
  const desktop: SessionDesktop = { ...idleDesktop(), runId };
  await patch(db, runId, { desktop });
  publish({ type: "session.desktop", sessionId, ...desktop });
  const step = { label: "Browser errand", stage: "browser", kind: "work" as const };
  try {
    await writer.emit(runId, "step.started", "dana", step);
    await writer.emit(runId, "tool.call", "dana", { tool: "browser.task", summary: "Bounded browser errand" });
    let raw: BrowserTaskResult;
    try {
      raw = await execute();
    } catch (err) {
      raw = { status: "failed", summary: err instanceof Error ? err.message.slice(0, 1000) : "Browser errand failed", finalUrl: null, screenshotArtifactId: null };
    }
    const usages = runUsages(runId);
    if (usages.length) {
      await writer.saveArtifact(runId, { name: "browser-usage.json", by: "dana", content: JSON.stringify(usages) });
      await writer.emit(runId, "budget.update", "dana", { costUsd: runCostUsd(runId) });
    }
    const { pendingAction, ...compact } = raw;
    const result: ErrandResult = { ...compact, runId };
    await patch(db, runId, { result, ...(pendingAction ? { pendingAction, approvalCallId: `confirm-${randomUUID()}` } : {}) });
    const elapsedRow = (await db.db.execute(sql`select extract(epoch from (now() - started_at)) as t from runs where id = ${runId}`)).rows[0];
    const elapsed = elapsedRowSchema.parse(elapsedRow).t;
    const resultContent = JSON.stringify(result);
    const resultSection = { label: "Compact browser result", source: "browser.task", content: resultContent, ...countTokens(resultContent) };
    await writer.saveSnapshot({ ...deps.snapshot, runId, assembledAtS: elapsed, step: "browser.after",
      sections: [...deps.snapshot.sections, resultSection], totalTokens: deps.snapshot.totalTokens + resultSection.tokens });
    await writer.emit(runId, "step.finished", "dana", step);
    if (result.status !== "needs_confirmation") {
      if (result.status !== "completed") await writer.emit(runId, "run.blocked", "dana", { reason: result.summary });
      await writer.emit(runId, "run.finished", "dana", {});
      await writer.end(runId, result.status === "completed" ? "accepted" : "blocked", result.summary);
    } else {
      await db.db.execute(sql`update runs set status = 'blocked' where id = ${runId}`);
      await writer.emit(runId, "run.blocked", "dana", { reason: "Awaiting booking confirmation" });
    }
    return result;
  } finally {
    const idle = idleDesktop();
    try {
      await patch(db, runId, { desktop: idle });
    } finally {
      publish({ type: "session.desktop", sessionId, ...idle });
      publish({ type: "run.changed", runId });
    }
  }
}

export async function confirmationFor(db: Db, sessionId: string, runId: string) {
  const m = await metadata(db, runId);
  if (m?.sessionId !== sessionId || m.result?.status !== "needs_confirmation" || !m.approvalCallId) return undefined;
  return { toolCallId: m.approvalCallId, args: { runId, summary: m.result.summary, confirmation: m.result.confirmation } };
}

export async function decideErrand(toolCallId: string, decision: string, deps: ErrandDeps): Promise<ErrandResult | undefined> {
  // Claim the server-issued card once. Client-provided run ids/actions are never trusted.
  const claim = await deps.db.db.execute(sql`
    update runs set budget = budget || '{"approvalClaimed":true}'::jsonb
    where budget->>'kind' = 'errand' and budget->>'sessionId' = ${deps.sessionId}
      and budget->>'approvalCallId' = ${toolCallId} and coalesce((budget->>'approvalClaimed')::boolean, false) = false
      and budget->'result'->>'status' = 'needs_confirmation'
    returning id, budget`);
  const row = claimRowSchema.parse(claim.rows[0]);
  if (!row) return undefined;
  if (decision !== "approved" || !row.budget.pendingAction) {
    if (row.budget.pendingAction) await cancelBrowserTask(row.budget.pendingAction.token);
    const result: ErrandResult = { ...row.budget.result!, status: "blocked", summary: "Booking was not submitted; confirmation declined." };
    await patch(deps.db, row.id, { result });
    await deps.writer.end(row.id, "stopped", result.summary);
    deps.publish({ type: "run.changed", runId: row.id });
    return result;
  }
  await deps.db.db.execute(sql`update runs set status = 'running' where id = ${row.id}`);
  return executeBrowser(row.id, deps, () => resumeBrowserTask(row.budget.pendingAction!, browserDeps(row.id, deps)));
}
