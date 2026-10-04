import { describe, expect, it } from "vitest";
import { buildDemoWorld } from "@fabric/fixtures/profiles";
import { specialistProposal as validator, teamProposal as scriptedTeam } from "@fabric/fixtures/chat";
import type { TeamProposal } from "@fabric/contracts";
import { resolveTeam, specialistCard, teamCard } from "../assistant/teams";
import type { World } from "../assistant/teams";

// The card is the team: the model picks a name, a purpose and who; everything else on the card
// comes from the definition approval provisions, so what Ty approves is what gets created.

const demo = buildDemoWorld();
const world: World = {
  agents: demo.agents.map((p) => ({ id: p.agent.id, name: p.agent.name, role: p.agent.role, avatar: p.agent.avatar?.still })),
  pool: demo.personaPool,
};

/** What provisionTeam would be handed on approval of this stored card. */
const provisioned = (card: TeamProposal) => {
  const { definition, templates } = resolveTeam(card, world);
  return {
    members: definition.members.map((m) => m.agentId),
    workflow: definition.workflow.map((s) => ({ label: s.label, agentIds: s.agentIds, gate: s.gate })),
    criteria: definition.criteria,
    reworkBudget: definition.reworkBudget,
    templates: Object.keys(templates),
  };
};

describe("teamCard", () => {
  it("fills the Research Team from its definition, whatever the model called it or added", () => {
    const card = teamCard({ name: "Engram Research Team", purpose: "Test the idea.", roster: ["elliot", "megan", "jonah", "carlos", "lila"] }, world);
    expect(card.name).toBe("Research Team");
    expect(card.roster.map((r) => r.agentId)).toEqual(["elliot", "megan", "jonah", "carlos"]);
    expect(card.roster[0]).toMatchObject({ name: "Elliot", role: "Research Lead", status: "new" });
    expect(card.roster[0].avatar).toBeTruthy();
    expect(card.roster.slice(1).every((r) => r.status === "existing")).toBe(true);
    expect(card.workflow).toHaveLength(6);
    expect(card.criteria).toHaveLength(4);
    expect(card.reworkBudget).toBe(2);
    expect(card.leadDefaults?.map((r) => r.label)).toEqual(["Tools", "Memory", "Model", "Rework budget"]);
  });

  it("is exactly what approval provisions: members, workflow, criteria, rework budget", () => {
    const card = teamCard({ name: "Research Team", purpose: "x", roster: ["elliot", "megan", "jonah", "carlos"] }, world);
    const made = provisioned(card);
    expect(made.members).toEqual(card.roster.map((r) => r.agentId));
    expect(made.workflow).toEqual(card.workflow);
    expect(made.criteria).toEqual(card.criteria);
    expect(made.reworkBudget).toBe(card.reworkBudget);
    expect(made.templates).toEqual(["elliot"]); // only the new lead is created
  });

  it("resolves names and stored roster objects to ids, and keeps a matched team's lead", () => {
    const card = teamCard({ name: "Research Team", purpose: "x", roster: ["Megan", { agentId: "jonah" }, { name: "Carlos" }] }, world);
    expect(card.roster.map((r) => r.agentId)).toEqual(["elliot", "megan", "jonah", "carlos"]);
  });

  it("keeps a re-proposal's rework budget through approval", () => {
    const card = teamCard({ name: "Research Team", purpose: "x", roster: ["elliot", "megan", "jonah", "carlos"], reworkBudget: 3 }, world);
    expect(card.reworkBudget).toBe(3);
    expect(card.leadDefaults?.at(-1)?.value).toMatch(/^3 bounces/);
    expect(provisioned(card).reworkBudget).toBe(3);
  });

  it("gives a team the fixtures don't know a default plan → work → review definition", () => {
    const card = teamCard({ name: "Launch Team", purpose: "Ship the first build.", roster: ["diego", "maya", "jonah", "carlos", "nobody"] }, world);
    expect(card.name).toBe("Launch Team");
    expect(card.roster.map((r) => r.agentId)).toEqual(["diego", "maya", "jonah", "carlos"]); // nobody can't be created
    expect(card.workflow).toEqual([
      { label: "Plan", agentIds: ["diego"], gate: undefined },
      { label: "Work", agentIds: ["maya", "jonah"], gate: undefined },
      { label: "Review", agentIds: ["carlos"], gate: true },
    ]);
    expect(card.criteria?.length).toBeGreaterThan(0);
    expect(card.reworkBudget).toBe(2);
    expect(card.leadDefaults).toBeUndefined(); // Diego already exists
    const made = provisioned(card);
    expect(made.members).toEqual(["diego", "maya", "jonah", "carlos"]);
    expect(made.workflow).toEqual(card.workflow);
    expect(made.criteria).toEqual(card.criteria);
  });

  it("shows lead defaults for a new lead from the pool on an unknown team", () => {
    const card = teamCard({ name: "Audit Team", purpose: "Audit it.", roster: ["elliot", "carlos"] }, world);
    expect(card.roster[0]).toMatchObject({ agentId: "elliot", status: "new" });
    expect(card.leadDefaults?.at(-1)?.label).toBe("Rework budget");
  });

  it("comes out empty when nobody on the roster can join", () => {
    expect(teamCard({ name: "Ghost Team", purpose: "x", roster: ["nobody"] }, world).roster).toEqual([]);
  });
});

describe("specialistCard", () => {
  it("takes the Validator's rows from the role template and the persona from the pool", () => {
    const card = specialistCard({ name: "Validator", purpose: "Checks the results.", persona: "sana" }, world);
    expect(card.rows).toEqual(validator.rows);
    expect(card.persona).toMatchObject({ id: "sana", name: "Sana", role: "Validator" });
    expect(card.persona?.avatar).toBeTruthy();
    expect(card.purpose).toBe("Checks the results.");
  });

  it("matches the template on the persona's role, and the persona on the role the card names", () => {
    expect(specialistCard({ name: "Sana", purpose: "x", persona: { id: "sana", name: "Sana" } }, world).rows).toEqual(validator.rows);
    expect(specialistCard({ name: "Independent Validator", purpose: "x" }, world).persona?.id).toBe("sana");
  });

  it("keeps the model's rows only when no template matches, with defaults when it gave none", () => {
    const rows = [{ label: "Tools", value: "R", why: "stats" }];
    expect(specialistCard({ name: "Statistician", purpose: "x", persona: "elliot", rows }, world).rows).toEqual(rows);
    expect(specialistCard({ name: "Statistician", purpose: "x", persona: "elliot" }, world).rows.length).toBeGreaterThan(0);
  });
});

// One source for the cards: the web mock streams @fabric/fixtures/chat as-is, and scripted Dana
// builds its cards from the same choices. On the demo seed they must come out identical, so offline
// mode shows exactly the cards the live demo does.
describe("the scripted payloads", () => {
  const withoutId = <T extends { proposalId?: string }>({ proposalId: _, ...rest }: T) => rest;

  it("are the team card the server builds on the demo seed", () => {
    const card = teamCard({ name: scriptedTeam.name, purpose: scriptedTeam.purpose, roster: scriptedTeam.roster.map((r) => r.agentId) }, world);
    expect(card).toEqual(withoutId(scriptedTeam));
  });

  it("are the specialist card the server builds on the demo seed", () => {
    const card = specialistCard({ name: validator.name, purpose: validator.purpose, persona: validator.persona?.id }, world);
    expect(card).toEqual(withoutId(validator));
  });
});
