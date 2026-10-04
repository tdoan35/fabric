// POST /api/dev/team (non-production): a scratch run through the REAL team workflow — like the sim
// and the TOOLS dev route, it provisions the research team if needed, creates a task + run with a
// deterministic brief, and hands the run to TEAM's runtime with the dev hooks (§5.3 TEAM 6):
//   toy          a small objective that finishes end to end in a few minutes on Spark
//   forceBounce  the reviewer requests changes once, then accepts
//   forceBlock   every review requests changes (use reworkBudget 1 → run.blocked)
import { provisionTeam, readRegistry, sql } from "@fabric/db";
import type { Db, RunWriter } from "@fabric/db";
import type { TeamRuntime } from "@fabric/agents/team";
import { countTokens, renderBrief } from "@fabric/agents/context";
import type { Brief } from "@fabric/contracts";
import { myProfiles } from "@fabric/fixtures/studio";
import { studioTeams } from "@fabric/fixtures/teams";

export interface DevTeamOptions {
  onRegistryChanged?: () => void;
  onTaskCreated?: (taskId: string, runId: string) => void;
  onDone?: (message: string) => void;
  /** A custom objective; with `toy` unset the run still uses the toy-scale criteria. */
  objective?: string;
  /** The toy objective (default) — finishes end to end in a few minutes. */
  toy?: boolean;
  forceBounce?: boolean;
  forceBlock?: boolean;
}

export const TOY_OBJECTIVE = "Count the ten most frequent words in a short text and report the counts, computing them with a real program in the sandbox.";

const TOY_CRITERIA = [
  "The count is computed by a real program in the sandbox",
  "An independent re-check reproduces the headline result",
  "The report states how the result was computed",
];

export const STAYED = ["Your chat with Dana", "Dana's memory of you", "Your other threads and projects"];

/** Same world as the dev sim and the TOOLS route: the research team exists before the run. */
async function ensureTeam(db: Db): Promise<void> {
  const exists = await db.db.execute(sql`select 1 from teams where id = 'research'`);
  if (exists.rows.length) return;
  const team = studioTeams.find((t) => t.id === "research")!;
  const profiles = new Map(myProfiles.filter((p) => team.members.some((m) => m.agentId === p.agent.id)).map((p) => [p.agent.id, p]));
  await provisionTeam(db, {
    team,
    templates: Object.fromEntries(team.members.map((m) => [m.agentId, profiles.get(m.agentId)]).filter(([, p]) => p)),
    origin: "Created by dev team check",
  });
}

/** The shared team-run starter (SCH generalization): the deterministic brief, the task (carrying
 *  the routine's thread when one is given), the run, and the handoff to the runtime. The dev route
 *  calls it with the toy objective; schedule-fire calls it with the routine's prompt. */
export interface TeamJob {
  teamId: string;
  projectId: string;
  /** The task card's title; routines suffix the date. */
  title: string;
  objective: string;
  criteria: string[];
  constraints?: string[];
  stayed?: string[];
  budget?: { costUsd: number; timeS: number; rework: number };
  /** The routine's thread: Dana posts results there (finalizeRun reads it off the task). */
  sessionId?: string;
  /** Dev hooks (never on by default), passed through to the runtime. */
  forceBounce?: boolean;
  forceBlock?: boolean;
}

export async function startTeamJob(
  writer: RunWriter, teamRuntime: TeamRuntime, job: TeamJob,
  hooks: { onTaskCreated?: (taskId: string, runId: string) => void } = {},
): Promise<{ taskId: string; runId: string }> {
  const brief: Brief = {
    objective: job.objective,
    constraints: job.constraints ?? [],
    criteria: job.criteria,
    preferences: [],
    stayed: job.stayed ?? [],
    tokens: 0,
  };
  brief.tokens = countTokens(renderBrief(brief)).tokens;

  const task = await writer.createTask({ projectId: job.projectId, teamId: job.teamId, title: job.title, sessionId: job.sessionId });
  const run = await writer.startRun(task.id, brief, job.budget ?? { costUsd: 1, timeS: 1800, rework: 2 });
  hooks.onTaskCreated?.(task.id, run.id);

  // startTeamRun resolves once the run is underway; the workflow continues in the background.
  await teamRuntime.startTeamRun(run.id, { forceBounce: job.forceBounce, forceBlock: job.forceBlock });
  return { taskId: task.id, runId: run.id };
}

export async function startDevTeamRun(db: Db, writer: RunWriter, teamRuntime: TeamRuntime, options: DevTeamOptions = {}) {
  await ensureTeam(db);
  options.onRegistryChanged?.();
  const registry = await readRegistry(db);
  const lead = registry.agents.find((a) => a.agent.id === "elliot");
  if (!lead) throw new Error("dev team run needs the research team (seed the demo profile first)");

  const objective = options.objective ?? TOY_OBJECTIVE;
  const { taskId, runId } = await startTeamJob(writer, teamRuntime, {
    teamId: "research",
    projectId: "engram",
    title: `Team check · ${objective.slice(0, 48)}`,
    objective,
    criteria: TOY_CRITERIA,
    constraints: ["Real commands in the Sprites; no large installs", "Keep it small: minutes, not hours"],
    stayed: [...STAYED],
    budget: { costUsd: 1, timeS: 1800, rework: options.forceBlock ? 1 : 2 },
    ...(options.forceBounce ? { forceBounce: true } : {}),
    ...(options.forceBlock ? { forceBlock: true } : {}),
  }, { onTaskCreated: options.onTaskCreated });

  options.onDone?.(`dev team: run ${runId} underway (task ${taskId})`);
  return { taskId, runId };
}
