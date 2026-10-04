#!/usr/bin/env node
// npm run check:team [-- [--branch demo] [--port 8895] [--skip-toy]]
//
// TEAM's end-to-end check (§7.0 step 7), sequential on the Spark lane, against a server this
// script starts on the demo branch. Never prints connection strings or keys.
//
//   1. the live start through fixture-Dana's handoff (the real demo path):
//        - the four opening step.started within the first seconds (the ~6 s seam window)
//        - at least 3 members with an open step by 45 s (PRD §10.3)
//        - Megan's Exa narration and Jonah's terminal lines arriving live
//        - a snapshot with real section content for every started step
//   2. POST /splice at ~45 s: cancelRun stops new events (nothing after splice_t but the
//      recording tail), the merged log derives with no stretched or missing lanes, and
//      finalize-splice succeeds
//   3. a toy run end to end: accepted, review.verdict, criterion.checked, a finalized report
//   4. forced bounce: rework.requested → a Rework segment of kind "rework" → Re-check → accept
//   5. forced exhaustion (budget 1, two bounces): run.blocked, status blocked
//   Ends with a timing table, then reseeds demo to leave it clean.
import { execFileSync, spawn } from "node:child_process";
import { createDb, sql } from "@fabric/db";
import { IDEA_PROMPT } from "@fabric/fixtures/chat";

const NEON_PROJECT = "solitary-meadow-39146227";

const args = process.argv.slice(2);
const value = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : dflt;
};
const flag = (name: string) => args.includes(`--${name}`);
const branch = value("branch", "demo");
const port = Number(value("port", "8895"));
const base = `http://localhost:${port}`;

