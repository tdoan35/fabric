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

const STAYED = ["Your chat with Dana", "Dana's memory of you", "Your other threads and projects"];

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

export async function startDevTeamRun(db: Db, writer: RunWriter, teamRuntime: TeamRuntime, options: DevTeamOptions = {}) {
  await ensureTeam(db);
  options.onRegistryChanged?.();
  const registry = await readRegistry(db);
  const lead = registry.agents.find((a) => a.agent.id === "elliot");
  if (!lead) throw new Error("dev team run needs the research team (seed the demo profile first)");

  const objective = options.objective ?? TOY_OBJECTIVE;
  const brief: Brief = {
    objective,
    constraints: ["Real commands in the Sprites; no large installs", "Keep it small: minutes, not hours"],
    criteria: TOY_CRITERIA,
    preferences: [],
    stayed: [...STAYED],
    tokens: 0,
  };
  brief.tokens = countTokens(renderBrief(brief)).tokens;

  const task = await writer.createTask({ projectId: "engram", teamId: "research", title: `Team check · ${objective.slice(0, 48)}` });
  const run = await writer.startRun(task.id, brief, { costUsd: 1, timeS: 1800, rework: options.forceBlock ? 1 : 2 });
  options.onTaskCreated?.(task.id, run.id);

  // startTeamRun resolves once the run is underway; the workflow continues in the background.
  await teamRuntime.startTeamRun(run.id, { forceBounce: options.forceBounce, forceBlock: options.forceBlock });
  options.onDone?.(`dev team: run ${run.id} underway (task ${task.id})`);
  return { taskId: task.id, runId: run.id };
}
