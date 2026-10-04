// The handoff (DANA 4): compile a brief, create the task and the run, then hand the run to TEAM.
// The tool result streams to the thread as a HandoffPayload. TEAM is still a stub: its
// NotImplementedError is caught and logged, and the run stays `running`, so the UI can
// Fast-forward/splice it (D5).
import { NotImplementedError } from "@fabric/contracts";
import type { AppEvent, Brief, HandoffPayload, StudioProfile, StudioTeam } from "@fabric/contracts";
import { listProjects } from "@fabric/db";
import type { Db, RunWriter } from "@fabric/db";
import type { TeamRuntime } from "../team";
import { assistantContextSections, measureAssistantContext } from "../context";
import type { BriefInput } from "../context";
import { getProfile, getTeamByName, projectFor, type SessionRow } from "./store";

/** How long a research run is allowed to take. Demo scale: 3 h, like the recorded loop. */
const BUDGET_TIME_S = 3 * 3600;

const STATE_BY_ROLE: [RegExp, string][] = [
  [/lead/i, "planning"],
  [/investigat|research/i, "searching"],
  [/code|engineer|build/i, "setting up"],
  [/validat/i, "preparing checks"],
];

function memberState(role: string): string {
  for (const [re, state] of STATE_BY_ROLE) if (re.test(role)) return state;
  return "working";
}

/** Who is working right after the handoff: the members of the workflow's first two stages. */
export function workingMembers(team: StudioTeam, profiles: StudioProfile[]): HandoffPayload["members"] {
  const early = new Set(team.workflow.slice(0, 2).flatMap((s) => s.agentIds));
  const byId = new Map(profiles.map((p) => [p.agent.id, p]));
  const picked = team.members.filter((m) => early.size === 0 || early.has(m.agentId));
  return picked.map((m) => {
    const p = byId.get(m.agentId);
    const role = p?.agent.role ?? m.duty;
    return { name: p?.agent.name ?? m.agentId, role, agentId: m.agentId, state: memberState(role) };
  });
}

export interface HandoffDeps {
  db: Db;
  writer: RunWriter;
  team: TeamRuntime;
  publish: (e: AppEvent) => void;
  /** DEMO_RECORDING_KEY: what a Fast-forward splices into. */
  recordingKey: string;
  /** compileBrief in live mode; the deterministic scripted brief in fixture mode. */
  brief: (input: BriefInput) => Promise<Brief>;
}

export interface HandoffInput {
  sessionId: string;
  session: SessionRow | undefined;
  teamName: string;
  /** Dana's restatement of the request — the only request text the brief compiler ever sees. */
  request: string;
  /** Short task title for the board; defaults to a trimmed restatement. */
  title?: string;
  /** The handoff card's line; defaults to the compiled brief's objective (what the team receives). */
  summary?: string;
  /** What Dana recalled this turn (MEM): counted into her tokens, shown in her snapshot. */
  memory?: { content: string; items: number };
}

/** Runs the whole handoff and returns the payload that streams back to the thread. */
export async function runHandoff(deps: HandoffDeps, input: HandoffInput): Promise<HandoffPayload> {
  const { db } = deps;
  const [team, dana, projects] = await Promise.all([getTeamByName(db, input.teamName), getProfile(db, "dana"), listProjects(db)]);
  if (!team) throw new Error(`handoff: team "${input.teamName}" does not exist (approve the team first)`);

  // The brief is a model call and the task doesn't depend on it: both at once. (The live brief
  // falls back to the deterministic one rather than failing, so this never strands a task.)
  const project = projectFor(input.session, projects);
  const title = (input.title ?? input.request).replace(/\s+/g, " ").trim().slice(0, 80);
  const [brief, task] = await Promise.all([
    deps.brief({
      request: input.request,
      team: { name: team.name, purpose: team.purpose, criteria: team.criteria },
      specialists: team.memberProfiles,
    }),
    deps.writer.createTask({
      projectId: project, teamId: team.id, title, sessionId: input.sessionId, recordingKey: deps.recordingKey,
    }),
  ]);
  const assistantTokens = dana ? measureAssistantContext(dana, input.memory) : brief.tokens;
  const run = await deps.writer.startRun(
    task.id,
    brief,
    { costUsd: 0, timeS: BUDGET_TIME_S, rework: team.reworkBudget },
    { assistantTokens },
  );
  if (dana) {
    // Dana's own context, beside each specialist's (INSPECTOR): her files, skills, connectors and —
    // when this turn recalled any — Personal memory. The specialists' snapshots never change: they
    // keep listing personal memory under notLoaded, and their sections never contain it (CONCEPT §2.9).
    await deps.writer.saveSnapshot({
      runId: run.id,
      agentId: dana.agent.id,
      step: "Handoff",
      assembledAtS: 0,
      sections: assistantContextSections(dana, input.memory),
      totalTokens: assistantTokens,
      tools: [],
      notLoaded: "the specialists' skills · team knowledge",
      note: `Dana's base context at the handoff${input.memory ? ", with what she remembered about you" : ""}.`,
    });
  }

  try {
    await deps.team.startTeamRun(run.id);
  } catch (err) {
    if (err instanceof NotImplementedError) {
      console.log(`[handoff] TEAM not implemented yet; run ${run.id} stays running for splice`);
    } else {
      throw err;
    }
  }

  deps.publish({ type: "task.changed", taskId: task.id });
  deps.publish({ type: "run.changed", runId: run.id });
  return {
    runId: run.id,
    taskId: task.id,
    teamName: team.name,
    summary: input.summary ?? brief.objective,
    members: workingMembers(team, team.memberProfiles),
  };
}
