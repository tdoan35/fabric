#!/usr/bin/env node
// npm run check:data [-- [--speed 6] [--port 8890] [--branch demo]]
//
// DATA's re-runnable end-to-end check (§7.0 step 1). Everything runs against the `demo` Neon
// branch by default; production is never touched. Steps:
//   1. seed demo on the branch
//   2. start the server (its own port) + `npm run sim` (a live run, first ~60 s of the recording)
//   3. read the SSE tail (S8: arrival within 1 s of the event's due time, from Node, Origin app://fabric)
//   4. POST /splice {t}
//   5. GET events → the merged log
//   6. POST /finalize-splice twice (idempotent)
//   7. assert: report attached, run.finished emitted, a Weave result item exists, and
//      task.changed / weave.changed / session.message arrived on /api/stream
//   8. closed run: splice while sim is still emitting — late live events must not leak
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const bundle = require("../packages/fixtures/src/recordings/ngram-135m.json");

const NEON_PROJECT = "solitary-meadow-39146227";
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const branch = arg("branch", "demo");
const port = Number(arg("port", "8890"));
const speed = Number(arg("speed", "6"));
const base = `http://localhost:${port}`;

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
};
const assert = (cond, msg) => (cond ? console.log(`  ✓ ${msg}`) : fail(msg));

// Never print these: the neon CLI writes credentials to stdout.
const branchUrl = (pooled) =>
  execFileSync("neon", ["connection-string", "--project-id", NEON_PROJECT, "--branch", branch, ...(pooled ? ["--pooled"] : [])], {
    encoding: "utf8",
  }).trim().split("\n").pop().trim();

const pooled = branchUrl(true);
const startedAll = Date.now();
const procs = [];
const stopAll = () => {
  for (const p of procs) p.kill("SIGTERM");
};
process.on("exit", stopAll);
process.on("SIGINT", () => { stopAll(); process.exit(130); });

const run = (cmd, args, env = {}) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    procs.push(p);
    const out = [];
    p.stdout.on("data", (c) => out.push(c.toString()));
    p.stderr.on("data", (c) => out.push(c.toString()));
    p.on("error", reject);
    p.on("exit", (code) => resolve({ code, output: out.join("") }));
  });

console.log(`1. seeding demo on branch ${branch} …`);
const seed = await run("npm", ["run", "seed", "-w", "@fabric/db", "--", "--profile", "demo", "--branch", branch]);
if (seed.code !== 0) throw new Error(`seed failed:\n${seed.output}`);
console.log(`   ${seed.output.trim().split("\n").pop()}`);

console.log("2. starting server + sim …");
const server = spawn("npx", ["tsx", "apps/server/src/index.ts"], {
  env: { ...process.env, DATABASE_URL: pooled, PORT: String(port), NEON_BRANCH: branch },
  stdio: ["ignore", "pipe", "inherit"],
});
procs.push(server);
let serverLogs = "";
server.stdout.on("data", (c) => { serverLogs += c.toString(); });
for (let i = 0; i < 50; i++) {
  try {
    const r = await fetch(`${base}/api/health`);
    if (r.ok) break;
  } catch {}
  if (i === 49) throw new Error(`server never became healthy:\n${serverLogs}`);
  await new Promise((r) => setTimeout(r, 200));
}

const tmp = mkdtempSync(path.join(tmpdir(), "fabric-check-"));
const runfile = path.join(tmp, "run.json");
const simEnv = { DATABASE_URL: pooled, NEON_BRANCH: branch, DEMO_RECORDING_KEY: "ngram-135m" };
const simPromise = run("npx", ["tsx", "scripts/sim-run.ts", "--speed", String(speed), "--runfile", runfile], simEnv);
let runId;
for (let i = 0; i < 50; i++) {
  try {
    runId = JSON.parse(readFileSync(runfile, "utf8")).runId;
    break;
  } catch {}
  await new Promise((r) => setTimeout(r, 200));
}
if (!runId) throw new Error("sim never wrote its runfile");

