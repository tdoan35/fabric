import { sql } from "drizzle-orm";
import type { RunEvent } from "@fabric/contracts";
import { RunClosedError, type Db, type RunWriter } from "@fabric/db";
import { recordings } from "@fabric/fixtures/recordings";
import { myProfiles } from "@fabric/fixtures/studio";
import { studioTeams } from "@fabric/fixtures/teams";

export interface SimOptions {
  speed?: number;
  window?: number;
  session?: string;
  recordingKey?: string;
  onRegistryChanged?: () => void;
  onTaskCreated?: (taskId: string, runId: string) => void;
  onDone?: (message: string) => void;
}

/** The CLI and dev route use the same setup and emitter. The route returns once the run exists. */
export async function startSim(db: Db, writer: RunWriter, options: SimOptions = {}) {
  const speed = Number(options.speed) > 0 ? Number(options.speed) : 1;
  const windowS = Number(options.window) > 0 ? Number(options.window) : 60;
  const key = options.recordingKey ?? "ngram-135m";
  const bundle = recordings[key];
  if (!bundle) throw new Error(`no recording bundle for key ${key}`);

  const team = studioTeams.find((t) => t.id === "research")!;
  const exists = await db.db.execute(sql`select 1 from teams where id = 'research'`);
  if (!exists.rows.length) {
    const profiles = new Map(myProfiles.filter((p) => team.members.some((m) => m.agentId === p.agent.id)).map((p) => [p.agent.id, p]));
    for (const m of team.members) {
      const profile = profiles.get(m.agentId);
      const agentExists = await db.db.execute(sql`select 1 from agents where id = ${m.agentId}`);
      if (!agentExists.rows.length && profile) {
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
    // The clean demo org starts with Product Team. Materialize the planned edge with the team.
    await db.db.execute(sql`insert into org_slots (org_id, key, ord, team_id) values ('ty-lab', 'research-1', 0, 'research') on conflict do nothing`);
    await db.db.execute(sql`
      insert into org_handoffs (org_id, from_team_id, to_team_id, ord, question, preview)
      values ('ty-lab', 'research', 'product', 0, 'Can these results drive a real, value-driven product?', true)
      on conflict do nothing`);
    options.onRegistryChanged?.();
  }

  const sessionId = options.session === "none" ? undefined
    : options.session ?? ((await db.db.execute(sql`select 1 from sessions where id = 'p2'`)).rows.length ? "p2" : undefined);
  const task = await writer.createTask({ projectId: "engram", teamId: "research", title: "n-gram fusion on a 135M model", recordingKey: key, sessionId });
  const run = await writer.startRun(task.id, bundle.run.brief, {
    costUsd: bundle.run.budget.costUsd, timeS: bundle.run.budget.timeS, rework: bundle.run.reworkBudget,
  });
  options.onTaskCreated?.(task.id, run.id);

  const prefix: RunEvent[] = bundle.events.filter((e) => e.type !== "run.started" && e.t <= windowS)
    .map((e) => ({ ...e, runId: run.id, seq: 0 }));
  const done = (async () => {
    const startedWall = Date.now();
    for (const e of prefix) {
      const wait = startedWall + (e.t * 1000) / speed - Date.now();
      if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
      try {
        await writer.emit(run.id, e.type, e.actorAgentId, e.payload as Record<string, unknown>);
      } catch (err) {
        if (err instanceof RunClosedError) {
          options.onDone?.("sim: run spliced, stopping");
          return;
        }
        throw err;
      }
    }
    options.onDone?.(`sim: emitted ${prefix.length} events over ${((Date.now() - startedWall) / 1000).toFixed(1)}s; run ${run.id} left running`);
  })();
  return { taskId: task.id, runId: run.id, speed, window: windowS, done };
}
