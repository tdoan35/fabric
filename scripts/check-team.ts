#!/usr/bin/env node
// npm run check:team [-- [--branch demo] [--port 8895] [--skip-toy]]
//
// TEAM's end-to-end check (§7.0 step 7), sequential on the Spark lane, against a server this
// script starts on the demo branch. Never prints connection strings or keys.
// The fixture-chat phases retired with S14 (the recorded-run splice lives in
// check-data's sim); what remains is the real team workflow through the dev route:
//
//   1. a toy run end to end: accepted, review.verdict, criterion.checked, a finalized report
//   2. forced bounce: rework.requested → a Rework segment of kind "rework" → Re-check → accept
//   3. forced exhaustion (budget 1, two bounces): run.blocked, status blocked
//   Ends with a timing table, then reseeds demo to leave it clean.
import { execFileSync, spawn } from "node:child_process";
import { createDb } from "@fabric/db";

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
