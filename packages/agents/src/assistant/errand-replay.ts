import { open } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { getRunRow, listStoredEvents, sql, type Db } from "@fabric/db";
import type { BrowserDeps, BrowserTaskInput, BrowserTaskResult } from "@fabric/integrations";
import { browserTaskResultSchema } from "@fabric/integrations";

export const DEFAULT_ERRAND_RECORDING = ".cache/dana/errand.json";
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_PNG_BYTES = 8 * 1024 * 1024;
const MAX_PIXELS = 16 * 1024 * 1024;
const MAX_DELAY_MS = 2_000;
const id = z.string().min(1).max(240);
const resultSchema = browserTaskResultSchema.omit({ pendingAction: true }).extend({
  finalUrl: z.string().max(4000).url().nullable(), screenshotArtifactId: id.nullable(),
});
const artifactRowsSchema = z.array(z.object({ id: z.string(), name: z.string(), content_type: z.string(), content: z.string() }));
const eventSchema = z.discriminatedUnion("type", [
  z.object({ seq: z.number().int().positive(), t: z.number().finite().nonnegative(), type: z.literal("tool.result"),
    payload: z.object({ line: z.string().min(1).max(1500), kind: z.literal("term") }).strict() }).strict(),
  z.object({ seq: z.number().int().positive(), t: z.number().finite().nonnegative(), type: z.literal("tool.call"),
    payload: z.object({ tool: z.string().min(1).max(100), summary: z.string().max(100) }).strict() }).strict(),
  z.object({ seq: z.number().int().positive(), t: z.number().finite().nonnegative(), type: z.literal("artifact.created"),
    payload: z.object({ name: z.string().min(1).max(100), artifactId: id }).strict() }).strict(),
]);
const recordingSchema = z.object({
  version: z.literal(1), sourceRunId: id, recordedAt: z.string().datetime(),
  purpose: z.enum(["reservation", "browser"]),
  speed: z.number().finite().positive().max(1000).optional(),
  result: resultSchema,
  events: z.array(eventSchema).min(1).max(1000),
  screenshots: z.array(z.object({ sourceArtifactId: id, name: z.string().max(100),
    pngBase64: z.string().min(1).max(Math.ceil(MAX_PNG_BYTES / 3) * 4) }).strict()).min(1).max(100),
}).strict();
export type ErrandRecording = z.infer<typeof recordingSchema>;
const screenshotName = /^browser-step-\d{2,3}\.png$/;
// Only the browser's fixed operational narration is portable; arbitrary terminal output may contain PII.
const browserLine = /^(?:browser task: starting headed Dana browser|browser decision \d+: (?:navigate|click|type|select|key|snapshot|completed|blocked) · \d+ms|browser step \d+: (?:navigate|click|type|select|key|snapshot|close) · \d+ms(?: · (?:\d+|\?)\/(?:\d+|\?) tokens · (?:price unknown|\$\d+\.\d+))?)$/;
const browserTool = /^browser\.(?:navigate|click|type|select|key|snapshot|close)$/;
const browserAction = /^(?:navigate|click|type|select|key|snapshot|close)$/;

/** Bounded Playwright PNGs; the browser's image decoder handles the image format itself. */
export function decodeErrandPng(base64: string): Buffer {
  const png = Buffer.from(base64, "base64");
  if (png.length < 33 || png.length > MAX_PNG_BYTES || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      png.toString("ascii", 12, 16) !== "IHDR") throw new Error("Recording screenshot is not a bounded PNG");
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (!width || !height || width > 8192 || height > 8192 || width * height > MAX_PIXELS) throw new Error("Recording screenshot dimensions exceed the limit");
  return png;
}