console.log(`3. tailing ${base}/api/runs/${runId}/stream (Origin app://fabric) …`);
const runStream = await fetch(`${base}/api/runs/${runId}/stream`, { headers: { Origin: "app://fabric", Accept: "text/event-stream" } });
const runReader = runStream.body.getReader();
const appStream = await fetch(`${base}/api/stream`, { headers: { Origin: "app://fabric", Accept: "text/event-stream" } });
const appReader = appStream.body.getReader();

const appEvents = [];
const pumpApp = (async () => {
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await appReader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      const data = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (!data) continue;
      try { appEvents.push({ at: Date.now(), event: JSON.parse(data.slice(6)) }); } catch {}
    }
  }
})();

const readUntilFrom = (reader, label) => async (predicate, timeoutMs) => {
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { done, value } = await Promise.race([
      reader.read(),
      new Promise((r) => setTimeout(() => r({ done: false, value: undefined }), Math.max(0, deadline - Date.now()))),
    ]);
    if (done) break;
    if (!value) continue;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      const evLine = chunk.split("\n").find((l) => l.startsWith("event: run"));
      const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (evLine && dataLine) {
        const arrival = { at: Date.now(), event: JSON.parse(dataLine.slice(6)) };
        if (predicate(arrival)) return arrival;
      }
    }
  }
  throw new Error(`${label}: predicate not met within ${timeoutMs} ms`);
};
const readUntil = readUntilFrom(runReader, "run stream");

const simStart = Date.now();
const sim = await simPromise;
if (sim.code !== 0) throw new Error(`sim failed:\n${sim.output}`);
console.log(`   ${sim.output.trim().split("\n").pop()}`);

// S8: a sim-emitted event must arrive on the tail within 1 s of its due time.
const s8 = await readUntil((a) => a.event.type === "tool.result" && a.event.payload?.line === "baseline harness ready", 10_000);
if (!s8) {
  fail("S8: the t=41 terminal line never arrived on the run stream");
} else {
  // simStart is read when the runfile appears (startRun + ~ε before replay), so the event's due
  // time is simStart + 41 s / speed; the tail must deliver within 1 s of that.
  const due = simStart + (41 * 1000) / speed;
  const latency = s8.at - due;
  console.log(`   S8: arrived ${latency} ms after due time (${latency <= 1000 ? "within" : "OUTSIDE"} the 1 s budget)`);
  assert(latency <= 1000 && latency > -2000, "S8: event on /api/runs/:id/stream within 1 s (Origin app://fabric)");
}

console.log("4. POST /splice {t: 60} …");
const splice = await fetch(`${base}/api/runs/${runId}/splice`, {
  method: "POST",
  headers: { "content-type": "application/json", Origin: "app://fabric" },
  body: JSON.stringify({ t: 60 }),
});
if (!splice.ok) throw new Error(`splice failed: ${splice.status} ${await splice.text()}`);
const spliced = await splice.json();

console.log("5. GET events → merged log …");
const events = await (await fetch(`${base}/api/runs/${runId}/events`)).json();
const seqs = events.map((e) => e.seq);
assert(events.length === spliced.events.length, `merged log returned (${events.length} events)`);
assert(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), "seqs strictly increase across the splice");
assert(events.every((e) => e.runId === runId), "recording events re-stamped with the live run's id");
assert(events.some((e) => e.t > 11_000), "the recording's tail (t ≈ 3 h) is present");
assert(events.filter((e) => e.type === "run.finished").length === 0, "no run.finished before finalize");
assert(spliced.run.recording?.key === "ngram-135m" && spliced.run.recording.spliceT === 60, "run.recording set with spliceT");

console.log("6. POST /finalize-splice (twice) …");
const fin1 = await fetch(`${base}/api/runs/${runId}/finalize-splice`, { method: "POST", headers: { Origin: "app://fabric" } });
const fin2 = await fetch(`${base}/api/runs/${runId}/finalize-splice`, { method: "POST", headers: { Origin: "app://fabric" } });
const fin1Body = await fin1.json();
const fin2Body = await fin2.json();
assert(fin1.ok && fin2.ok && fin1Body.reportId === fin2Body.reportId, `finalize idempotent (report ${fin1Body.reportId})`);

