import type { RunEvent } from "@fabric/contracts";
import { RunClosedError, provisionTeam, sql, type Db, type RunWriter } from "@fabric/db";
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
    // The same shared path a real approval takes (DANA 3), so the rows and the org edge match.
    const profiles = new Map(myProfiles.filter((p) => team.members.some((m) => m.agentId === p.agent.id)).map((p) => [p.agent.id, p]));
    const provisioned = await provisionTeam(db, {
      team,
      templates: Object.fromEntries(team.members.map((m) => [m.agentId, profiles.get(m.agentId)]).filter(([, p]) => p)),
      origin: "Created by sim · live loop",
    });
    console.log(`sim: provisioned team ${provisioned.teamId} (new agents: ${provisioned.createdAgents.join(", ") || "none"})`);
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
