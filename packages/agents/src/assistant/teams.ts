// Proposals → cards → registry rows (DANA 3, D1/D2, CARD-1). One definition feeds both the card and
// the approval: the model supplies only a team's name, purpose and roster (a specialist's name,
// purpose and persona), and the server fills everything else — workflow, rework budget, criteria,
// lead defaults, the specialist's rows — from the same definition approval provisions, so a card
// never shows a team its approval wouldn't create. Creation goes through packages/db's
// provisionTeam, which is also what the dev sim uses, so both produce identical rows.
// The canonical definition for a demo team is the fixture's (the mock world's own team), so the
// registry after a real approval matches the world UI-WORK was built against; anything else gets a
// small default definition derived from its roster.
import type {
  PersonaPoolEntry, ProposalRow, RosterEntry, SpecialistProposal, StudioProfile, StudioTeam, TeamProposal,
} from "@fabric/contracts";
import { specialistProposal as validatorTemplate } from "@fabric/fixtures/chat";
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

/** Who exists and who is free: what a card's roster and persona resolve against. */
export interface World {
  agents: { id: string; name: string; role: string; avatar?: string }[];
  pool: PersonaPoolEntry[];
}

/** A team card as the model supplies it. A stored card fits too (its roster entries carry agentId). */
export interface TeamChoice {
  name: string;
  purpose: string;
  /** Member ids (or names), lead first; a new member is a free persona. */
  roster: (string | { agentId?: string; name?: string })[];
  /** Server-filled on stored cards only: approval keeps the budget the card showed (a re-proposal may raise it). */
  reworkBudget?: number;
}

/** A specialist card as the model supplies it. */
export interface SpecialistChoice {
  name: string;
  purpose: string;
  /** A free persona's id (or name); a stored card's persona object fits too. */
  persona?: string | { id?: string; name?: string };
  /** Used only when no role template matches. */
  rows?: ProposalRow[];
}

const fixtureTeam = (name: string): StudioTeam | undefined => {
  const slug = slugId(name);
  const lower = name.toLowerCase();
  return studioTeams.find((t) => t.id === slug)
    ?? studioTeams.find((t) => t.name.toLowerCase() === lower)
    // live phrasing decorates the name ("Engram Research Team") — still the same team
    ?? studioTeams.find((t) => lower.includes(t.name.toLowerCase()) || t.name.toLowerCase().includes(lower));
};

/** Criteria for a team the fixtures don't know. */
const DEFAULT_CRITERIA = [
  "The result answers the request as stated",
  "Every claim is backed by an artifact or a source",
  "The report states caveats and what would change the verdict",
];

const DEFAULT_REWORK_BUDGET = 2;

