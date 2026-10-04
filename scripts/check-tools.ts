#!/usr/bin/env node
// npm run check:tools [-- [--branch demo] [--port 8893]]
//
// TOOLS' end-to-end check (§7.0 step 6), against real services, sequential: Sprites (S2), Exa
// (S7) and AgentMail (S5), each through toolsFor with a real RunWriter on a scratch run on the
// demo branch. Events are read back through GET /api/runs/:id/events (a server this script
// starts), and it ends with a latency table. Never prints connection strings or keys. No email is
// sent: sendReportEmail is covered by unit tests with a mocked client.
import { execFileSync, spawn } from "node:child_process";
import { agentMailClient, createInbox, exaSearch, execInSprite, spriteFileReader, spritesClient, toolsFor } from "@fabric/integrations";
import { createDb, createRunWriterWith, loadRootEnv, provisionTeam, readRegistry, sql } from "@fabric/db";
import type { Db, RunWriter } from "@fabric/db";
import { myProfiles, profileById } from "@fabric/fixtures/studio";
import { studioTeams } from "@fabric/fixtures/teams";

const NEON_PROJECT = "solitary-meadow-39146227";

loadRootEnv();
const args = process.argv.slice(2);
const value = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const branch = value("branch", "demo");
const port = Number(value("port", "8893"));
const base = `http://localhost:${port}`;

const ok = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(`✗ ${msg}`);
  console.log(`  ✓ ${msg}`);
};
const info = (msg: string) => console.log(msg);
const ms = (t0: number) => `${Date.now() - t0} ms`;

/** The neon CLI prints credentials; capture, never echo. */
const branchUrl = () =>
  execFileSync("neon", ["connection-string", "--project-id", NEON_PROJECT, "--branch", branch, "--pooled"], {
    encoding: "utf8",
  }).trim().split("\n").pop()!.trim();

