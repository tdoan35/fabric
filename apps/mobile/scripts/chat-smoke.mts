/**
 * Chat + app-stream smoke (MOB-E): drives the app's own chatStream generator and app-stream
 * manager against the running server, under node. The fetch implementation is injected, so this
 * exercises exactly the code the phone runs (lib/chat.ts, lib/stream.ts) minus expo/fetch itself
 * — that part is only provable on a device (see docs/status/mobile-chat.md).
 *
 * Run from apps/mobile (server first — see docs/status/mobile-chat.md):
 *   ../../fabric-mobile-demo/node_modules/.bin/tsx scripts/chat-smoke.mts   # any tsx will do
 *
 * What it proves:
 *  1. GET /api/sessions/c1/messages parses with SessionMessagesSchema (the history the screen loads).
 *  2. A scripted-Dana turn (fixture: true — same stream path, no LLM cost) yields NDJSON lines
 *     whose part counts are non-decreasing with at least one strict increase: the lines are
 *     CUMULATIVE snapshots, not deltas; the final snapshot matches the turn contract (§4.3):
 *     record_disposition first (with its result), text, and a pending propose_team without result.
 *  3. lib/stream.ts's createAppStream connects to /api/stream through node's fetch, parses the
 *     hello/ping/app frames, and delivers the turn's registry.changed events to a filtered subscriber.
 *
 * Side effects (on whatever DB the server points at): one scratch session row + its two messages,
 * a dispositions row and a pending proposals row from the scripted turn. The scratch id keeps the
 * demo thread `c1` untouched; the pre-demo `npm run seed -- --profile demo` truncates it anyway.
 */
import { SessionMessagesSchema, type ChatStreamLine } from "@fabric/contracts";
import { chatStream, DEMO_SESSION_ID, toWire } from "../lib/chat";
import { createAppStream } from "../lib/stream";

const base = (process.env.EXPO_PUBLIC_API_URL || "http://localhost:8787").replace(/\/$/, "");
const sessionId = `m1-smoke-${Date.now().toString(36)}`;
// @fabric/fixtures/chat IDEA_PROMPT, inlined (fixtures isn't a mobile dependency): the scripted
// first turn keys on "a fresh session with a new user message", and this is the demo's wording.
const IDEA_PROMPT =
  "I want to test an idea: graft an n-gram / Engram lookup table onto a much smaller open model to boost its capability. The table could live on NAND instead of RAM.";

const fail = (msg: string): never => {
  console.log(`FAIL — ${msg}`);
  process.exit(1);
};

// ---- 1. history contract on the demo thread ----
const historyRaw: unknown = await (await fetch(`${base}/api/sessions/${DEMO_SESSION_ID}/messages`)).json();
const history = SessionMessagesSchema.parse(historyRaw);
console.log(`history ${DEMO_SESSION_ID}: SessionMessagesSchema ok — ${history.messages.length} messages`);

// ---- 2. the app-stream manager, before the turn, so it sees the events ----
const seen: string[] = [];
const stream = createAppStream(fetch, base);
const offStatus = stream.onStatus((s) => console.log(`  stream: ${s.state}${s.attempts ? ` (retry ${s.attempts})` : ""}`));
const offEvents = stream.subscribe(
  (e) => e.type === "registry.changed" || e.type === "session.message",
  (e) => {
    seen.push(e.type);
    console.log(`  event: ${e.type}${e.type === "session.message" ? ` ${e.sessionId}` : ""}`);
  },
);

// ---- 3. the scripted turn through the same generator the screen uses ----
const userMessage = {
  id: "smoke-user",
  role: "user" as const,
  content: [{ type: "text" as const, text: IDEA_PROMPT }],
  createdAt: new Date().toISOString(),
};
let lines = 0;
let final: ChatStreamLine | undefined;
const partCounts: number[] = [];
let prevText = "";
let textGrew = false;
for await (const line of chatStream(fetch, { sessionId, messages: toWire([userMessage]), fixture: true })) {
  lines++;
  final = line;
  partCounts.push(line.content.length);
  // The snapshot contract (§4.3): each line's text extends the previous line's — typing grows in place.
  const text = line.content.filter((p) => p.type === "text").map((p) => (p.type === "text" ? p.text : "")).join("");
  if (!text.startsWith(prevText)) {
    fail(`line ${lines} is not cumulative — text rewrote:\n  was: …${prevText.slice(-50)}\n  now: …${text.slice(-50)}`);
  }
  if (text.length > prevText.length) textGrew = true;
  prevText = text;
}
if (!final) fail("no NDJSON lines arrived");
if (!textGrew) fail("text never grew in place — lines are not cumulative snapshots");
const first = final.content[0];
const last = final.content[final.content.length - 1];
if (first?.type !== "tool-call" || first.toolName !== "record_disposition" || first.result === undefined) {
  fail("final snapshot does not start with a resolved record_disposition");
}
if (last?.type !== "tool-call" || last.toolName !== "propose_team" || last.result !== undefined) {
  fail("final snapshot does not end on a pending propose_team");
}
if (!final.content.some((p) => p.type === "text" && p.text.trim())) fail("final snapshot carries no text");

console.log(`turn ${sessionId}: ${lines} lines, part counts ${partCounts.join(" → ")}`);
console.log("final snapshot:");
for (const part of final.content) {
  console.log(
    part.type === "text"
      ? `  text: ${part.text.slice(0, 90)}${part.text.length > 90 ? "…" : ""}`
      : `  tool-call: ${part.toolName}${part.result === undefined ? " (pending)" : " (resolved)"}`,
  );
}
const proposal = final.content.find((p) => p.type === "tool-call" && p.toolName === "propose_team");
if (proposal?.type === "tool-call") {
  const card = proposal.args as { name?: string; roster?: { name?: string; role?: string }[] };
  console.log(`  card: ${card.name ?? "?"} — ${(card.roster ?? []).map((r) => `${r.name}·${r.role}`).join(", ")}`);
}

// ---- 4. the turn announced itself on /api/stream (registry.changed at creation and turn end) ----
for (let i = 0; i < 20 && !seen.includes("registry.changed"); i++) await new Promise((r) => setTimeout(r, 250));
if (!seen.includes("registry.changed")) fail("the app stream delivered no registry.changed for the turn");
if (stream.status().state !== "live") fail(`stream state is ${stream.status().state}, expected live`);

// ---- 5. history contract on the scratch thread (the post-turn reload the screen does) ----
const after: unknown = await (await fetch(`${base}/api/sessions/${sessionId}/messages`)).json();
const afterParsed = SessionMessagesSchema.parse(after);
if (afterParsed.messages.length !== 2 || afterParsed.messages[0].role !== "user") {
  fail(`scratch history is ${afterParsed.messages.length} messages, expected 2 (user then assistant)`);
}
offEvents();
offStatus();
console.log(`SMOKE OK — ${lines} cumulative lines, stream live, ${seen.length} matching events (${[...new Set(seen)].join(", ")})`);