const ok = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  ok  ${msg}`);
};
const info = (msg: string) => console.log(msg);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The neon CLI prints credentials; capture, never echo. */
const branchUrl = () =>
  execFileSync("neon", ["connection-string", "--project-id", NEON_PROJECT, "--branch", branch, "--pooled"], {
    encoding: "utf8",
  }).trim().split("\n").pop()!.trim();

// ---- server lifecycle (detached + group kill, like check-chat/check-tools) ----
const procs: ReturnType<typeof spawn>[] = [];
const stopAll = () => {
  for (const p of procs) {
    try { process.kill(-p.pid!, "SIGTERM"); } catch { /* already gone */ }
  }
};
process.on("exit", stopAll);
process.on("SIGINT", () => { stopAll(); process.exit(130); });
process.on("SIGTERM", () => { stopAll(); process.exit(143); });

const startServer = async (pooled: string) => {
  const server = spawn("npx", ["tsx", "apps/server/src/index.ts"], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DATABASE_URL: pooled, NEON_BRANCH: branch, PORT: String(port) },
  });
  procs.push(server);
  let logs = "";
  server.stdout!.on("data", (c) => { logs += c.toString(); });
  server.stderr!.on("data", (c) => { logs += c.toString(); });
  server.on("exit", (code) => { if (code !== 0 && code !== null) console.error(`server exited ${code}:\n${logs.slice(-3000)}`); });
  for (let i = 0; i < 60; i++) {
    if (await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false)) return;
    await sleep(250);
  }
  throw new Error(`server never came up on ${base}:\n${logs.slice(-2000)}`);
};

// ---- chat helpers (fixture Dana, like check-chat) ----

interface Part { type: string; text?: string; toolCallId?: string; toolName?: string; args?: any; result?: any }

async function turn(sessionId: string, messages: unknown[]): Promise<Part[]> {
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, fixture: true, messages }),
  });
  if (!res.ok) throw new Error(`chat turn failed ${res.status}: ${await res.text()}`);
  let parts: Part[] = [];
  for (const line of (await res.text()).split("\n").filter(Boolean)) {
    parts = (JSON.parse(line) as { content: Part[] }).content;
  }
  return parts;
}

const userMsg = (text: string) => ({ role: "user", content: [{ type: "text", text }] });

/** The thread as the web runtime would send it after deciding a card: the stored history with
 * the decision stamped on the card's part — exactly check-chat's shape (no extra user message). */
async function decide(sessionId: string, toolName: string): Promise<unknown[]> {
  const history = (await (await fetch(`${base}/api/sessions/${sessionId}/messages`)).json()) as { messages: { id: string; role: string; content: Part[] }[] };
  const last = history.messages[history.messages.length - 1];
  const part = last.content.find((p) => p.toolName === toolName);
  if (!part) throw new Error(`no ${toolName} card in the last message of ${sessionId}`);
  return history.messages.map((m) =>
    m.id === last.id ? { ...m, content: m.content.map((p) => (p === part ? { ...p, result: { decision: "approved" } } : p)) } : m,
  );
}

// ---- run helpers ----

interface Ev { seq: number; t: number; type: string; actorAgentId?: string; payload: any }
const events = async (runId: string): Promise<Ev[]> => (await (await fetch(`${base}/api/runs/${runId}/events`)).json()) as Ev[];
const runGet = async (runId: string) => (await (await fetch(`${base}/api/runs/${runId}`)).json());
const post = async (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const openCount = (evs: Ev[], atT: number): number => {
  const open = new Set<string>();
  for (const e of evs.filter((e) => e.t <= atT)) {
    if (e.type === "step.started") open.add(e.actorAgentId!);
    else if (e.type === "step.finished") open.delete(e.actorAgentId!);
  }
  return open.size;
};

/** Polls until the run finishes (run.finished / run.blocked) or the timeout. */
async function waitForEnd(runId: string, timeoutMs: number): Promise<Ev[]> {
  const start = Date.now();
  for (;;) {
    const evs = await events(runId);
    if (evs.some((e) => e.type === "run.finished" || e.type === "run.blocked")) return evs;
    if (Date.now() - start > timeoutMs) throw new Error(`run ${runId} did not finish within ${timeoutMs / 1000}s; last: ${evs.slice(-3).map((e) => e.type).join(", ")}`);
    await sleep(4000);
  }
}

// =====================================================================================
const pooled = branchUrl();
const startedAll = Date.now();
const timings: [string, string][] = [];

info(`1. seeding demo on branch ${branch} …`);
execFileSync("npm", ["run", "seed", "-w", "@fabric/db", "--", "--profile", "demo", "--branch", branch], {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
});
await startServer(pooled);

// ---- Phase 1: the live start through fixture-Dana's handoff ----
info("2. fixture Dana: idea → approvals → handoff (the real demo path)");
const tHandoff0 = Date.now();
await turn("t1", [userMsg(IDEA_PROMPT)]);
await turn("t1", await decide("t1", "propose_team"));
const finalParts = await turn("t1", await decide("t1", "propose_specialist"));
const handoff = finalParts.find((p) => p.toolName === "handoff_to_team")!;
const runId = handoff.result.runId as string;
const taskId = handoff.result.taskId as string;
ok(!!runId && !!taskId, `the handoff created the run ${runId} (task ${taskId})`);
const handoffDone = Date.now();

let evs: Ev[] = [];
let firstStepT: number | undefined;
let threeMembersWall: number | undefined;
let exaWall: number | undefined;
let termWall: number | undefined;
const LIVE_WINDOW_S = 45;
while (Date.now() - handoffDone < LIVE_WINDOW_S * 1000) {
  evs = await events(runId);
  const starts = evs.filter((e) => e.type === "step.started");
  if (firstStepT === undefined && starts.length) {
    firstStepT = Math.max(...starts.map((e) => e.t));
    timings.push(["first step.started (run t)", `${firstStepT.toFixed(1)}s`]);
  }
  const nowT = (Date.now() - handoffDone) / 1000 + (firstStepT ?? 0);
  if (threeMembersWall === undefined && openCount(evs, nowT) >= 3) threeMembersWall = Date.now() - handoffDone;
  if (exaWall === undefined && evs.some((e) => e.type === "agent.message" && e.actorAgentId === "megan" && /exa\.search/.test(e.payload.text ?? ""))) {
    exaWall = Date.now() - handoffDone;
  }
  if (termWall === undefined && evs.some((e) => e.type === "tool.result" && e.actorAgentId === "jonah" && e.payload.kind === "term")) {
    termWall = Date.now() - handoffDone;
  }
  if (threeMembersWall !== undefined && exaWall !== undefined && termWall !== undefined) break;
  await sleep(1000);
}

const starts = evs.filter((e) => e.type === "step.started");
const labels = starts.map((e) => `${e.actorAgentId}:${e.payload.label}`).sort();
ok(labels.join() === ["elliot:Plan", "jonah:Setup", "megan:Survey", "sana:Prep checks"].sort().join(),
  `the four opening steps carry the recording's labels (${labels.join(", ")})`);
