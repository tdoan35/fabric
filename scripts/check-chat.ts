#!/usr/bin/env node
// npm run check:chat [-- [--live] [--times 5] [--port 8891] [--branch demo]]
//
// DANA's re-runnable end-to-end check (§7.0 step 4), against a server on the demo branch.
// Never prints connection strings or keys. Fixture mode walks every branch of the scripted
// conversation (idea → approvals → handoff → splice → results → reload; decline and discuss for
// both cards; re-proposal superseding), re-seeding between phases so "nothing exists before
// approval" is asserted from a clean world each time. --live --times N replays the happy path
// against the real model lane, sequentially (the lane takes 8 concurrent requests), asserting
// tool names, order and DB state — never phrasing — and recording per-turn latency.
import { execFileSync, spawn } from "node:child_process";
import { createDb, sql } from "@fabric/db";
import { IDEA_PROMPT } from "@fabric/fixtures/chat";

const NEON_PROJECT = "solitary-meadow-39146227";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const live = flag("live");
const times = Number(value("times", "5"));
const branch = value("branch", "demo");
const port = Number(value("port", "8891"));
const base = `http://localhost:${port}`;

let serverLogs = "";
let lastParts = "";
const ok = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(`✗ ${msg}\n  last parts: ${lastParts}\n  server (tail): ${serverLogs.slice(-1500)}`);
  console.log(`  ✓ ${msg}`);
};
const info = (msg: string) => console.log(msg);

/** The neon CLI prints credentials; capture, never echo. */
const branchUrl = (pooled: boolean) =>
  execFileSync("neon", ["connection-string", "--project-id", NEON_PROJECT, "--branch", branch, ...(pooled ? ["--pooled"] : [])], {
    encoding: "utf8",
  }).trim().split("\n").pop()!.trim();

/** The seed takes ~9 s, long enough for the server to close idle keep-alive sockets. */
const warm = async () => { await fetch(`${base}/api/health`).catch(() => {}); };