// ---- server lifecycle (detached + group kill, like check-chat) ----
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
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server never came up on ${base}:\n${logs.slice(-2000)}`);
};

const agentMailInboxCount = async (): Promise<number> => {
  const list = await agentMailClient().inboxes.list({ limit: 100 });
  return list.inboxes.length;
};

// =====================================================================================
const pooled = branchUrl();
const startedAll = Date.now();
const latencies: [string, string, string][] = [];

info(`1. seeding demo on branch ${branch} …`);
execFileSync("npm", ["run", "seed", "-w", "@fabric/db", "--", "--profile", "demo", "--branch", branch], {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
});
await startServer(pooled);

const db: Db = createDb(pooled);
const writer: RunWriter = createRunWriterWith(db);
const events: { type: string; actorAgentId?: string; payload: any }[] = [];
const hooked: RunWriter = new Proxy(writer, {
  get(target, prop, recv) {
    if (prop !== "emit") return Reflect.get(target, prop, recv);
    return async (runId: string, type: never, actor: string | undefined, payload: never) => {
      const e = await writer.emit(runId, type, actor, payload);
      events.push({ type: e.type, actorAgentId: e.actorAgentId, payload: e.payload });
      return e;
    };
  },
});


// Raw SDK timings, no tool layer: cold start (attach + policy + boot + exec) and a warm exec.
const coder = spritesClient().sprite(process.env.SPRITE_CODER ?? "fabric-coder");
let raw = Date.now();
await execInSprite(coder, "true");
const rawCold = Date.now() - raw;
raw = Date.now();
await execInSprite(coder, "echo warm-raw");
const rawWarm = Date.now() - raw;
info("2. scratch run on the demo branch, through toolsFor with a real RunWriter");
const task = await hooked.createTask({ projectId: "engram", teamId: "product", title: "check:tools scratch run" });
const run = await hooked.startRun(task.id, {
  tokens: 60,
  objective: "check:tools — real Sprites, Exa and AgentMail through the tool registry",
  constraints: [], criteria: [], preferences: [],
  stayed: ["Your chat with Dana", "Dana's memory of you", "Your other threads and projects"],
}, { costUsd: 1, timeS: 600, rework: 1 });

const registry = await readRegistry(db);
const jonah = registry.agents.find((a) => a.agent.id === "jonah")!;
const megan = registry.agents.find((a) => a.agent.id === "megan")!;
const tctx = { runId: run.id, step: "Prepare", writer: hooked, db };
const jonahTools = toolsFor(jonah, tctx).tools;
const meganTools = toolsFor(megan, tctx).tools;

// ---- S2: sprite.exec streams, file round trip, blocked egress ----
info("3. S2 · sprite.exec (Jonah, SPRITE_CODER)");
let t0 = Date.now();
const cold = await jonahTools.sprite_exec!.execute!({ command: "python3 --version && uv --version" }, {} as never) as any;
latencies.push(["S2 cold exec (attach + policy + boot + run)", ms(t0), `exit ${cold.exitCode}`]);
latencies.push(["S2 raw cold start (SDK only, no tool layer)", `${rawCold} ms`, "true"]);
latencies.push(["S2 raw warm exec (SDK only)", `${rawWarm} ms`, "echo"]);
ok(cold.ok === true, `cold exec ran (exit ${cold.exitCode})`);
ok(/Python 3\.13/.test(cold.tail) && /uv 0\./.test(cold.tail), "python and uv versions in the tail");
ok(events.some((e) => e.type === "tool.call" && e.payload.tool === "sprite.exec" && e.actorAgentId === "jonah"), "tool.call {tool: sprite.exec} emitted");
ok(events.some((e) => e.type === "tool.result" && e.payload.kind === "term" && e.payload.line.startsWith("$ python3")), "terminal echo streamed as tool.result");

t0 = Date.now();
const warm = await jonahTools.sprite_exec!.execute!({ command: "for i in 1 2 3; do echo \"check $i/3\"; sleep 0.4; done" }, {} as never) as any;
latencies.push(["S2 warm exec (3-line loop)", ms(t0), `exit ${warm.exitCode}`]);
const loopLines = events.filter((e) => e.type === "tool.result" && /^check [123]\/3$/.test(e.payload.line ?? ""));
ok(loopLines.length === 3, "the loop's three lines streamed, line-buffered");

const wres = await jonahTools.workspace_write!.execute!({ path: "tools-check.md", content: "# check:tools\n\nround trip\n" }, {} as never) as any;
ok(wres.ok === true, "workspace.write wrote into the sandbox");
const readBack = await spriteFileReader("jonah")!("tools-check.md");
ok(readBack === "# check:tools\n\nround trip\n", "file round trip via the read helper");

const blockedEgress = await jonahTools.sprite_exec!.execute!({ command: "curl -sS --max-time 8 https://example.com/ >/dev/null; true" }, {} as never) as any;
const egressDenied = events.find((e) => e.type === "tool.denied" && e.payload.tool === "network.fetch" && e.payload.target === "example.com");
ok(!!egressDenied, "blocked egress from inside the Sprite surfaced as tool.denied {network.fetch, example.com}");
ok(egressDenied?.payload.reason === "not on the egress list", "denied with the egress reason");

// ---- policies: blocked and approval-only ----
info("4. policies · blocked and approval-only tools are denied");
const blockedTool = await jonahTools.network_fetch!.execute!({ url: "https://files.example.org/pkg.tar.gz" }, {} as never) as any;
ok(blockedTool.ok === false, "Jonah's network.fetch (policy: blocked) returned an error to the model");
ok(events.some((e) => e.type === "tool.denied" && e.payload.tool === "network.fetch" && e.payload.target === "files.example.org"), "…and emitted tool.denied");
const sanaTools = toolsFor(profileById("sana"), tctx).tools;
const approvalTool = await sanaTools.agentmail_send!.execute!({ to: "someone@example.org", subject: "s", text: "t" }, {} as never) as any;
ok(approvalTool.ok === false && /needs approval/.test(approvalTool.error), "Sana's agentmail.send (policy: approval) denied with 'needs approval'");
ok(events.some((e) => e.type === "tool.denied" && e.payload.reason === "needs approval"), "…and emitted tool.denied {needs approval}");

// ---- S7: exa.search, timing, cache fallback ----
info("5. S7 · exa.search (Megan)");
t0 = Date.now();
const search = await meganTools.exa_search!.execute!({ query: "engram conditional memory n-gram lookup", fast: true }, {} as never) as any;
latencies.push(["S7 exa.search · fast", ms(t0), `${search.count} results`]);
ok(search.ok === true && search.count >= 5, `fast search returned ${search.count} results`);
ok(events.some((e) => e.type === "agent.message" && e.actorAgentId === "megan" && /exa\.search “.*” · fast/.test(e.payload.text)), "narration line 1 like the mock's");
ok(events.some((e) => e.type === "agent.message" && e.actorAgentId === "megan" && /\d+ results · \d+ highlights kept/.test(e.payload.text)), "narration line 2 like the mock's");
const down = { search: async () => { throw new Error("exa down"); } } as never;
const cached = await exaSearch("engram conditional memory n-gram lookup", true, down);
ok(cached.cached === true && cached.results.length > 0, "cache fallback served the last results, labelled cached");

// ---- artifacts ----
info("6. artifacts · write (Megan) and read (Jonah) through the run's artifact store");
const aw = await meganTools.artifacts_write!.execute!({ name: "check-survey.md", content: "# Survey\n\nby check:tools\n" }, {} as never) as any;
ok(aw.ok === true && !!aw.artifactId, "artifacts.write saved and returned the artifact id");
const ar = await jonahTools.artifacts_read!.execute!({ name: "check-survey.md" }, {} as never) as any;
ok(ar.ok === true && ar.text?.includes("by check:tools"), "artifacts.read read it back by name");
const list = await jonahTools.artifacts_read!.execute!({}, {} as never) as any;
ok(list.ok === true && list.names.includes("check-survey.md"), "artifacts.read lists the run's artifacts");

// ---- S5: AgentMail createInbox, idempotent, recorded (CARD-3 chain) ----
info("7. S5 · AgentMail createInbox (Sana) — idempotent, recorded in the registry");
const team = studioTeams.find((t) => t.id === "research")!;
const templates = Object.fromEntries(team.members.map((m) => [m.agentId, myProfiles.find((p) => p.agent.id === m.agentId)]).filter(([, p]) => p));
await provisionTeam(db, { team, templates, origin: "Created by check:tools" });
let published = 0;
const addr1 = await createInbox("sana", { db, publish: () => { published++; } });
const afterFirst = await agentMailInboxCount();
const addr2 = await createInbox("sana", { db, publish: () => { published++; } });
const afterSecond = await agentMailInboxCount();
ok(addr1 === addr2 && addr1 === "sana-fabric@agentmail.to", `createInbox is idempotent (${addr1})`);
ok(afterFirst === afterSecond, `one inbox on the account, not two (${afterSecond} total)`);
ok(published === 2, "registry.changed published after each update");
const sanaRow = (await db.db.execute(sql`select workspace->'connectors' as connectors from agents where id = 'sana'`)).rows[0] as { connectors: { name: string; note: string; status: string }[] };
const entry = sanaRow.connectors.find((c) => c.name === "AgentMail")!;
ok(entry.status === "connected" && entry.note === addr1, "the connector row carries the address (no schema change)");
const reg = await (await fetch(`${base}/api/registry`)).json() as { agents: { agent: { id: string }; inbox?: string }[] };
ok(reg.agents.find((a) => a.agent.id === "sana")?.inbox === addr1, "GET /api/registry serves it as inbox (CARD-3)");

// ---- events read back through the API ----
info("8. reading the run's events back through GET /api/runs/:id/events");
const apiEvents = (await (await fetch(`${base}/api/runs/${run.id}/events`)).json()) as { type: string; payload: any }[];
for (const type of ["tool.call", "tool.result", "tool.denied", "agent.message", "artifact.created"]) {
  ok(apiEvents.some((e) => e.type === type), `${type} present in the API event log`);
}
ok(apiEvents.some((e) => e.type === "artifact.created" && e.payload.artifactId === aw.artifactId), "artifact.created carries the artifact id");
ok(apiEvents.filter((e) => e.type === "tool.call").every((e) => !e.payload.tool.includes("_")), "event tool names are canonical (dotted), not provider keys");
await hooked.end(run.id, "stopped", "check:tools scratch run");

// ---- leave the branch clean ----
info("9. reseeding demo to leave the branch clean");
execFileSync("npm", ["run", "seed", "-w", "@fabric/db", "--", "--profile", "demo", "--branch", branch], {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
});
await db.close();
stopAll();

console.log("\nlatency table:");
console.log("| what | time | note |");
console.log("|---|---|---|");
for (const [what, time, note] of latencies) console.log(`| ${what} | ${time} | ${note} |`);
console.log(`\ncheck:tools PASSED in ${((Date.now() - startedAll) / 1000).toFixed(1)}s · branch ${branch}`);
process.exit(0);
