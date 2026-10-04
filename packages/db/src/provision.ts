// The one shared "make it exist" path for approved teams and specialists (WORK-PLAN DANA 3, D1).
// DANA's approval handler and the dev sim both call this, so a real approval and POST /api/dev/sim
// produce the same registry rows and org edge. DATA owns the package; DANA owns this file's intent.
//
// Idempotent: agent rows, team_members, the org slot and the handoff edge are only inserted when
// missing, so calling it again when the specialist is approved just adds the new rows.
import { sql } from "drizzle-orm";
import type { StudioProfile, StudioTeam } from "@fabric/contracts";
import type { Db } from "./db";

export interface ProvisionTeamInput {
  /** The full team definition, members in roster order. An existing team row is left as-is. */
  team: StudioTeam;
  /**
   * Persona templates for members that have no agent row yet (the persona pool, D1). A member
   * without a row and without a template is skipped: the registry never references a missing agent.
   */
  templates?: Partial<Record<string, StudioProfile>>;
  /** `teams.origin` when this call creates the team. Defaults to the definition's own origin. */
  origin?: string;
  /**
   * Org wiring. Defaults to the demo org: a slot in ty-lab and, once the other team exists too,
   * the Research → Product preview edge (WORK-PLAN §4.8).
   */
  org?: { id?: string; slotKey?: string; handoffTo?: string; handoffQuestion?: string };
}

export interface ProvisionTeamResult {
  teamId: string;
  /** True when this call inserted the teams row. */
  teamCreated: boolean;
  /** Agent rows this call inserted; each also left the persona pool. */
  createdAgents: string[];
}

export async function provisionTeam(db: Db, input: ProvisionTeamInput): Promise<ProvisionTeamResult> {
  const { team } = input;
  const org = input.org ?? {};
  const orgId = org.id ?? "ty-lab";
  const slotKey = org.slotKey ?? `${team.id}-1`;
  const handoffTo = org.handoffTo ?? "product";
  const question = org.handoffQuestion ?? "Can these results drive a real, value-driven product?";

  // Round trips are batched where order doesn't matter: approval sits in front of Dana's next
  // model call, and each query is a network hop to Neon.
  // ---- agents (only the missing ones; new ones leave the persona pool) ----
  const ids = team.members.map((m) => m.agentId);
  const existing = new Set(
    ids.length
      ? (await db.db.execute(sql`select id from agents where id in ${ids}`)).rows.map((r) => (r as { id: string }).id)
      : [],
  );
  const createdAgents: string[] = [];
  for (const m of team.members) {
    if (existing.has(m.agentId)) continue;
    const profile = input.templates?.[m.agentId];
    if (!profile) continue;
    await db.db.transaction(async (tx) => {
      // Registry order: after every existing row, under the agents lock so parallel calls can't tie.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('agents', 0))`);
      const next = await tx.execute(sql`select coalesce(max(ord), -1) + 1 as ord from agents`);
      const ord = Number((next.rows[0] as { ord: string | number }).ord);
      await tx.execute(sql`
        insert into agents (id, ord, name, role, tagline, summary, personality, traits, tone, avatar, model,
                            context_tokens, memory, tools, greeting, placeholder, workspace, origin, community, status, is_seeded)
        values (${profile.agent.id}, ${ord}, ${profile.agent.name}, ${profile.agent.role}, ${profile.tagline},
                ${profile.agent.summary}, ${profile.agent.personality}, ${JSON.stringify(profile.agent.traits)}::jsonb,
                ${profile.agent.tone}, ${JSON.stringify(profile.agent.avatar ?? null)}::jsonb, ${profile.agent.model},
                ${profile.agent.contextTokens}, ${JSON.stringify(profile.agent.memory)}::jsonb,
                ${JSON.stringify(profile.agent.tools)}::jsonb, ${profile.agent.greeting}, ${profile.agent.placeholder},
                ${JSON.stringify(profile.workspace)}::jsonb, ${profile.origin ?? input.origin ?? "Created in chat"},
                false, 'active', false)
        on conflict do nothing`);
      await tx.execute(sql`delete from persona_pool where id = ${m.agentId}`);
    });
    createdAgents.push(m.agentId);
  }

  // ---- the team ----
  const teamThere = await db.db.execute(sql`select 1 from teams where id = ${team.id}`);
  let teamCreated = false;
  if (!teamThere.rows.length) {
    const ord = await db.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('teams', 0))`);
      const next = await tx.execute(sql`select coalesce(max(ord), -1) + 1 as ord from teams`);
      const o = Number((next.rows[0] as { ord: string | number }).ord);
      await tx.execute(sql`
        insert into teams (id, ord, name, tagline, purpose, status, origin, workflow, criteria, rework_budget)
        values (${team.id}, ${o}, ${team.name}, ${team.tagline}, ${team.purpose}, ${team.status},
                ${input.origin ?? team.origin}, ${JSON.stringify(team.workflow)}::jsonb,
                ${JSON.stringify(team.criteria)}::jsonb, ${team.reworkBudget})
        on conflict do nothing`);
      return o;
    });
    void ord;
    teamCreated = true;
  }

  // ---- members (roster order; re-adding a member is a no-op) ----
  const have = new Set([...existing, ...createdAgents]);
  const rows = [...team.members.entries()].filter(([, m]) => have.has(m.agentId));
  if (rows.length) {
    await db.db.execute(sql`
      insert into team_members (team_id, agent_id, ord, duty, lead)
      values ${sql.join(rows.map(([mi, m]) => sql`(${team.id}, ${m.agentId}, ${mi}, ${m.duty}, ${m.lead ?? false})`), sql`, `)}
      on conflict do nothing`);
  }

  // ---- org slot, and the preview edge once both teams exist ----
  await db.db.execute(sql`
    insert into org_slots (org_id, key, ord, team_id)
    select ${orgId}, ${slotKey}, (select coalesce(max(ord), -1) + 1 from org_slots where org_id = ${orgId}), ${team.id}
    where exists (select 1 from organizations where id = ${orgId})
    on conflict do nothing`);
  await db.db.execute(sql`
    insert into org_handoffs (org_id, from_team_id, to_team_id, ord, question, preview)
    select ${orgId}, ${team.id}, ${handoffTo}, 0, ${question}, true
    where exists (select 1 from teams where id = ${handoffTo})
    on conflict do nothing`);

  return { teamId: team.id, teamCreated, createdAgents };
}
