// SCH unit tests: the scheduled turn's prompt carries Dana's memories and the read-only rules on
// top of her usual system prompt, and the fixture digest is canned. No network, no database.
import { describe, expect, it } from "vitest";
import { fallbackDana } from "../assistant/prompt";
import type { RegistryBrief } from "../assistant/prompt";
import { fixtureDigest, scheduledSystem } from "../assistant/scheduled";

const registry: RegistryBrief = { agents: [], teams: [], personaPool: [] };

describe("scheduledSystem", () => {
  it("keeps her usual prompt, then her memories, then the routine's read-only rules", () => {
    const dana = {
      ...fallbackDana(),
      workspace: {
        ...fallbackDana().workspace,
        memories: [{ text: "Short replies. Lead with the answer.", source: "USER.md", when: "" }],
      },
    };
    const system = scheduledSystem(dana, registry, "Give me the morning digest.");
    expect(system).toContain("# SOUL.md"); // her files came along
    expect(system).toContain("## Your memories");
    expect(system).toContain("Short replies. Lead with the answer.");
    expect(system).toContain("scheduled routine, not a reply to Ty");
    expect(system).toContain("no proposals, no handoffs");
    expect(system.trimEnd().endsWith("Give me the morning digest.")).toBe(true);
  });
});

describe("fixtureDigest", () => {
  it("is a canned digest that leads with what changed", () => {
    const digest = fixtureDigest();
    expect(digest).toContain("Three things since yesterday:");
    expect(digest.split("\n").filter((l) => /^\d\./.test(l))).toHaveLength(3);
  });
});
