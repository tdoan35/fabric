// npm run sim -- [--speed 1] [--window 60] [--session <id>|none] [--runfile <path>]   (for UI-WORK + check-data)
//
// Simulates a live run for the next step: creates a task on the Engram project with
// recordingKey=DEMO_RECORDING_KEY, starts a run, then replays the first `window` seconds of the
// ngram-135m recording through RunWriter in real time (divided by --speed) and exits with the run
// still `running`. Runs in its own process against DATABASE_URL (default: the .env branch);
// the server's SSE tail picks the events up by polling.
import { writeFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import type { RunEvent } from "@fabric/contracts";
import { createDb, createRunWriterWith, loadRootEnv, RunClosedError } from "@fabric/db";
import { recordings } from "@fabric/fixtures/recordings";
import { myProfiles } from "@fabric/fixtures/studio";
import { studioTeams } from "@fabric/fixtures/teams";

const flag = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const speed = Number(flag("speed") ?? 1) || 1;
const windowS = Number(flag("window") ?? 60) || 60;

loadRootEnv();
const key = process.env.DEMO_RECORDING_KEY ?? "ngram-135m";
const bundle = recordings[key];
if (!bundle) throw new Error(`no recording bundle for key ${key}`);

const db = createDb();
const writer = createRunWriterWith(db);

// The demo profile hides the Research Team (SEED-1); sim is a dev tool, so it materializes the
// fixture team (and any missing member rows) when absent — the loop view then renders like the mock.
const team = studioTeams.find((t) => t.id === "research")!;
const teamExists = await db.db.execute(sql`select 1 from teams where id = 'research'`);
if (teamExists.rows.length === 0) {
  const memberProfiles = new Map(
    myProfiles.filter((p) => team.members.some((m) => m.agentId === p.agent.id)).map((p) => [p.agent.id, p]),
  );
  for (const m of team.members) {
    const profile = memberProfiles.get(m.agentId);
    const exists = await db.db.execute(sql`select 1 from agents where id = ${m.agentId}`);
    if (exists.rows.length === 0 && profile) {
      await db.db.execute(sql`
        insert into agents (id, ord, name, role, tagline, summary, personality, traits, tone, avatar, model,
                            context_tokens, memory, tools, greeting, placeholder, workspace, origin, community, status, is_seeded)
        values (${profile.agent.id}, 900, ${profile.agent.name}, ${profile.agent.role}, ${profile.tagline},
                ${profile.agent.summary}, ${profile.agent.personality}, ${JSON.stringify(profile.agent.traits)}::jsonb,
                ${profile.agent.tone}, ${JSON.stringify(profile.agent.avatar ?? null)}::jsonb, ${profile.agent.model},
                ${profile.agent.contextTokens}, ${JSON.stringify(profile.agent.memory)}::jsonb,
                ${JSON.stringify(profile.agent.tools)}::jsonb, ${profile.agent.greeting}, ${profile.agent.placeholder},
                ${JSON.stringify(profile.workspace)}::jsonb, ${profile.origin ?? "Created by sim"}, false, 'active', false)`);
    }
  }
  await db.db.execute(sql`
    insert into teams (id, ord, name, tagline, purpose, status, origin, workflow, criteria, rework_budget)
    values ('research', 900, ${team.name}, ${team.tagline}, ${team.purpose}, 'active', 'Created by sim · live loop',
            ${JSON.stringify(team.workflow)}::jsonb, ${JSON.stringify(team.criteria)}::jsonb, ${team.reworkBudget})`);
  for (const [mi, m] of team.members.entries()) {
    await db.db.execute(sql`
      insert into team_members (team_id, agent_id, ord, duty, lead) values ('research', ${m.agentId}, ${mi}, ${m.duty}, ${m.lead ?? false})`);
  }
}

const sessionArg = flag("session");
const sessionId =
  sessionArg === "none" ? undefined
  : sessionArg ?? ((await db.db.execute(sql`select 1 from sessions where id = 'p2'`)).rows.length ? "p2" : undefined);

const task = await writer.createTask({
  projectId: "engram",
  teamId: "research",
  title: "n-gram fusion on a 135M model",
  recordingKey: key,
  sessionId,
});
const run = await writer.startRun(task.id, bundle.run.brief, {
  costUsd: bundle.run.budget.costUsd,
  timeS: bundle.run.budget.timeS,
  rework: bundle.run.reworkBudget,
});
console.log(`sim: task ${task.id} · run ${run.id} · speed ${speed}× · window ${windowS}s`);
if (flag("runfile")) {
  await writeFile(flag("runfile")!, JSON.stringify({ taskId: task.id, runId: run.id }, null, 2));
}

// Replay the recording's first `window` seconds; RunWriter stamps real-elapsed `t`.
const prefix: RunEvent[] = [];
for (const e of bundle.events) {
  if (e.type === "run.started" || e.t > windowS) continue; // startRun already emitted run.started
  prefix.push({ ...e, runId: run.id, seq: 0 });
}
const startedWall = Date.now();
let spliced = false;
for (const e of prefix) {
  const due = startedWall + (e.t * 1000) / speed;
  const wait = due - Date.now();
  if (wait > 0) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, wait);
    await promise;
  }
  try {
    await writer.emit(run.id, e.type, e.actorAgentId, e.payload as Record<string, unknown>);
  } catch (err) {
    if (err instanceof RunClosedError) {
      console.log("sim: run spliced, stopping");
      spliced = true;
      break;
    }
    throw err;
  }
}
if (!spliced) {
  console.log(`sim: emitted ${prefix.length} events over ${((Date.now() - startedWall) / 1000).toFixed(1)}s; run ${run.id} left running`);
}
await db.close();
