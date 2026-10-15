#!/usr/bin/env node
// npx tsx scripts/check-errand.ts [--base http://localhost:8894 | --port 8894] [--goal "..."]
// Drives a real browser errand through the session path (RUNTIME §13): the session loop routes
// handle_directly, recalls and calls browser_task; the bridge starts the errand. The recorded
// rehearsal retired with S14 — this check always uses the real browser and MAY MAKE A REAL
// RESERVATION; cancel rehearsal bookings afterwards.
// Uses the existing DATABASE_URL and a unique session; never seeds/resets/deletes working data.
// Assertions cover persistence, events and isolation, never Dana's phrasing.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { createDb, loadRootEnv, sql } from "@fabric/db";
import type { Db } from "@fabric/db";
import type { ContextSnapshot } from "@fabric/contracts";

interface Part {
  type: string;
  toolName?: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  text?: string;
}
interface Message { role: string; content: Part[] }
interface BrowserResult {
  status: "completed" | "blocked" | "failed" | "needs_confirmation";
  summary: string;
  finalUrl: string | null;
  screenshotArtifactId: string | null;
  runId: string;
  confirmation?: { date: string; time: string; partySize: number; reference?: string };
}
interface Desktop {
  type?: string;
  sessionId?: string;
  url: string | null;
  runId: string | null;
  screenshotArtifactId: string | null;
  replay: boolean;
}
interface RunEvent { seq: number; type: string; actorAgentId?: string; payload: Record<string, unknown> }
interface RunRow {
  id: string;
  status: string;
  ended_at: string | null;
  finalized_at: string | null;
  recorded: boolean;
  recording_kind: string | null;
  budget: { kind: string; sessionId: string; result: BrowserResult; desktop: Desktop };
  session_id: string;
  team_id: string;
}
interface Artifact { id: string; name: string; content: string }
interface DesktopSubscription {
  events: Desktop[];
  idle: Promise<void>;
  count: () => number;
  assertHealthy: () => void;
  close: () => Promise<void>;
}