/** A default definition for a team the fixtures don't know: plan → work → review, from the roster's roles. */
function defaultTeam(choice: TeamChoice, ids: string[], roleOf: (id: string) => string): StudioTeam {
  const lead = ids.find((id) => /lead/i.test(roleOf(id))) ?? ids[0];
  const reviewers = ids.filter((id) => id !== lead && /review|validat|critic|\bqa\b/i.test(roleOf(id)));
  const workers = ids.filter((id) => id !== lead && !reviewers.includes(id));
  return {
    id: slugId(choice.name),
    name: choice.name,
    tagline: choice.purpose,
    purpose: choice.purpose,
    status: "active",
    origin: "Created in chat",
    members: ids.map((id) => ({ agentId: id, duty: roleOf(id), ...(id === lead ? { lead: true } : {}) })),
    workflow: lead === undefined ? [] : [
      { label: "Plan", agentIds: [lead], note: "Scope, approach and completion criteria" },
      ...(workers.length ? [{ label: "Work", agentIds: workers, note: "Does the work, in parallel where it can" }] : []),
      ...(reviewers.length ? [{ label: "Review", agentIds: reviewers, note: "Accept, or send back to the lead", gate: true }] : []),
    ],
    reworkBudget: DEFAULT_REWORK_BUDGET,
    criteria: DEFAULT_CRITERIA,
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

/** An id, a name or a stored roster entry → the agent or free persona it names (else a slug nobody has). */
function memberId(entry: TeamChoice["roster"][number], world: World): string {
  const raw = (typeof entry === "string" ? entry : entry.agentId || entry.name || "").trim();
  const key = raw.toLowerCase();
  const known = [...world.agents, ...world.pool];
  return known.find((a) => a.id === key)?.id
    ?? known.find((a) => a.name.toLowerCase() === key)?.id
    ?? (typeof entry === "string" || !entry.name ? undefined : known.find((a) => a.name.toLowerCase() === entry.name!.toLowerCase())?.id)
    ?? slugId(raw);
}

/**
 * The team a card stands for: the fixture definition when the name matches, else a default one.
 * Members are what this card authorizes — its roster, minus anyone provisionTeam couldn't create
 * (no agent row and no persona template). A matched definition always keeps its lead: its workflow
 * is built around them. A persona still in the pool that the roster leaves out (Sana) joins when
 * HER card is approved (SEED-1).
 */
export function resolveTeam(choice: TeamChoice, world: World): ResolvedTeam {
  const exists = new Set(world.agents.map((a) => a.id));
  const creatable = (id: string) => exists.has(id) || !!templateFor(id, world.pool);
  const ids = [...new Set(choice.roster.map((r) => memberId(r, world)))].filter((id) => id && creatable(id));
  const matched = fixtureTeam(choice.name);
  const roleOf = (id: string) =>
    world.agents.find((a) => a.id === id)?.role ?? world.pool.find((p) => p.id === id)?.role ?? templateFor(id, world.pool)?.agent.role ?? id;
  const full = matched ?? defaultTeam(choice, ids, roleOf);
  const definition: StudioTeam = {
    ...full,
    members: full.members.filter((m) => (ids.includes(m.agentId) || (matched && m.lead)) && creatable(m.agentId)),
    reworkBudget: choice.reworkBudget ?? full.reworkBudget,
  };
  const templates: Partial<Record<string, StudioProfile>> = {};
  for (const m of definition.members) {
    const t = exists.has(m.agentId) ? undefined : templateFor(m.agentId, world.pool);
    if (t) templates[m.agentId] = t;
  }
  return { definition, templates };
}

/** The Research Lead's defaults, as the demo script shows them (CARD-1); the rework row follows the budget. */
const LEAD_DEFAULTS: ProposalRow[] = [
  { label: "Tools", value: "artifacts.read · workspace.write · team.assign", why: "Plans and assigns the work; doesn't run code himself" },
  { label: "Memory", value: "Team-scoped · no personal memory", why: "Sees project facts, never yours" },
  { label: "Model", value: "Sonnet 5.5", why: "Planning-heavy work at moderate length" },
];

/** Any other new lead's defaults. */
const DEFAULT_LEAD_DEFAULTS: ProposalRow[] = [
  { label: "Tools", value: "artifacts.read · workspace.write · team.assign", why: "Plans and assigns the work; doesn't run code" },
  { label: "Memory", value: "Team-scoped · no personal memory", why: "Sees project facts, never yours" },
];

/**
 * The team card (CARD-1) for what the model chose: name, purpose, roster, workflow, rework budget
 * and criteria are exactly what approval provisions; lead defaults are shown when the lead is new.
 */
export function teamCard(choice: TeamChoice, world: World): TeamProposal {
  const { definition: d, templates } = resolveTeam(choice, world);
  const roster: RosterEntry[] = d.members.map((m) => {
    const agent = world.agents.find((a) => a.id === m.agentId);
    const persona = templates[m.agentId]?.agent;
    return {
      agentId: m.agentId,
      name: agent?.name ?? persona?.name ?? m.agentId,
      role: agent?.role ?? persona?.role ?? m.duty,
      status: agent ? "existing" : "new",
      avatar: agent ? agent.avatar : persona?.avatar?.still,
    };
  });
  const lead = d.members.find((m) => m.lead);
  const newLead = lead && !world.agents.some((a) => a.id === lead.agentId);
  const budgetRow: ProposalRow = {
    label: "Rework budget", value: `${d.reworkBudget} bounces, then it escalates to you`, why: "Bounded autonomy: exhaustion blocks, it never loops",
  };
  return {
    kind: "team",
    name: d.name,
    purpose: d.purpose,
    roster,
    workflow: d.workflow.map((s) => ({ label: s.label, agentIds: s.agentIds, gate: s.gate })),
    reworkBudget: d.reworkBudget,
    criteria: d.criteria,
    ...(newLead ? { leadDefaults: [...(d.id === "research" ? LEAD_DEFAULTS : DEFAULT_LEAD_DEFAULTS), budgetRow] } : {}),
  };
}

/** Role templates for specialist cards: the justified rows a known role always shows. */
const ROLE_TEMPLATES: { match: RegExp; rows: ProposalRow[] }[] = [
  { match: /validat/i, rows: validatorTemplate.rows },
];

/** Rows for a specialist with no role template, when the model gave none. */
const DEFAULT_SPECIALIST_ROWS: ProposalRow[] = [
  { label: "Memory", value: "Team-scoped · no personal memory", why: "Sees project facts, never yours" },
  { label: "Lifecycle", value: "This team · save as reusable agent", why: "Reuse beats creating again" },
];

/**
 * The specialist card for what the model chose: its name and purpose, the persona resolved against
 * the pool (D1: id or name, else the free persona whose role the card names, else the first free one), and the
 * rows from the role template when one matches — the model's own rows only otherwise.
 */
export function specialistCard(choice: SpecialistChoice, world: World): SpecialistProposal {
  const want = typeof choice.persona === "string" ? choice.persona : choice.persona?.id || choice.persona?.name || "";
  const key = want.trim().toLowerCase();
  const named = world.pool.find((p) => p.id === key) ?? world.pool.find((p) => p.name.toLowerCase() === key);
  const known = named ? undefined : world.agents.find((a) => a.id === key);
  const pooled = named ?? (known ? undefined : world.pool.find((p) => choice.name.toLowerCase().includes(p.role.toLowerCase())) ?? world.pool[0]);
  const persona = pooled
    ? { id: pooled.id, name: pooled.name, role: pooled.role, avatar: pooled.avatar.still }
    : known
      ? { id: known.id, name: known.name, role: known.role, avatar: known.avatar ?? "" }
      : undefined;
  const template = ROLE_TEMPLATES.find((t) => t.match.test(choice.name) || (persona && t.match.test(persona.role)));
  const rows = template?.rows ?? (choice.rows?.length ? choice.rows : DEFAULT_SPECIALIST_ROWS);
  return { kind: "specialist", name: choice.name, purpose: choice.purpose, rows, ...(persona ? { persona } : {}) };
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
  input: { row: StoredProposal; world: World; onInbox: (agentId: string) => void },
): Promise<ApprovalOutcome> {
  const { row, world } = input;
  const teamName = row.kind === "team" ? "" : await sessionTeamName(db, row.sessionId ?? "");
  // The stored card is server-filled (teamCard), so resolving it again gives the team it showed.
  const resolved =
    row.kind === "team"
      ? resolveTeam(row.payload as TeamProposal, world)
      : await resolveSpecialistJoin(db, teamName || "Research Team", row.payload as SpecialistProposal, world.pool);
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