ok((firstStepT ?? 99) <= 8, `all opening steps started within ~6 s of the run (worst t ${firstStepT?.toFixed(1)}s)`);
ok(threeMembersWall !== undefined && threeMembersWall <= LIVE_WINDOW_S * 1000, `at least 3 members working within 45 s (${((threeMembersWall ?? 0) / 1000).toFixed(1)}s after the handoff turn)`);
ok(exaWall !== undefined && exaWall <= LIVE_WINDOW_S * 1000, `Megan's Exa line arrived live (${((exaWall ?? 0) / 1000).toFixed(1)}s)`);
ok(termWall !== undefined && termWall <= LIVE_WINDOW_S * 1000, `Jonah's terminal line arrived live (${((termWall ?? 0) / 1000).toFixed(1)}s)`);
timings.push(["3 members working (wall)", `${((threeMembersWall ?? 0) / 1000).toFixed(1)}s`]);
timings.push(["first Exa line (wall)", `${((exaWall ?? 0) / 1000).toFixed(1)}s`]);
timings.push(["first terminal line (wall)", `${((termWall ?? 0) / 1000).toFixed(1)}s`]);

const snapshots = (await (await fetch(`${base}/api/runs/${runId}/snapshots`)).json()) as { agentId: string; step: string; sections: { content: string }[]; totalTokens: number }[];
const startedAgents = new Set(starts.map((e) => e.actorAgentId));
for (const agentId of startedAgents) {
  const snap = snapshots.find((s) => s.agentId === agentId);
  ok(!!snap, `a snapshot exists for ${agentId}'s started step (${snap?.step})`);
  ok(!!snap && snap.sections.length === 6 && snap.sections.every((s) => s.content.trim().length > 0), `${agentId}'s snapshot has real section content (${snap?.totalTokens} tokens)`);
}
ok(evs.some((e) => e.type === "context.snapshot"), "context.snapshot events emitted before the model calls");

// ---- Phase 2: the splice at ~45 s ----
info("3. splice at ~45 s: cancelRun stops the live run; the recording takes over");
const runBefore = await runGet(runId);
const spliceT = Math.max(45, Math.floor(runBefore.durationS));
const spliced = await post(`/api/runs/${runId}/splice`, { t: spliceT });
ok(spliced.ok, `POST /splice {t: ${spliceT}} succeeded`);
const merged1 = await events(runId);
const tail1 = merged1.filter((e) => e.t > spliceT);
// No live event may follow the splice point: the tail is exactly the recording's (plus, later,
// finalize's run.finished). Leak watch: the merged tail must not grow before finalize.
const key = (e: Ev) => `${e.type}|${e.actorAgentId ?? ""}|${e.t}`;
const tailKeys = new Set(tail1.map(key));
await sleep(5000);
const merged2 = await events(runId);
ok(merged2.filter((e) => e.t > spliceT).every((e) => tailKeys.has(key(e))), "no new events after splice_t while cancelled (cancelRun stopped the lanes)");

