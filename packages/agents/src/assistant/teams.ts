// Turning an approved proposal into registry rows (DANA 3, D1/D2). One shared creation path —
// packages/db's provisionTeam — is also what the dev sim uses, so both produce identical rows.
// The canonical definition for a demo team is the fixture's (the mock world's own team), so the
// registry after a real approval matches the world UI-WORK was built against; anything else the
// model proposes falls back to a definition derived from the card payload itself.
import type { PersonaPoolEntry, SpecialistProposal, StudioProfile, StudioTeam, TeamProposal } from "@fabric/contracts";
import { myProfiles } from "@fabric/fixtures/studio";
import { studioTeams } from "@fabric/fixtures/teams";
import { provisionTeam, slugId, sql } from "@fabric/db";
import type { Db } from "@fabric/db";
import type { StoredProposal } from "./store";

export interface ResolvedTeam {
  definition: StudioTeam;
  /** Persona templates for members that don't exist yet (D1: elliot, sana from studio.ts). */
  templates: Partial<Record<string, StudioProfile>>;
}

const fixtureTeam = (name: string): StudioTeam | undefined => {
  const slug = slugId(name);
  return studioTeams.find((t) => t.id === slug) ?? studioTeams.find((t) => t.name.toLowerCase() === name.toLowerCase());
};

/** A fallback definition for a team the fixtures don't know: derived from the card payload. */
function teamFromProposal(p: TeamProposal): StudioTeam {
  const members = p.roster.map((r) => ({
    agentId: r.agentId || slugId(r.name),
    duty: r.role || r.name,
    lead: /lead/i.test(r.role ?? r.name),
  }));
  return {
    id: slugId(p.name),
    name: p.name,
    tagline: p.purpose,
    purpose: p.purpose,
    status: "active",
    origin: "Created in chat",
    members,
    workflow: (p.workflow ?? []).map((w) => ({ label: w.label, agentIds: w.agentIds, note: "", gate: w.gate })),
    reworkBudget: p.reworkBudget ?? 2,
    criteria: p.criteria ?? [],
  };
}

/** Template for a member that doesn't exist yet: the fixture profile, else a minimal one from the pool. */
function templateFor(memberId: string, pool: PersonaPoolEntry[]): StudioProfile | undefined {
  const fixture = myProfiles.find((p) => p.agent.id === memberId);
  if (fixture) return fixture;
  const entry = pool.find((p) => p.id === memberId);
  if (!entry) return undefined;
  return {
    agent: {
      id: entry.id, name: entry.name, role: entry.role, avatar: entry.avatar, tone: "bg-muted text-muted-foreground",
      summary: `${entry.role} proposed by Dana in chat.`, personality: "", traits: [], model: "", contextTokens: 0,
      memory: [], tools: [], greeting: `What should I work on, Ty?`, placeholder: `Tell ${entry.name} what you need…`,
    },
    tagline: entry.role,
    origin: "Created in chat",
    workspace: {
      files: [
        { name: "SOUL.md", body: `# SOUL.md\n\nYou are ${entry.name}, the ${entry.role.toLowerCase()}.\n` },
        { name: "IDENTITY.md", body: `# IDENTITY.md\n\n- **Name:** ${entry.name}\n- **Role:** ${entry.role}\n` },
        { name: "USER.md", body: "# USER.md\n\nEmpty until Dana fills in what this role needs.\n" },
      ],
      skills: [], connectors: [], memories: [],
    },
  };
}

/** The team an approved team card creates: the fixture definition when it matches, else the payload's. */
export function resolveTeam(payload: TeamProposal, pool: PersonaPoolEntry[]): ResolvedTeam {
  const definition = fixtureTeam(payload.name) ?? teamFromProposal(payload);
  const templates: Partial<Record<string, StudioProfile>> = {};
  for (const m of definition.members) {
    const t = templateFor(m.agentId, pool);
    if (t) templates[m.agentId] = t;
  }
  return { definition, templates };
}

/**
 * The team as it should look once an approved specialist joins it: the existing team's definition
 * (the session's approved team proposal names it), plus the specialist as a member if missing.
 */
export async function resolveSpecialistJoin(
  db: Db,
  teamName: string,
  specialist: SpecialistProposal,
  pool: PersonaPoolEntry[],
): Promise<ResolvedTeam> {
  const stored = await getStoredTeam(db, teamName);
  const base = stored ?? fixtureTeam(teamName);
  const personaId = specialist.persona?.id ?? slugId(specialist.name);
  const definition: StudioTeam = base
    ? { ...base, members: base.members.some((m) => m.agentId === personaId) ? base.members : [...base.members, { agentId: personaId, duty: specialist.purpose }] }
    : {
        id: slugId(teamName), name: teamName, tagline: specialist.purpose, purpose: specialist.purpose,
        status: "active", origin: "Created in chat",
        members: [{ agentId: personaId, duty: specialist.purpose }],
        workflow: [], reworkBudget: 2, criteria: [],
      };
  const template = templateFor(personaId, pool);
  return { definition, templates: template ? { [personaId]: template } : {} };
}

async function getStoredTeam(db: Db, name: string): Promise<StudioTeam | undefined> {
  const rows = await db.db.execute(sql`
    select t.*, (select jsonb_agg(jsonb_build_object('agentId', m.agent_id, 'duty', m.duty, 'lead', m.lead) order by m.ord)
                 from team_members m where m.team_id = t.id) as members
    from teams t where lower(t.name) = lower(${name}) limit 1`);
  const row = (rows.rows as (Record<string, unknown> & { members: { agentId: string; duty: string; lead: boolean }[] | null })[])[0];
  if (!row) return undefined;
  return {
    id: row.id as string,
    name: row.name as string,
    tagline: row.tagline as string,
    purpose: row.purpose as string,
    status: row.status as StudioTeam["status"],
    origin: row.origin as string,
    members: (row.members ?? []).map((m) => ({ agentId: m.agentId, duty: m.duty, lead: m.lead || undefined })),
    workflow: row.workflow as StudioTeam["workflow"],
    reworkBudget: Number(row.rework_budget),
    criteria: row.criteria as string[],
  };
}

export interface ApprovalOutcome {
  createdAgents: string[];
  teamCreated: boolean;
}

/** Creates the rows an approval authorizes. Nothing exists before this runs (SEED-1). */
export async function applyApproval(
  db: Db,
  input: { row: StoredProposal; pool: PersonaPoolEntry[]; onInbox: (agentId: string) => void },
): Promise<ApprovalOutcome> {
  const { row, pool } = input;
  const teamName = row.kind === "team" ? "" : await sessionTeamName(db, row.sessionId ?? "");
  const resolved =
    row.kind === "team"
      ? resolveTeam(row.payload as TeamProposal, pool)
      : await resolveSpecialistJoin(db, teamName || "Research Team", row.payload as SpecialistProposal, pool);
  const provisioned = await provisionTeam(db, {
    team: resolved.definition,
    templates: resolved.templates,
    origin: "Created in chat",
  });
  for (const agentId of provisioned.createdAgents) input.onInbox(agentId);
  return { createdAgents: provisioned.createdAgents, teamCreated: provisioned.teamCreated };
}

/** The name of the team this session's approved team proposal created, if any. */
async function sessionTeamName(db: Db, sessionId: string): Promise<string> {
  if (!sessionId) return "";
  const rows = await db.db.execute(sql`
    select payload->>'name' as name from proposals
    where session_id = ${sessionId} and kind = 'team' and status = 'approved'
    order by created_at desc limit 1`);
  return (rows.rows as { name: string | null }[])[0]?.name ?? "";
}