const seed = async () => {
  execFileSync("npm", ["run", "seed", "-w", "@fabric/db", "--", "--profile", "demo", "--branch", branch], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  await warm();
};

// ---- server lifecycle (detached + group kill, like check-data) ----
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
  server.stdout!.on("data", (c) => { logs += c.toString(); serverLogs = logs; });
  server.stderr!.on("data", (c) => { logs += c.toString(); serverLogs = logs; });
  server.on("exit", (code) => { if (code !== 0 && code !== null) console.error(`server exited ${code}:
${logs.slice(-3000)}`); });
  for (let i = 0; i < 60; i++) {
    if (await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server never came up on ${base}:\n${logs.slice(-2000)}`);
};

// ---- chat helpers ----

interface Part { type: string; text?: string; toolCallId?: string; toolName?: string; args?: any; result?: any }
interface Message { id: string; role: string; content: Part[] }

const post = async (path: string, body: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "app://fabric" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
};

/**
 * When each piece of a turn first reached the client, in ms from the POST: the disposition chip,
 * the first text, the card (a propose_* part) or the handoff (with its result), and the stream end.
 */
interface Timing { disposition?: number; text?: number; card?: number; done: number; notes?: string }

/** One turn: returns the final cumulative snapshot, how long the turn took end to end, and its timing. */
async function turn(sessionId: string, messages: unknown[], fixture: boolean): Promise<{ parts: Part[]; ms: number; timing: Timing }> {
  const started = Date.now();
  const logsBefore = serverLogs.length;
  const res = await post("/api/chat", { sessionId, messages, ...(fixture ? { fixture: true } : {}) });
  const timing: Timing = { done: 0 };
  const mark = (key: Exclude<keyof Timing, "done">, seen: boolean) => {
    if (seen && timing[key] === undefined) timing[key] = Date.now() - started;
  };
  let parts: Part[] = [];
  let buf = "";
  for await (const chunk of res.body!) {
    buf += Buffer.from(chunk as Uint8Array).toString();
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const snapshot = JSON.parse(line) as { content: Part[] };
      if (Array.isArray(snapshot.content)) {
        parts = snapshot.content;
        lastParts = JSON.stringify(parts.map((p) => ({ t: p.type, n: p.toolName, r: p.result !== undefined })));
        mark("disposition", parts.some((p) => p.toolName === "record_disposition"));
        mark("text", parts.some((p) => p.type === "text" && !!p.text));
        mark("card", parts.some((p) => p.toolName === "propose_team" || p.toolName === "propose_specialist" || (p.toolName === "handoff_to_team" && p.result !== undefined)));
      }
    }
  }
  timing.done = Date.now() - started;
  // What the server said about this turn: retries, unusable input, failed tools (the timing's why).
  const notes = serverLogs.slice(logsBefore).split("\n").filter((l) => /^\[assistant\]/.test(l) && !/not implemented yet/.test(l))
    .map((l) => l.replace(/^\[assistant\]\s*/, "").replace(/ for live-\d+/, "").replace(/\|/g, "/").slice(0, 90));
  if (notes.length) timing.notes = notes.join("; ");
  return { parts, ms: timing.done, timing };
}
const userMsg = (text: string) => ({ role: "user", content: [{ type: "text", text }] });

/** The thread as the web runtime would send it after deciding a card: history + the result stamped on. */
async function decide(sessionId: string, toolName: string, decision: string): Promise<unknown[]> {
  const history = (await (await fetch(`${base}/api/sessions/${sessionId}/messages`)).json()) as { messages: Message[] };
  const last = history.messages[history.messages.length - 1];
  const part = last.content.find((p) => p.toolName === toolName);
  if (!part) throw new Error(`no ${toolName} card in the last message of ${sessionId}`);
  return history.messages.map((m) =>
    m.id === last.id ? { ...m, content: m.content.map((p) => (p === part ? { ...p, result: { decision } } : p)) } : m,
  );
}

const toolPart = (parts: Part[], name: string) => parts.find((p) => p.toolName === name);

// ---- db assertions ----
const q = async (pooled: string, text: string): Promise<Record<string, string>[]> => {
  const db = createDb(pooled);
  const rows = (await db.db.execute(sql.raw(text))).rows as Record<string, string>[];
  await db.close();
  return rows;
};

/** The ordering every turn must have: disposition first, a card/handoff last, text between.
 * Live phrasing varies (per the brief): only fixture turns assert the prose. */
function assertTurnShape(parts: Part[], lastTool: string, msg: string, requireText = true) {
  ok(parts[0]?.toolName === "record_disposition" && parts[0].result?.recorded === true, `${msg}: record_disposition is first, with its result`);
  ok(parts[parts.length - 1]?.toolName === lastTool, `${msg}: the turn ends on ${lastTool}`);
  if (requireText) ok(parts.some((p) => p.type === "text" && p.text), `${msg}: carries text`);
  ok(!parts.some((p) => p.toolName === "search_registry"), `${msg}: search_registry never streamed`);
}

/** JSON with sorted keys: jsonb reorders object keys, so stored and streamed payloads compare by value. */
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

/**
 * The card is the team (DANA, card == creation): the approved card's workflow, criteria, rework
 * budget and roster are exactly the created team's rows, and the stored proposal payload is the card
 * that streamed.
 */
async function assertCardIsTeam(pooled: string, card: any, msg: string) {
  const [team] = await q(pooled, `select id, workflow, criteria, rework_budget from teams where lower(name) = lower('${card.name.replace(/'/g, "''")}')`) as any[];
  ok(!!team, `${msg}: the team the card names exists`);
  const members = (await q(pooled, `select agent_id from team_members where team_id = '${team.id}' order by ord`)).map((r) => r.agent_id);
  const stages = (w: any[]) => JSON.stringify(w.map((s) => ({ label: s.label, agentIds: s.agentIds, gate: !!s.gate })));
  ok(stages(card.workflow ?? []) === stages(team.workflow), `${msg}: the card's workflow is the created team's (${team.workflow.length} stages)`);
  ok(JSON.stringify(card.criteria) === JSON.stringify(team.criteria), `${msg}: the card's criteria are the created team's`);
  ok(Number(card.reworkBudget) === Number(team.rework_budget), `${msg}: the card's rework budget is the created team's (${team.rework_budget})`);
  ok(card.roster.map((r: any) => r.agentId).join() === members.join(), `${msg}: the card's roster is the created members (${members.join(", ")})`);
  const [stored] = await q(pooled, `select payload from proposals where payload->>'proposalId' = '${card.proposalId}'`) as any[];
  ok(canon(stored?.payload) === canon(card), `${msg}: the stored proposal payload is the card that streamed`);
}

// ---- the app event stream (asserts land as they arrive) ----
const appEvents: { event: { type: string; sessionId?: string; messageId?: string; runId?: string; taskId?: string } }[] = [];
const pumpApp = async () => {
  const res = await fetch(`${base}/api/stream`, { headers: { Accept: "text/event-stream" } });
  const reader = res.body!.getReader();
  let buf = "";
  (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += Buffer.from(value as Uint8Array).toString();
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!data) continue;
        try { appEvents.push({ event: JSON.parse(data.slice(6)) }); } catch { /* not json */ }
      }
    }
  })();
};
const saw = (type: string) => appEvents.some((a) => a.event.type === type);