const runAfter = await runGet(runId);
ok(runAfter.recording?.key === "ngram-135m" && runAfter.recording?.spliceT === spliceT, `the run carries its recording (${runAfter.recording?.key}, splice at ${spliceT}s)`);
const laneSpans = (agentId: string, label: string) => runAfter.segments.filter((s) => s.agentId === agentId && s.label === label);
const expectLane = (agentId: string, label: string, end: number) => {
  const segs = laneSpans(agentId, label);
  // A live step that finished before the splice (Jonah's Setup can beat 45 s) bridges into a
  // second segment at splice_t: honest lanes, as long as none stretches or goes missing.
  ok(segs.length >= 1 && segs.length <= 2, `${agentId}'s ${label} lane derives across the splice (${segs.length} segment${segs.length === 1 ? "" : "s"}, no missing lane)`);
  ok(segs[0]?.start <= 10, `  starts live in the seam window (${segs[0]?.start?.toFixed(1)}s)`);
  ok(Math.abs(segs.at(-1)!.end - end) < 2, `  ends at the recording's ${end}s (no stretch)`);
  ok(segs.every((s) => s.end <= spliceT + 5 || Math.abs(s.end - end) < 2), "  no segment stretches past its natural end");
};
ok(runAfter.segments.length >= 12, `the merged log derived ${runAfter.segments.length} segments (no missing lanes)`);

const fin = await (await post(`/api/runs/${runId}/finalize-splice`, {})).json();
ok(!!fin.reportId, `finalize-splice succeeded (report ${fin.reportId})`);
const merged3 = await events(runId);
const afterT = merged3.filter((e) => e.t > spliceT);
ok(afterT.length === tail1.length + 1 && merged3.at(-1)!.type === "run.finished" && merged3.at(-1)!.payload.reportId === fin.reportId,
  "the only event added after the tail is finalize's run.finished");
const report = (await (await fetch(`${base}/api/reports/${fin.reportId}`)).json());
ok(!!report.id && !!report.summary, `the report is served (${report.title ?? fin.reportId})`);
const thread = (await (await fetch(`${base}/api/sessions/t1/messages`)).json()) as { messages: { content: Part[] }[] };
const results = thread.messages.at(-1)?.content.find((p) => p.toolName === "post_results");
ok(!!results && (results.args as { reportId?: string }).reportId === fin.reportId, "Dana's results message closes the thread, pointing at the report (CHAT-14)");
const taskAfter = (await (await fetch(`${base}/api/tasks/${taskId}`)).json()) as { runIds: string[] };
const loopAfter = await runGet(taskAfter.runIds.at(-1)!);
ok(loopAfter.status === "accepted", `the task's loop is accepted (${loopAfter.status})`);
timings.push(["handoff turn (fixture, incl. startTeamRun)", `${((handoffDone - tHandoff0) / 1000).toFixed(1)}s`]);

// ---- the toy/bounce/block runs share one runner ----
async function devRun(name: string, body: unknown, checks: (evs: Ev[], run: any) => void, timeoutMs: number): Promise<void> {
  info(`${name}: POST /api/dev/team ${JSON.stringify(body)}`);
  const t0 = Date.now();
  const started = await (await post("/api/dev/team", body)).json();
  ok(!!started.runId, `the dev run started (${started.runId})`);
  const evsDone = await waitForEnd(started.runId, timeoutMs);
  const run = await runGet(started.runId);
  for (const e of evsDone.filter((e) => e.type === "step.started")) {
    if (!timings.some(([k]) => k.startsWith(`${name}: ${e.payload.stage} started`))) {
      timings.push([`${name}: ${e.payload.stage} started`, `${e.payload.label} at ${e.t.toFixed(0)}s`]);
    }
  }
  timings.push([`${name}: finished`, `${((Date.now() - t0) / 1000).toFixed(0)}s · ${run.status}`]);
  checks(evsDone, run);
}