export function parseErrandRecording(raw: unknown): ErrandRecording {
  const recording = recordingSchema.parse(raw);
  const artifacts = new Set<string>();
  let totalBytes = 0;
  for (const shot of recording.screenshots) {
    if (!screenshotName.test(shot.name) || artifacts.has(shot.sourceArtifactId)) throw new Error("Recording has invalid or duplicate screenshot artifacts");
    artifacts.add(shot.sourceArtifactId);
    totalBytes += decodeErrandPng(shot.pngBase64).length;
  }
  if (totalBytes > MAX_FILE_BYTES / 2) throw new Error("Recording screenshot data exceeds the portable size limit");
  let previousSeq = 0;
  let previousT = 0;
  const emittedArtifacts = new Set<string>();
  for (const event of recording.events) {
    if (event.seq <= previousSeq || event.t < previousT) throw new Error("Recording events are not in source order");
    previousSeq = event.seq;
    previousT = event.t;
    if (event.type === "artifact.created") {
      const shot = recording.screenshots.find((s) => s.sourceArtifactId === event.payload.artifactId);
      if (!shot || shot.name !== event.payload.name || emittedArtifacts.has(shot.sourceArtifactId)) throw new Error("Recording screenshot event does not match an artifact");
      emittedArtifacts.add(shot.sourceArtifactId);
    } else if (event.type === "tool.result") {
      if (!browserLine.test(event.payload.line)) throw new Error("Recording contains nonportable browser terminal output");
    } else if (!browserTool.test(event.payload.tool) || !browserAction.test(event.payload.summary)) {
      throw new Error("Recording contains an outer or nonportable tool call");
    }
  }
  if (emittedArtifacts.size !== artifacts.size || !recording.result.screenshotArtifactId || !artifacts.has(recording.result.screenshotArtifactId)) throw new Error("Recording is missing screenshot events or final screenshot evidence");
  return recording;
}

function withoutContactDetails(text: string): string {
  return text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email redacted]")
    .replace(/(?:\+?\d[\d ().-]{7,}\d)/g, "[contact number redacted]");
}

/** Export only genuine browser evidence; deliberately never read memory/context snapshots. */
export async function exportErrandRecording(db: Db, runId: string, speed?: number): Promise<ErrandRecording> {
  const run = await getRunRow(db, runId);
  if (!run) throw new Error(`Errand run ${runId} was not found`);
  const metadata = z.object({ kind: z.literal("errand"), result: resultSchema.omit({ summary: true }).extend({ summary: z.string().min(1).max(6000) }).passthrough() }).passthrough().parse(run.budget);
  if (run.recorded || /^(?:replay|rehearsal)/i.test(metadata.result.summary)) throw new Error("Export requires an actual live errand run, not a replay");
  const stored = await listStoredEvents(db, runId);
  const rows = artifactRowsSchema.parse((await db.db.execute(sql`select id, name, content_type, content from artifacts where run_id = ${runId} order by ord`)).rows);
  const screenshots = rows.filter((row) => screenshotName.test(row.name)).map((row) => {
    const pngBase64 = row.content.startsWith("data:image/png;base64,")
      ? row.content.slice("data:image/png;base64,".length)
      : (row.content_type === "application/octet-stream" || row.content_type === "image/png") ? row.content : "";
    return { sourceArtifactId: row.id, name: row.name, pngBase64 };
  });
  const screenshotIds = new Set(screenshots.map((s) => s.sourceArtifactId));
  const events: ErrandRecording["events"] = [];
  for (const event of stored.sort((a, b) => a.seq - b.seq)) {
    if (event.actorAgentId !== "dana") continue;
    const { seq, t, type, payload } = event;
    if (type === "artifact.created" && typeof payload.artifactId === "string" && screenshotIds.has(payload.artifactId)) {
      events.push(eventSchema.parse({ seq, t, type, payload }));
    } else if (type === "tool.result" && typeof payload.line === "string" && browserLine.test(payload.line)) {
      events.push(eventSchema.parse({ seq, t, type, payload }));
    } else if (type === "tool.call" && typeof payload.tool === "string" && browserTool.test(payload.tool) && typeof payload.summary === "string" && browserAction.test(payload.summary)) {
      events.push(eventSchema.parse({ seq, t, type, payload }));
    }
  }
  const result = resultSchema.parse({ status: metadata.result.status, summary: withoutContactDetails(metadata.result.summary),
    finalUrl: metadata.result.finalUrl, screenshotArtifactId: metadata.result.screenshotArtifactId,
    ...(metadata.result.confirmation ? { confirmation: metadata.result.confirmation } : {}) });
  return parseErrandRecording({ version: 1, sourceRunId: runId, recordedAt: new Date().toISOString(),
    purpose: /\b(?:book(?:ing)?|reserv(?:e|ation|ations)|table for)\b/i.test(run.objective) ? "reservation" : "browser",
    ...(speed === undefined ? {} : { speed }), result, events, screenshots });
}