console.log("7. assertions …");
const finalRun = await (await fetch(`${base}/api/runs/${runId}`)).json();
assert(finalRun.reportId === fin1Body.reportId, "report attached to the run");
assert(finalRun.status === "accepted", `final status accepted (got ${finalRun.status})`);
const finalEvents = await (await fetch(`${base}/api/runs/${runId}/events`)).json();
const finished = finalEvents[finalEvents.length - 1];
assert(finished.type === "run.finished" && finished.payload.reportId === fin1Body.reportId, "run.finished is the merged log's last event");
const report = await (await fetch(`${base}/api/reports/${fin1Body.reportId}`)).json();
assert(report.id === fin1Body.reportId && report.summary.length > 0, `report served (kind ${report.kind})`);
const weave = await (await fetch(`${base}/api/weave`)).json();
assert(weave.items.some((i) => i.kind === "result" && i.reportId === fin1Body.reportId), "Weave result item exists");
const seen = (type) => appEvents.some((a) => a.event.type === type);
assert(seen("task.changed"), "task.changed arrived on /api/stream");
assert(seen("weave.changed"), "weave.changed arrived on /api/stream");
assert(appEvents.some((a) => a.event.type === "session.message" && a.event.sessionId), "session.message arrived on /api/stream");

// ---- closed-run case: splice while sim is still emitting (speed 1, splice at ~t=22) ----
console.log("8. closed run: splice mid-emission (speed 1) …");
const runfile2 = path.join(tmp, "run2.json");
const sim2Promise = run("npx", ["tsx", "scripts/sim-run.ts", "--speed", "1", "--runfile", runfile2], simEnv);
let runId2;
for (let i = 0; i < 50; i++) {
  try {
    runId2 = JSON.parse(readFileSync(runfile2, "utf8")).runId;
    break;
  } catch {}
  await new Promise((r) => setTimeout(r, 200));
}
if (!runId2) throw new Error("sim (speed 1) never wrote its runfile");
const stream2 = await fetch(`${base}/api/runs/${runId2}/stream`, { headers: { Origin: "app://fabric", Accept: "text/event-stream" } });
const reader2 = stream2.body.getReader();
const read2 = readUntilFrom(reader2, "run stream 2");
await read2((a) => a.event.t >= 19, 40_000); // wall ≈ t at speed 1
const spliceT = 22;
const splice2 = await fetch(`${base}/api/runs/${runId2}/splice`, {
  method: "POST",
  headers: { "content-type": "application/json", Origin: "app://fabric" },
  body: JSON.stringify({ t: spliceT }),
});
if (!splice2.ok) throw new Error(`mid-emission splice failed: ${splice2.status} ${await splice2.text()}`);
const sim2 = await sim2Promise;
assert(sim2.code === 0 && sim2.output.includes("sim: run spliced, stopping"), "sim exits 0 with 'run spliced, stopping' once the run closes");
await fetch(`${base}/api/runs/${runId2}/finalize-splice`, { method: "POST", headers: { Origin: "app://fabric" } });
const merged2 = await (await fetch(`${base}/api/runs/${runId2}/events`)).json();
// jsonb roundtrips don't preserve JSON key order; canonicalize before comparing payloads.
const stable = (v) => (Array.isArray(v) ? v.map(stable) : v && typeof v === "object"
  ? Object.fromEntries(Object.entries(v).map(([k, val]) => [k, stable(val)]).sort((a, b) => a[0].localeCompare(b[0])))
  : v);
const key = (e) => `${e.t}|${e.type}|${JSON.stringify(stable(e.payload))}`;
const recTail = new Set(bundle.events.filter((e) => e.t > spliceT && e.type !== "run.finished").map(key));
const after = merged2.filter((e) => e.t > spliceT);
assert(after.every((e) => e.type === "run.finished" || recTail.has(key(e))), "no live events after splice_t other than run.finished");
assert(after.length === recTail.size + 1, `tail is exactly the recording's + finalize's run.finished (${after.length} events)`);
assert(merged2[merged2.length - 1].type === "run.finished", "run.finished closes the merged log");
reader2.cancel();

console.log(`done in ${((Date.now() - startedAll) / 1000).toFixed(1)}s · branch ${branch} · run ${runId}`);