loadRootEnv();
const argv = process.argv.slice(2);
const options: Record<string, string | boolean> = {};
for (let i = 0; i < argv.length; i++) {
  const name = argv[i]!.replace(/^--/, "");
  if (!argv[i]!.startsWith("--") || !["help", "base", "port", "goal"].includes(name)) {
    throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (name === "help") options[name] = true;
  else {
    const next = argv[++i];
    if (!next || next.startsWith("--")) throw new Error(`--${name} requires a value`);
    options[name] = next;
  }
}
if (options.help) {
  console.log("npx tsx scripts/check-errand.ts [--base URL | --port 8894] [--goal TEXT]\nDrives a real browser errand over the session path (S14: no recorded-rehearsal fixture).\nAlways uses the real browser and MAY MAKE A REAL RESERVATION.\nSafe infrastructure smoke: --goal 'Open https://example.com and report the page title without submitting anything'\n--base uses an existing server. DATABASE_URL must match that server.\nNo database seed/reset; each invocation leaves its unique check session and evidence intact.");
  process.exit(0);
}
const port = Number(options.port ?? "8894");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be an integer between 1 and 65535");
if (options.base && options.port) throw new Error("Use --base OR --port, not both");
const base = String(options.base ?? `http://localhost:${port}`).replace(/\/$/, "");
if (!["http:", "https:"].includes(new URL(base).protocol)) throw new Error("--base must be an HTTP(S) URL");
const goal = String(options.goal ?? "Book a reservation at the Japanese restaurant near my place tomorrow at 6pm for 2");
const reservation = /\b(?:book|booking|reserve|reservation)\b/i.test(goal);
const checkTag = `check-errand-${randomUUID().slice(0, 8)}`;
let sessionId = ""; // the session stream id; set once the session is created
const started = Date.now();
const COMPACT_BYTES = 4096;
const deadline = AbortSignal.timeout(360_000);
let db: Db | undefined;
let server: ChildProcess | undefined;
let serverError: Error | undefined;
let eventPump: DesktopSubscription | undefined;
let runEventCount = 0;
let reportedCost = "unknown (provider cost unavailable)";

function ok(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  console.log(`  ✓ ${message}`);
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}
function safe(message: string): string {
  let text = message.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[DATABASE_URL]");
  for (const [key, value] of Object.entries(process.env)) {
    if (value && /(?:TOKEN|SECRET|PASSWORD|API_KEY|DATABASE_URL)/.test(key)) text = text.split(value).join(`[${key}]`);
  }
  return text;
}
function stopServer() {
  if (server?.pid) { try { process.kill(-server.pid, "SIGTERM"); } catch { /* already gone */ } }
}
process.on("exit", stopServer);
process.on("SIGINT", () => { stopServer(); process.exit(130); });
process.on("SIGTERM", () => { stopServer(); process.exit(143); });

async function json<T>(path: string): Promise<T> {
  const response = await fetch(`${base}${path}`, { signal: deadline });
  if (!response.ok) throw new Error(`GET ${path} → ${response.status}`);
  return await response.json() as T;
}
async function startServer() {
  if (options.base) {
    ok(await fetch(`${base}/api/health`, { signal: deadline }).then((r) => r.ok), "existing server is reachable");
    return;
  }
  // Never silently attach to a different server whose mode/database might differ.
  if (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) }).then(() => true).catch(() => false)) {
    throw new Error(`Port ${port} already serves HTTP; choose another --port or explicitly use --base`);
  }
  server = spawn("npx", ["tsx", "apps/server/src/index.ts"], {
    detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port) },
  });
  // Consume output but never print server logs (they may contain credentials or form details).
  server.stdout!.on("data", () => {});
  server.stderr!.on("data", () => {});
  server.on("error", (error) => { serverError = error; });
  server.on("exit", (code) => { serverError ??= new Error(`Owned server exited (${code ?? "signal"})`); });
  for (let i = 0; i < 120; i++) {
    if (serverError) throw serverError;
    if (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok).catch(() => false)) return;
    await sleep(250);
  }
  throw new Error(`Owned server did not become healthy on port ${port}`);
}