// =====================================================================================
const pooled = branchUrl(true);
const startedAll = Date.now();

info(`1. seeding demo on branch ${branch} …`);
await seed();
await startServer(pooled);
await pumpApp();
const latencies: string[] = [];

// ---- Phase A: the happy path, fixture mode, through splice + finalize + reload ----
{
  info("2. fixture · idea → propose_team (nothing created yet)");
  const t1 = await turn("c1", [userMsg(IDEA_PROMPT)], true);
  latencies.push(`fixture idea ${t1.ms} ms`);
  assertTurnShape(t1.parts, "propose_team", "idea turn");
  const card = toolPart(t1.parts, "propose_team")!.args;
  ok(card.kind === "team" && card.name === "Research Team", "the card proposes the Research Team");
  ok(Array.isArray(card.roster) && card.roster.map((r: any) => r.agentId).join() === "elliot,megan,jonah,carlos", "roster: real persona ids, lead first");
  ok(card.roster[0].status === "new" && card.roster[0].name === "Elliot" && card.roster[0].role === "Research Lead" && !!card.roster[0].avatar, "the new lead is the Elliot persona with role and portrait (D1)");
  ok(card.workflow?.length === 6 && card.criteria?.length === 4 && card.reworkBudget === 2 && card.leadDefaults?.length >= 3, "CARD-1 fields: workflow, criteria, rework budget, lead defaults");
  ok(typeof card.proposalId === "string" && card.proposalId.startsWith("prop-"), "the card carries its proposalId");
  ok(toolPart(t1.parts, "propose_team")!.result === undefined, "propose_team streams without a result (human tool)");
  const rows = await q(pooled, "select count(*) as n from teams where id = 'research'");
  ok(rows[0].n === "0", "no team row before approval");
  const elliot = await q(pooled, "select count(*) as n from agents where id in ('elliot','sana')");
  ok(elliot[0].n === "0", "neither Elliot nor Sana exists yet");
  const props = await q(pooled, "select status, tool_call_id, payload->>'proposalId' as pid from proposals");
  ok(props.length === 1 && props[0].status === "pending" && !!props[0].tool_call_id && props[0].pid === card.proposalId, "a pending proposals row, keyed by toolCallId");
  const disp = await q(pooled, "select disposition, considered from dispositions");
  ok(disp[0].disposition === "propose_team" && Array.isArray(disp[0].considered) && disp[0].considered.length > 0, "the disposition row stores considered[] (CHAT-13)");
  ok(saw("registry.changed"), "registry.changed announced the new session");

  info("3. fixture · approve → the team, Elliot, the org slot and edge; propose_specialist");
  const t2 = await turn("c1", await decide("c1", "propose_team", "approved"), true);
  latencies.push(`fixture approve-team ${t2.ms} ms`);
  assertTurnShape(t2.parts, "propose_specialist", "team approved");
  const spec = toolPart(t2.parts, "propose_specialist")!.args;
  ok(spec.persona?.id === "sana" && spec.persona?.name === "Sana" && !!spec.persona?.avatar, "the specialist card names the Sana persona (D1)");
  ok(spec.rows?.length === 4, "the specialist card carries its four justified rows");
  const team = await q(pooled, "select count(*) as n from teams where id = 'research'");
  ok(team[0].n === "1", "the Research Team row exists");
  const members = await q(pooled, "select agent_id, lead from team_members where team_id = 'research' order by ord");
  ok(members.length === 4 && members[0].agent_id === "elliot" && (members[0].lead === true || members[0].lead === "true"), "four members; Elliot is the lead");
  const agents = await q(pooled, "select count(*) as n from agents where id = 'elliot'");
  ok(agents[0].n === "1", "Elliot's agent row exists");
  const slot = await q(pooled, "select count(*) as n from org_slots where org_id = 'ty-lab' and team_id = 'research'");
  const edge = await q(pooled, "select count(*) as n from org_handoffs where from_team_id = 'research' and to_team_id = 'product' and preview = 'true'");
  ok(slot[0].n === "1" && edge[0].n === "1", "org slot in ty-lab and the Research → Product preview edge");
  const pool = await q(pooled, "select id from persona_pool order by ord");
  ok(pool.length === 1 && pool[0].id === "sana", "Elliot left the persona pool; Sana waits");
  await assertCardIsTeam(pooled, card, "fixture team approved");
  const registry = await (await fetch(`${base}/api/registry`)).json();
  ok(registry.teams.some((t: any) => t.id === "research") && registry.agents.some((a: any) => a.agent.id === "elliot"), "GET /api/registry serves the new team and lead");
  ok(!registry.agents.some((a: any) => a.agent.id === "sana"), "Sana is still hidden");

  info("4. fixture · approve → Sana joins; handoff creates the task and the run");
  const t3 = await turn("c1", await decide("c1", "propose_specialist", "approved"), true);
  latencies.push(`fixture approve-specialist ${t3.ms} ms`);
  assertTurnShape(t3.parts, "handoff_to_team", "specialist approved");
  const handoff = toolPart(t3.parts, "handoff_to_team")!;
  ok(handoff.result?.runId === handoff.args.runId && handoff.result?.taskId === handoff.args.taskId, "handoff_to_team streams with its result payload");
  ok(handoff.args.members.length === 4 && handoff.args.members.every((m: any) => m.agentId && m.name && m.role), "member personas: agentId, name, role");
  const members5 = await q(pooled, "select count(*) as n from team_members where team_id = 'research'");
  const sana = await q(pooled, "select count(*) as n from agents where id = 'sana'");
  const emptyPool = await q(pooled, "select count(*) as n from persona_pool");
  ok(members5[0].n === "5" && sana[0].n === "1" && emptyPool[0].n === "0", "Sana joined the team and left the pool");
  const task = await q(pooled, `select session_id, recording_key, project_id from tasks where id = '${handoff.args.taskId}'`);
  ok(task[0].session_id === "c1" && task[0].recording_key === "ngram-135m" && task[0].project_id === "engram", "the task: this session, the demo recording, Engram (project null → engram)");
  const run = await q(pooled, `select status, assistant_tokens, brief from runs where id = '${handoff.args.runId}'`);
  ok(run[0].status === "running", "the run stays running (TEAM is a stub; splice takes over)");
  ok(Number(run[0].assistant_tokens) > 0, "assistant_tokens carries Dana's measured base context");
  const brief = run[0].brief;
  ok(brief.tokens > 0 && brief.criteria.length >= 3 && brief.stayed.length === 3, "the compiled brief: criteria from the team, stayed with Dana");
  ok(!JSON.stringify(brief).includes("I want to test an idea") && !JSON.stringify(brief).includes("NAND instead of RAM"), "the brief carries no transcript text");
  ok(saw("task.changed") && saw("run.changed"), "task.changed and run.changed announced the handoff");

  info("5. fixture · splice + finalize-splice → the post_results message, and session.message with its id");
  await post(`/api/runs/${handoff.args.runId}/splice`, { t: 60 });
  const fin = await (await post(`/api/runs/${handoff.args.runId}/finalize-splice`, {})).json();
  const history = (await (await fetch(`${base}/api/sessions/c1/messages`)).json()) as { sessionId: string; messages: Message[] };
  const last = history.messages[history.messages.length - 1];
  const postPart = last.content.find((p) => p.toolName === "post_results");
  ok(!!postPart && postPart.result?.posted === true && postPart.args.reportId === fin.reportId && postPart.args.rows, "history ends with the post_results message (CHAT-14)");
  ok(last.content.some((p) => p.type === "text" && /results/i.test(p.text ?? "")), "Dana says the results are here");
  ok(appEvents.some((a) => a.event.type === "session.message" && a.event.sessionId === "c1" && a.event.messageId === last.id), "session.message carries the real message id");

  info("6. fixture · reload restores the whole thread");
  ok(history.messages.length >= 5 && history.messages[0].role === "user", `GET messages restores the thread (${history.messages.length} messages)`);
  const decidedCards = history.messages.flatMap((m) => m.content.filter((p) => p.toolName === "propose_team" || p.toolName === "propose_specialist"));
  ok(decidedCards.filter((p) => p.result?.decision === "approved").length === 2, "both decided cards show their decision in history");
  ok(history.messages.some((m) => m.content.some((p) => p.toolName === "handoff_to_team" && p.result)), "the handoff card is restored with its payload");
}

