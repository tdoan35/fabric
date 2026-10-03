// SEED-1 (PRD §10.8): before approval, no served surface may mention the Research Team, its
// people or its work. Pure fixture-level: the demo world is what every read model serves.
import { describe, expect, it } from "vitest";
import { buildDemoWorld } from "@fabric/fixtures/profiles";

const LEAK = /elliot|sana\b|research team/i;

describe("demo seed is approval-clean (SEED-1)", () => {
  const world = buildDemoWorld();

  it("no served registry or weave surface mentions hidden personas or teams", () => {
    const served: Record<string, unknown> = {
      agents: world.agents,
      communityAgents: world.communityAgents,
      teams: world.teams,
      communityTeams: world.communityTeams,
      organizations: world.organizations,
      projects: world.projects,
      sessions: world.sessions,
      weaveItems: world.weave.items,
      weavePulse: world.weave.pulse,
      weavePresence: world.weave.presence,
      weaveCalendar: world.weave.calendar,
    };
    for (const [surface, value] of Object.entries(served)) {
      expect(JSON.stringify(value), `${surface} mentions hidden personas/teams`).not.toMatch(LEAK);
    }
  });

  it("the persona pool is the one place the personas appear", () => {
    expect(world.personaPool.map((p) => p.id)).toEqual(["elliot", "sana"]);
  });

  it("no tasks, loops or asks before approval", () => {
    expect(world.tasks).toEqual([]);
    expect(world.runs).toEqual([]);
    expect(world.weave.items).toEqual([]);
  });

  it("IDENTITY.md lists only teams that exist here", () => {
    const jonah = world.agents.find((p) => p.agent.id === "jonah")!;
    expect(jonah.workspace.files.find((f) => f.name === "IDENTITY.md")!.body).toMatch(/Member of: Product Team$/m);
    expect(jonah.workspace.files.find((f) => f.name === "IDENTITY.md")!.body).not.toMatch(/Research Team/);
    for (const id of ["megan", "carlos"]) {
      const body = world.agents.find((p) => p.agent.id === id)!.workspace.files.find((f) => f.name === "IDENTITY.md")!.body;
      expect(body, `${id} still lists a team`).not.toMatch(/^Member of: /m);
    }
  });

  it("Dana's routing memory keeps only the Product Team half", () => {
    const memory = world.agents.find((p) => p.agent.id === "dana")!.workspace.memories.find((m) => m.text.includes("Product Team"))!;
    expect(memory.text).toBe("Product questions go to the Product Team.");
  });

  it("presence references only asks that exist", () => {
    const itemIds = new Set(world.weave.items.map((i) => i.id));
    expect(world.weave.presence.filter((p) => p.itemId && !itemIds.has(p.itemId))).toEqual([]);
  });
});