async function subscribeDesktop(): Promise<DesktopSubscription> {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/stream`, {
    headers: { Accept: "text/event-stream" }, signal: AbortSignal.any([controller.signal, deadline]),
  });
  if (!response.ok || !response.body) throw new Error(`GET /api/stream → ${response.status}`);
  const events: Desktop[] = [];
  let appCount = 0;
  let active = false;
  let failure: unknown;
  const { promise: ready, resolve: readyResolve, reject: readyReject } = Promise.withResolvers<void>();
  const { promise: idle, resolve: idleResolve, reject: idleReject } = Promise.withResolvers<void>();
  // Keep rejected background promises handled until the main flow awaits them.
  void ready.catch(() => {});
  void idle.catch(() => {});
  const done = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of response.body!) {
        buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
        let index: number;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const event = frame.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
          const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          if (event === "hello") { readyResolve(); continue; }
          if (event !== "app" || !data) continue;
          appCount++;
          const parsed = JSON.parse(data) as Desktop;
          if (parsed.type !== "session.desktop" || parsed.sessionId !== sessionId) continue;
          events.push(parsed);
          if (parsed.runId) active = true;
          if (active && isIdle(parsed)) idleResolve();
        }
      }
      if (!controller.signal.aborted) throw new Error("App SSE closed before the check finished");
    } catch (error) {
      if (!controller.signal.aborted) { failure = error; readyReject(error); idleReject(error); }
    }
  })();
  await ready;
  return {
    events, idle, count: () => appCount,
    assertHealthy: () => { if (failure) throw failure; },
    close: async () => { controller.abort(); await done; },
  };
}
function isIdle(desktop: Desktop): boolean {
  return desktop.runId === null && desktop.url === null && desktop.screenshotArtifactId === null && desktop.replay === false;
}
function boundedResult(value: unknown): BrowserResult {
  ok(value !== null && typeof value === "object" && !Array.isArray(value), "browser result is an object");
  const result = value as BrowserResult;
  const allowed: Record<string, true> = { status: true, summary: true, finalUrl: true, screenshotArtifactId: true, confirmation: true, runId: true };
  ok(Object.keys(result).every((key) => Object.hasOwn(allowed, key)), "browser result exposes only compact public fields");
  ok(Buffer.byteLength(JSON.stringify(result)) <= COMPACT_BYTES, `browser result is bounded to ${COMPACT_BYTES} bytes`);
  ok(["completed", "blocked", "failed", "needs_confirmation"].includes(result.status), "browser result has a known status");
  ok(typeof result.summary === "string" && result.summary.length > 0 && result.summary.length <= 1000, "browser result summary is bounded and present");
  ok(typeof result.runId === "string" && !!result.runId, "browser result identifies its persisted run");
  ok(result.finalUrl === null || typeof result.finalUrl === "string", "browser result final URL is compact");
  ok(result.screenshotArtifactId === null || typeof result.screenshotArtifactId === "string", "browser result screenshot is an artifact reference, not bytes");
  if (result.confirmation) {
    ok(Object.keys(result.confirmation).every((key) => ["date", "time", "partySize", "reference"].includes(key)), "confirmation contains no private browsing data");
  }
  return result;
}
function noInnerTranscript(value: unknown): boolean {
  if (!value || typeof value !== "object") return true;
  if (Array.isArray(value)) return value.every(noInnerTranscript);
  return Object.entries(value).every(([key, item]) =>
    !/^(?:dom|elements|observations?|actions?|actionHistory|screenshotBase64|steps|pendingAction)$/i.test(key) && noInnerTranscript(item));
}

/** One live errand, over the session path: post the goal, then wait for the bridge's run.
 * The session loop routes handle_directly, recalls and calls browser_task (S8b); the errand's
 * own dedupe keys the bridge call, so a redelivered turn cannot start a second errand. */
async function driveErrand(db: Db): Promise<BrowserResult> {
  const created = (await (await fetch(`${base}/api/sessions`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "app://fabric" },
    body: JSON.stringify({ agentId: "dana" }),
  })).json()) as { sessionId: string };
  if (!created.sessionId) throw new Error("session creation returned no id");
  sessionId = created.sessionId;
  const posted = await fetch(`${base}/api/sessions/${sessionId}/messages`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "app://fabric" },
    body: JSON.stringify({ clientMessageId: randomUUID(), text: goal }),
  });
  if (!posted.ok) throw new Error(`session message → ${posted.status}: ${(await posted.text()).slice(0, 200)}`);

  // The bridge's errand run, then its terminal state. The budget row carries the
  // compact result; the SSE desktop (subscribed above) observes it live.
  const limit = Date.now() + 330_000;
  for (;;) {
    const rows = (await db.db.execute(sql`
      select r.id, r.status, r.ended_at, r.finalized_at, r.recorded, r.recording_kind, r.budget
      from runs r join tasks t on t.id = r.task_id
      where r.budget->>'kind' = 'errand' and r.budget->>'sessionId' = ${sessionId}`)).rows as unknown as RunRow[];
    const row = rows[0];
    if (row && row.ended_at !== null) return boundedResult((row.budget as { result: unknown }).result);
    if (Date.now() > limit) throw new Error(`the errand run never reached a terminal state in 330s (row: ${row ? row.status : "none yet"})`);
    await sleep(2_000);
  }
}

try {
  console.warn("WARNING: the check uses the real browser and MAY MAKE A REAL RESERVATION. Cancel rehearsal bookings afterwards.");
  if (!process.env.DATABASE_URL) throw new Error("Missing existing DATABASE_URL; this check never provisions, seeds or resets a database");
  console.log(`check:errand · live session path · tag ${checkTag}`);
  db = createDb(process.env.DATABASE_URL);
  await startServer();
  const result = await driveErrand(db);
  eventPump = await subscribeDesktop();
  // The turn has run; drain the desktop stream's tail, then assert from the log.
  await sleep(2_000);
  eventPump.assertHealthy();
  const desktops = eventPump.events;
  ok(desktops.some((desktop) => desktop.runId === result.runId), "SSE observes this errand's active desktop");
  ok(desktops.every((desktop) => desktop.replay === false), "live desktop events are not replay");
  const rows = (await db.db.execute(sql`
    select r.id, r.status, r.ended_at, r.finalized_at, r.recorded, r.recording_kind, r.budget, t.session_id, t.team_id
    from runs r join tasks t on t.id = r.task_id
    where r.budget->>'kind' = 'errand' and r.budget->>'sessionId' = ${sessionId}`)).rows as unknown as RunRow[];
  ok(rows.length === 1, "exactly one errand run exists for the unique session");
  const row = rows[0]!;
  ok(row.id === result.runId && row.budget.kind === "errand" && row.budget.sessionId === sessionId, "run metadata links the browser result to this session");
  ok(row.session_id === sessionId && row.team_id === "dana", "persisted task is session-linked and owned by Dana");
  ok(isIdle(row.budget.desktop), "persisted desktop metadata is Idle");
  if (result.status === "needs_confirmation") {
    ok(row.status === "blocked" && row.finalized_at === null && row.ended_at === null, "approval-needed run is blocked but deliberately not final");
  } else {
    ok(row.status === (result.status === "completed" ? "accepted" : "blocked"), "run status matches real browser outcome");
    ok(!!row.finalized_at && !!row.ended_at, "terminal run has ended and claimed finality");
  }
  const events = await json<RunEvent[]>(`/api/runs/${result.runId}/events`);
  runEventCount = events.length;
  if (result.status !== "completed") {
    console.log(`evidence: run ${result.runId} · status ${result.status}`);
    throw new Error(`Real completion prerequisite missing (${result.status}): ${result.summary}`);
  }
  const screenshots = desktops.filter((desktop) => desktop.runId === result.runId && desktop.screenshotArtifactId);
  ok(typeof result.finalUrl === "string" && /^https?:\/\//.test(result.finalUrl), "completed browser result carries its observed final HTTP(S) URL");
  ok(!!result.screenshotArtifactId, "completed browser result references a final screenshot");
  if (reservation) {
    const confirmation = result.confirmation;
    ok(confirmation && typeof confirmation.date === "string" && !!confirmation.date && typeof confirmation.time === "string" && !!confirmation.time && Number.isInteger(confirmation.partySize) && confirmation.partySize > 0, "booking has observed date, time and party size");
    ok(typeof confirmation.reference === "string" && !!confirmation.reference.trim(), "booking has an observed confirmation reference");
    if (!options.goal) ok(confirmation.partySize === 2, "default booking is for a party of two");
  }
  ok(events.some((event) => event.type === "tool.call" && event.payload.tool === "browser.task"), "run events record canonical browser.task invocation");
  ok(events.some((event) => event.type === "tool.result" && event.payload.kind === "term" && typeof event.payload.line === "string" && !!event.payload.line), "run events contain streamed inner terminal lines");
  const finished = events.find((event) => event.type === "run.finished");
  ok(finished, "run event log records terminal completion");
  ok(events.some((event) => event.type === "artifact.created" && event.payload.artifactId === result.screenshotArtifactId && event.seq < finished.seq), "final screenshot artifact is linked before run completion");
  const artifacts = (await db.db.execute(sql`select id, name, content from artifacts where run_id = ${result.runId} order by ord`)).rows as unknown as Artifact[];
  ok(artifacts.some((artifact) => artifact.id === result.screenshotArtifactId && artifact.name.endsWith(".png")), "database persists the referenced final PNG artifact");
  let recordedSteps: { dom?: string; usage?: { costUsd?: number } }[] = [];
  {
    ok(!row.recorded, "live errand is not marked as a recorded replay");
    const capture = artifacts.find((artifact) => artifact.name === "browser-recording.json");
    ok(capture, "database persists the actual live browser recording artifact");
    const recordingBody = JSON.parse(capture.content) as { steps?: typeof recordedSteps };
    ok(Array.isArray(recordingBody.steps) && recordingBody.steps.length > 0, "live recording contains observed browser steps");
    recordedSteps = recordingBody.steps;
  }
  const snapshots = await json<ContextSnapshot[]>(`/api/runs/${result.runId}/snapshots`);
  const before = snapshots.find((snapshot) => snapshot.step === "browser.before");
  const after = snapshots.find((snapshot) => snapshot.step === "browser.after");
  ok(before && after && snapshots.every((snapshot) => snapshot.agentId === "dana"), "API exposes Dana's before and after outer context snapshots");
  ok(after.sections.length === before.sections.length + 1, "after snapshot adds exactly one section, not an inner transcript");
  ok(canonical(after.sections.slice(0, before.sections.length)) === canonical(before.sections), "preexisting outer context sections remain unchanged");
  const resultSection = after.sections[after.sections.length - 1]!;
  ok(resultSection.source === "browser.task" && canonical(JSON.parse(resultSection.content ?? "")) === canonical(result), "the only added context section is the compact browser result");
  ok(after.totalTokens - before.totalTokens === resultSection.tokens, "outer token growth equals only the compact result section's tokens");
  ok(before.totalTokens === before.sections.reduce((sum, section) => sum + section.tokens, 0) && after.totalTokens === after.sections.reduce((sum, section) => sum + section.tokens, 0), "snapshot token totals match their sections");
  const outerTexts = [...snapshots.flatMap((snapshot) => snapshot.sections.map((section) => section.content ?? ""))];
  for (const step of recordedSteps) {
    if (typeof step.dom === "string" && step.dom.length >= 128 && outerTexts.some((text) => text.includes(step.dom!) || text.includes(JSON.stringify(step.dom).slice(1, -1)))) {
      throw new Error("Observed inner page DOM leaked into persisted outer context/history");
    }
  }
  for (const snapshot of snapshots) {
    for (const section of snapshot.sections) {
      try {
        const parsed: unknown = JSON.parse(section.content ?? "");
        if (!noInnerTranscript(parsed)) throw new Error("Inner browser transcript leaked into an outer context snapshot");
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
  }
  ok(true, "outer context excludes recorded browsing observations");
  for (const artifactId of new Set(screenshots.map((desktop) => desktop.screenshotArtifactId!))) {
    const response = await fetch(`${base}/api/artifacts/${encodeURIComponent(artifactId)}/screenshot`, { signal: deadline });
    ok(response.ok && response.headers.get("content-type")?.split(";")[0] === "image/png", "screenshot endpoint serves a verified PNG");
    const bytes = new Uint8Array(await response.arrayBuffer());
    ok(bytes.length > 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "screenshot bytes have the PNG signature");
  }
  const usages = recordedSteps.map((step) => step.usage).filter((usage) => usage !== undefined);
  const knownCost = usages.length > 0 && usages.every((usage) => typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd));
  if (knownCost) reportedCost = `$${usages.reduce((sum, usage) => sum + usage.costUsd!, 0).toFixed(6)} recorded browser-model cost`;
  console.log(`\ncheck:errand PASSED · live session path · run ${result.runId}`);
  console.log(`events: ${events.length} run / ${eventPump.count()} app · outer tokens: ${before.totalTokens} → ${after.totalTokens} (+${resultSection.tokens}) · result: ${Buffer.byteLength(JSON.stringify(result))} bytes`);
  console.log(`cost: ${reportedCost} · elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s`);
} catch (error) {
  console.error(`check:errand FAILED: ${safe(error instanceof Error ? error.message : String(error))}`);
  console.error(`events: ${runEventCount} run / ${eventPump?.count() ?? 0} app · cost: ${reportedCost} · elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  process.exitCode = 1;
} finally {
  await eventPump?.close();
  await db?.close();
  stopServer();
}