/** A fixture is a rehearsal of stored evidence. This path never opens a browser or calls a model. */
export async function replayBrowserTask(input: BrowserTaskInput, deps: BrowserDeps): Promise<BrowserTaskResult> {
  if (deps.actor !== "dana") throw new Error("browser.task replay is private to Dana");
  deps.signal?.throwIfAborted();
  const filename = process.env.DANA_ERRAND_RECORDING ?? DEFAULT_ERRAND_RECORDING;
  let handle;
  try {
    handle = await open(filename, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Dana replay prerequisite missing: record a real errand and export it with scripts/export-errand.ts --run <id> --out ${filename}. No booking was made.`);
    throw error;
  }
  let recording: ErrandRecording;
  try {
    if (!(await handle.stat()).isFile() || (await handle.stat()).size > MAX_FILE_BYTES) throw new Error("Errand recording must be a bounded JSON file");
    const content = await handle.readFile();
    if (content.length > MAX_FILE_BYTES) throw new Error("Errand recording exceeds the portable size limit");
    recording = parseErrandRecording(JSON.parse(content.toString("utf8")));
  } finally {
    await handle.close();
  }
  const purpose = /\b(?:book(?:ing)?|reserv(?:e|ation|ations)|table for)\b/i.test(input.goal) ? "reservation" : "browser";
  if (recording.purpose !== purpose) throw new Error(`Recording is a ${recording.purpose} rehearsal, not a ${purpose} errand. No new booking was made.`);
  await deps.writer.saveArtifact(deps.runId, { name: "browser-replay.json", by: "dana",
    content: JSON.stringify({ sourceRunId: recording.sourceRunId, recordedAt: recording.recordedAt, status: recording.result.status }) });
  const speed = process.env.DANA_REPLAY_SPEED === undefined ? recording.speed ?? 1 : Number(process.env.DANA_REPLAY_SPEED);
  if (!Number.isFinite(speed) || speed <= 0 || speed > 1000) throw new Error("DANA_REPLAY_SPEED must be a number greater than zero and at most 1000");
  const artifactIds = new Map<string, string>();
  let screenshotArtifactId: string | null = null;
  let previousT = recording.events[0]!.t;
  for (const event of recording.events) {
    deps.signal?.throwIfAborted();
    const waitMs = Math.min(MAX_DELAY_MS, Math.max(0, (event.t - previousT) * 1000 / speed));
    if (waitMs) await delay(waitMs, undefined, { signal: deps.signal });
    previousT = event.t;
    if (event.type === "artifact.created") {
      const shot = recording.screenshots.find((s) => s.sourceArtifactId === event.payload.artifactId)!;
      const saved = await deps.writer.saveArtifact(deps.runId, { name: shot.name, by: "dana", content: `data:image/png;base64,${shot.pngBase64}` });
      artifactIds.set(shot.sourceArtifactId, saved.id);
      screenshotArtifactId = saved.id;
    } else if (event.type === "tool.result") {
      await deps.writer.emit(deps.runId, "tool.result", "dana", { kind: "term", line: `[Replay/rehearsal] ${event.payload.line}` });
    } else {
      await deps.writer.emit(deps.runId, "tool.call", "dana", event.payload);
    }
    await deps.onDesktop?.({ url: null, screenshotArtifactId, replay: true });
  }
  const source = recording.result;
  const result: BrowserTaskResult = {
    status: source.status === "needs_confirmation" ? "blocked" : source.status,
    summary: `Replay/rehearsal of recorded run ${recording.sourceRunId} (${source.status}). No new booking was made. ${source.summary}`.slice(0, 1000),
    finalUrl: source.finalUrl,
    screenshotArtifactId: artifactIds.get(source.screenshotArtifactId!)!,
    ...(source.confirmation ? { confirmation: source.confirmation } : {}),
  };
  await deps.onResult?.(result);
  return result;
}