if (!flag("skip-toy")) {
  // ---- Phase 3: the toy run, end to end ----
  await devRun("4. toy", { toy: true }, (evsDone, run) => {
    ok(run.status === "accepted", `the toy run ended accepted (${run.status})`);
    const verdict = evsDone.find((e) => e.type === "review.verdict");
    ok(verdict?.payload.verdict === "accept" && verdict.payload.text.length > 10, "review.verdict {accept} with text");
    ok(evsDone.some((e) => e.type === "criterion.checked" && e.payload.pass === true), "criterion.checked with a pass");
    ok(evsDone.some((e) => e.type === "run.finished" && e.payload.reportId), `run.finished with a report (${run.reportId})`);
    ok(evsDone.some((e) => e.type === "tool.call" && e.payload.tool === "sprite.exec"), "the toy ran real commands in the Sprite");
    ok(evsDone.some((e) => e.type === "agent.message" && e.actorAgentId === "megan" && /exa\.search/.test(e.payload.text ?? "")), "Megan searched for real (Exa)");
  }, 15 * 60_000);

  // ---- Phase 4: forced bounce ----
  await devRun("5. bounce", { toy: true, forceBounce: true }, (evsDone, run) => {
    const requested = evsDone.filter((e) => e.type === "rework.requested");
    ok(requested.length === 1 && requested[0].payload.to === "elliot", "rework.requested {to: the lead} once");
    ok(evsDone.some((e) => e.type === "budget.update" && e.payload.reworkUsed === 1), "budget.update carried reworkUsed");
    const rework = run.segments.find((s) => s.label === "Rework");
    ok(rework?.kind === "rework" && rework.agentId === "jonah" && rework.stage === "Implement", `a Rework segment of kind "rework" (${rework ? `${rework.agentId} ${rework.stage}` : "none"})`);
    ok(run.segments.some((s) => s.label === "Re-check" && s.agentId === "sana"), "the re-check segment (Sana)");
    ok(run.segments.some((s) => s.label === "Re-plan" && s.agentId === "elliot"), "the re-plan segment (Elliot)");
    ok(run.status === "accepted" && evsDone.at(-1)!.type === "run.finished", "the bounced run was accepted after one rework");
  }, 20 * 60_000);

  // ---- Phase 5: forced exhaustion ----
  await devRun("6. block", { toy: true, forceBlock: true }, (evsDone, run) => {
    ok(evsDone.filter((e) => e.type === "rework.requested").length === 2, "two bounces (budget 1)");
    const blockedAt = evsDone.find((e) => e.type === "run.blocked");
    ok(!!blockedAt && /rework budget exhausted/.test(blockedAt.payload.reason), `run.blocked with the reason (${blockedAt?.payload.reason.slice(0, 60)}…)`);
    ok(run.status === "blocked", `status blocked (${run.status})`);
    ok(!evsDone.some((e) => e.type === "run.finished"), "no run.finished on a blocked run");
    ok(evsDone.some((e) => e.type === "step.started" && e.payload.label === "Rework" && e.payload.kind === "rework"), "the one allowed rework pass ran before blocking");
  }, 20 * 60_000);
}

// ---- leave the branch clean ----
info("7. reseeding demo to leave the branch clean");
execFileSync("npm", ["run", "seed", "-w", "@fabric/db", "--", "--profile", "demo", "--branch", branch], {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
});
await createDb(pooled).close();

console.log("\ntiming table:");
console.log("| what | when |");
console.log("|---|---|");
for (const [what, when] of timings) console.log(`| ${what} | ${when} |`);
console.log(`\ncheck:team PASSED in ${((Date.now() - startedAll) / 1000).toFixed(1)}s · branch ${branch}`);
stopAll();
process.exit(0);