// ---- Phase B: decline for both cards (fresh world: nothing may be created) ----
{
  info("7. re-seeding … then decline branches");
  await seed();
  const t1 = await turn("c2", [userMsg(IDEA_PROMPT)], true);
  void t1;
  const t2 = await turn("c2", await decide("c2", "propose_team", "declined"), true);
  ok(t2.parts[0]?.toolName === "record_disposition" && t2.parts[0].result?.recorded === true, "team declined: disposition first, recorded");
  ok(t2.parts.slice(1).every((p) => p.type === "text"), "team declined: no tool follows; the turn is just Dana's reply");
  ok(t2.parts.some((p) => p.type === "text" && /won't build the team/i.test(p.text ?? "")), "the scripted decline reply (CARD-5)");
  ok((await q(pooled, "select count(*) as n from teams where id = 'research'"))[0].n === "0", "no new team after a decline");
  ok((await q(pooled, "select count(*) as n from agents where id = 'elliot'"))[0].n === "0", "no Elliot after a decline");
  ok((await q(pooled, "select status from proposals"))[0].status === "declined", "the proposal row is declined");

  await turn("c3", [userMsg(IDEA_PROMPT)], true);
  await turn("c3", await decide("c3", "propose_team", "approved"), true);
  const s2 = await turn("c3", await decide("c3", "propose_specialist", "declined"), true);
  ok(s2.parts.some((p) => p.type === "text" && /without a Validator/i.test(p.text ?? "")), "the scripted specialist decline reply");
  ok((await q(pooled, "select count(*) as n from agents where id = 'sana'"))[0].n === "0", "no Sana after declining the specialist");
  ok((await q(pooled, "select count(*) as n from tasks"))[0].n === "0" && (await q(pooled, "select count(*) as n from runs where task_id is not null"))[0].n === "0", "declining the specialist authorizes no handoff (the taskless recording is not a task run)");
}

// ---- Phase C: discuss keeps it pending; a re-proposal supersedes (CARD-4) ----
{
  info("8. re-seeding … then discuss + re-proposal for both cards");
  await seed();
  await turn("c4", [userMsg(IDEA_PROMPT)], true);
  const d1 = await turn("c4", await decide("c4", "propose_team", "discuss"), true);
  ok(d1.parts.some((p) => p.type === "text" && /talk it through|which part/i.test(p.text ?? "")), "the scripted discuss reply");
  ok((await q(pooled, "select status from proposals"))[0].status === "pending", "discuss keeps the proposal pending");
  const r1 = await turn("c4", [userMsg("Yes — propose it again, with a bigger rework budget.")], true);
  assertTurnShape(r1.parts, "propose_team", "team re-proposal");
  const reCard = toolPart(r1.parts, "propose_team")!.args;
  const rows = await q(pooled, "select status, payload->>'supersedes' as sup, payload->>'reworkBudget' as rb from proposals order by created_at");
  ok(rows.length === 2 && rows[0].status === "superseded" && rows[1].status === "pending", "the old row is superseded, the new one pending");
  const oldCall = (await q(pooled, "select tool_call_id from proposals order by created_at limit 1"))[0].tool_call_id;
  ok(rows[1].sup === oldCall && reCard.supersedes === oldCall, "the new card carries supersedes = the old toolCallId");
  ok(Number(reCard.reworkBudget) === 3 && Number(rows[1].rb) === 3, "the re-proposal actually changed (rework budget 3)");
  ok(reCard.leadDefaults?.some((r: any) => r.label === "Rework budget" && r.value.startsWith("3 ")), "the lead's rework row follows the budget");
  await turn("c4", await decide("c4", "propose_team", "approved"), true);
  await assertCardIsTeam(pooled, reCard, "re-proposed card approved");

  await turn("c5", [userMsg(IDEA_PROMPT)], true);
  await turn("c5", await decide("c5", "propose_team", "approved"), true);
  await turn("c5", await decide("c5", "propose_specialist", "discuss"), true);
  const r2 = await turn("c5", [userMsg("Sure, propose the validator again with the changes we discussed.")], true);
  assertTurnShape(r2.parts, "propose_specialist", "specialist re-proposal");
  const specRows = await q(pooled, "select kind, status, payload->>'supersedes' as sup from proposals where session_id = 'c5' order by created_at");
  ok(specRows.filter((r) => r.kind === "specialist").length === 2, "two specialist proposals");
  ok(specRows.find((r) => r.kind === "specialist" && r.status === "superseded") && specRows.find((r) => r.kind === "specialist" && r.status === "pending")?.sup, "the specialist re-proposal supersedes too");
}

// ---- Live phase: the same happy path on the real lane, N times, sequential ----
const timings: { pass: number; turn: string; timing: Timing }[] = [];
if (live) {
  info(`9. live · ${times}× the happy path on the model lane (sequential; 8-request lane)`);
  let pass = 0;
  for (let i = 1; i <= times; i++) {
    await seed();
    const sid = `live-${i}`;
    const t0 = Date.now();
    const t1 = await turn(sid, [userMsg(IDEA_PROMPT)], false);
    assertTurnShape(t1.parts, "propose_team", `live ${i}: idea`, false);
    const t2 = await turn(sid, await decide(sid, "propose_team", "approved"), false);
    assertTurnShape(t2.parts, "propose_specialist", `live ${i}: team approved`, false);
    await assertCardIsTeam(pooled, toolPart(t1.parts, "propose_team")!.args, `live ${i}`);
    const spec = toolPart(t2.parts, "propose_specialist")!.args;
    ok(spec.persona?.id === "sana" && spec.rows?.length === 4 && spec.rows[0].label === "Tools", `live ${i}: the specialist card: the Sana persona, the Validator template's rows`);
    const t3 = await turn(sid, await decide(sid, "propose_specialist", "approved"), false);
    assertTurnShape(t3.parts, "handoff_to_team", `live ${i}: specialist approved`, false);
    const handoff = toolPart(t3.parts, "handoff_to_team")!;
    const run = await q(pooled, `select assistant_tokens, brief from runs where id = '${handoff.args.runId}'`);
    ok(run.length === 1 && Number(run[0].assistant_tokens) > 0 && !JSON.stringify(run[0].brief).includes("I want to test an idea"), `live ${i}: run exists, assistant tokens set, brief clean`);
    const members = await q(pooled, "select count(*) as n from team_members where team_id = 'research'");
    const personas = await q(pooled, "select count(*) as n from agents where id in ('elliot','sana')");
    ok(members[0].n === "5" && personas[0].n === "2", `live ${i}: the team, Elliot and Sana exist (5 members)`);
    timings.push({ pass: i, turn: "idea", timing: t1.timing }, { pass: i, turn: "approve-team", timing: t2.timing }, { pass: i, turn: "approve-specialist", timing: t3.timing });
    const wall = ((Date.now() - t0) / 1000).toFixed(1);
    latencies.push(`live ${i}: idea ${t1.ms} ms · approve-team ${t2.ms} ms · approve-spec ${t3.ms} ms · total ${wall} s`);
    pass++;
    info(`   pass ${pass}/${times} (${wall} s)`);
  }
  ok(pass === times, `live: ${pass}/${times} complete happy paths`);
}

console.log(`\nlatencies:`);
for (const l of latencies) console.log(`  ${l}`);
if (timings.length) printTimingTable(timings);
console.log(`\ncheck:chat PASSED in ${((Date.now() - startedAll) / 1000).toFixed(1)}s · branch ${branch}${live ? " · live" : " · fixture"}`);
stopAll();
process.exit(0);

/** The live per-turn timing table (markdown, so it pastes into status/dana.md), plus medians. */
function printTimingTable(rows: { pass: number; turn: string; timing: Timing }[]) {
  const sec = (ms?: number) => (ms === undefined ? "—" : `${(ms / 1000).toFixed(1)} s`);
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : undefined;
  };
  const cols = ["disposition", "text", "card", "done"] as const;
  console.log(`\nlive timing (from the POST; card = propose_* part, or the handoff with its result):\n`);
  console.log("| pass | turn | disposition | text | card / handoff | done | server notes |");
  console.log("|---|---|---|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.pass} | ${r.turn} | ${cols.map((c) => sec(r.timing[c])).join(" | ")} | ${r.timing.notes ?? ""} |`);
  for (const t of [...new Set(rows.map((r) => r.turn))]) {
    const of = rows.filter((r) => r.turn === t);
    const med = cols.map((c) => sec(median(of.map((r) => r.timing[c]).filter((v): v is number => v !== undefined))));
    console.log(`| median | ${t} | ${med.join(" | ")} | |`);
  }
}
