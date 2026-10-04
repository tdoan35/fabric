// Seed profiles (WORK-PLAN §4.8): the exact world each branch resets to.
// `demo` is the pre-approval state (SEED-1 clean); `lived-in` is today's mock world.
// Both derive from the same fixtures the web's mock mode reads, so lived-in matches the mock.
import type { ContextSnapshot, InboxItem, Organization, PersonaPoolEntry, Presence, Project, PulseEntry, Run, RunEvent, Session, StudioProfile, StudioTeam, Task } from "@fabric/contracts";
import { communityProfiles, elliot, myProfiles, sana } from "../studio";
import { communityTeams, organizations, studioTeams } from "../teams";
import { projects, sessions } from "../sessions";
import { allSnapshots, runEventsById, runs, tasks } from "../work";
import { calendarEvents, inboxSeed, presenceSeed, pulseSeed } from "../weave";

/** A loop the seed inserts as-is (the recorded 135M one comes from its bundle import instead). */
export interface SeededRun {
  run: Run;
  events: RunEvent[];
  snapshots: ContextSnapshot[];
}

export interface SeedWorld {
  profile: "demo" | "lived-in";
  agents: StudioProfile[];
  communityAgents: StudioProfile[];
  personaPool: PersonaPoolEntry[];
  teams: StudioTeam[];
  communityTeams: StudioTeam[];
  organizations: Organization[];
  projects: Project[];
  sessions: Session[];
  tasks: Task[];
  runs: SeededRun[];
  /** Recording bundle keys to import; `attach` optionally links the recording to an existing task. */
  recordings: { key: string; attachTaskId?: string }[];
  weave: { items: InboxItem[]; pulse: PulseEntry[]; presence: Presence[]; calendar: typeof calendarEvents };
}

/** D3/CARD-8: approving the team and specialist authorizes the handoff — no approval of its own. */
const handoffWithoutApproval = (p: StudioProfile): StudioProfile =>
  p.agent.id === "dana"
    ? { ...p, agent: { ...p.agent, tools: p.agent.tools.map((t) => (t.name === "handoff_to_team" ? { ...t, policy: "allowed" as const } : t)) } }
    : p;

const personaEntry = (p: StudioProfile, role: string): PersonaPoolEntry => ({
  id: p.agent.id,
  name: p.agent.name,
  role,
  avatar: p.agent.avatar ?? { still: `/agents/${p.agent.id}-happy.webp` },
});

/** §4.8 demo: only Weave rows whose agent and task exist. An empty inbox is fine. */
function weaveForDemo(agentIds: Set<string>): SeedWorld["weave"] {
  const taskIds = new Set<string>(); // demo seeds no tasks
  const pulseAgent = (e: PulseEntry) => (e.kind === "update" ? e.authorId : e.kind === "event" ? e.actorId : e.agentId);
  return {
    items: inboxSeed.filter((i) => agentIds.has(i.agentId) && (!i.taskId || taskIds.has(i.taskId))),
    pulse: pulseSeed.filter((e) => agentIds.has(pulseAgent(e))),
    presence: presenceSeed.filter((p) => agentIds.has(p.agentId)),
    calendar: calendarEvents,
  };
}

export function buildDemoWorld(): SeedWorld {
  const hidden = new Set(["elliot", "sana"]);
  const agents = myProfiles.filter((p) => !hidden.has(p.agent.id)).map(handoffWithoutApproval);
  const agentIds = new Set(agents.map((p) => p.agent.id));
  return {
    profile: "demo",
    agents,
    communityAgents: communityProfiles,
    personaPool: [personaEntry(elliot, "Research Lead"), personaEntry(sana, "Validator")],
    teams: studioTeams.filter((t) => t.id !== "research"), // Product Team only, idle
    communityTeams,
    organizations: [
      {
        id: "ty-lab",
        name: "Ty's Lab",
        headId: "dana",
        slots: [{ key: "product-1", teamId: "product" }], // the Research slot and its edge appear once the team exists
        handoffs: [],
      },
    ],
    projects,
    sessions: sessions.filter((s) => s.id !== "p1" && s.id !== "s9"), // no Elliot / Research Team threads
    tasks: [], // §4.8: no tasks before approval
    runs: [],
    recordings: [{ key: "ngram-135m" }], // taskless: nothing behind it can play yet
    weave: weaveForDemo(agentIds),
  };
}

export function buildLivedInWorld(): SeedWorld {
  const seededRuns: SeededRun[] = runs
    .filter((r) => r.id !== "run-ngram-1") // the 135M loop is imported from its bundle, attached to its task
    .map((run) => ({ run, events: runEventsById[run.id] ?? [], snapshots: allSnapshots.filter((s) => s.runId === run.id) }));
  return {
    profile: "lived-in",
    agents: myProfiles.map(handoffWithoutApproval),
    communityAgents: communityProfiles,
    personaPool: [],
    teams: studioTeams,
    communityTeams,
    organizations,
    projects,
    sessions,
    tasks,
    runs: seededRuns,
    recordings: [{ key: "ngram-135m", attachTaskId: "ngram-135m" }],
    weave: { items: inboxSeed, pulse: pulseSeed, presence: presenceSeed, calendar: calendarEvents },
  };
}
