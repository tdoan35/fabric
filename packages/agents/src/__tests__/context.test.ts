// CTX unit tests: the brief never carries transcript text, section tokens add up,
// empty USER.md → empty preferences, notLoaded per role, plus snapshot contract validation.
// No network: compileBrief runs against a mock model from the AI SDK test utils.
import { describe, expect, it } from "vitest";
import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { BriefSchema, ContextSnapshotSchema } from "@fabric/contracts";
import type { Brief, StudioProfile, ToolName, ToolPolicy } from "@fabric/contracts";
import { profileById } from "@fabric/fixtures/studio";
import { run as runFixture } from "@fabric/fixtures/run";
import { assembleContext, compileBrief, countTokens, measureAssistantContext, preferenceItems, renderBrief } from "../context";

const briefFixture: Brief = runFixture.brief;
const REQUEST = "Test whether an n-gram lookup table helps a 135M open model hold out perplexity, with the table kept on disk.";

/** A mock Dana: returns a valid compiled brief and records what it was asked. */
function mockDana(overrides: Record<string, unknown> = {}) {
  const compiled = {
    objective: "Test whether fusing an n-gram lookup table into a 135M open model lowers held-out perplexity, with the table kept on disk.",
    constraints: ["Cached corpus only; no new downloads", "The table stays on disk, never loaded into RAM"],
    criteria: ["Baseline and fused model evaluated on the same split", "Sana reproduces the headline number"],
    preferences: ["Short status updates", "Results with evidence"],
    ...overrides,
  };
  const mock = new MockLanguageModelV4({
      doGenerate: async (): Promise<LanguageModelV4GenerateResult> => ({
        content: [{ type: "text", text: JSON.stringify(compiled) }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: undefined, reasoning: undefined },
        },
        warnings: [],
      }),
  });
  return { mock, compiled };
}

/** Sana as the fixture snapshots treat her: a USER.md with no items (the seeded studio.ts hasn't caught up; see status notes). */
const sanaNoPrefs = (() => {
  const sana = profileById("sana");
  return {
    ...sana,
    workspace: {
      ...sana.workspace,
      files: sana.workspace.files.map((f) => (f.name === "USER.md" ? { ...f, body: "# USER.md\n\nEmpty until you add Sana. Dana fills in only what this role needs.\n" } : f)),
    },
  };
})();

describe("countTokens", () => {
  it("is an o200k estimate: deterministic, non-zero, flagged estimated", () => {
    const a = countTokens("Objective: test the n-gram fusion on the 135M model.");
    expect(a.tokens).toBeGreaterThan(5);
    expect(a).toEqual(countTokens("Objective: test the n-gram fusion on the 135M model."));
    expect(a.estimated).toBe(true);
  });
});

describe("compileBrief", () => {
  const input = {
    request: REQUEST,
    team: { name: "Research Team", purpose: "Investigates ideas end to end.", criteria: runFixture.brief.criteria },
    specialists: [profileById("jonah"), profileById("sana")],
    constraints: ["Cached corpus only; no new downloads"],
  };

  it("compiles from the request and counts the rendered brief; stayed is always STAYED", async () => {
    const { mock, compiled } = mockDana();
    const brief = await compileBrief(input, { model: mock });
    expect(brief.objective).toBe(compiled.objective);
    expect(brief.criteria).toEqual(compiled.criteria);
    expect(brief.stayed).toEqual(["Your chat with Dana", "Dana's memory of you", "Your other threads and projects"]);
    expect(brief.tokens).toBe(countTokens(renderBrief(brief)).tokens);
    expect(BriefSchema.safeParse(brief).success).toBe(true);
  });

  it("never sends or returns transcript text: the prompt carries only request, team criteria and USER.md items", async () => {
    const { mock } = mockDana();
    await compileBrief(input, { model: mock });
    const params = mock.doGenerateCalls[0];
    const prompt = JSON.stringify(params.prompt);
    expect(prompt).toContain(REQUEST);
    expect(prompt).toContain("Baseline and fused model evaluated on the same split");
    expect(prompt).toContain("Short status updates");
    // the user payload never mentions a transcript; only the system rule does, by name
    const userPayload = JSON.stringify(params.prompt.filter((m) => m.role === "user"));
    expect(userPayload).not.toMatch(/transcript/i);
    // and the rendered brief is exactly the six fixed fields — nowhere for transcript text to land
    const brief = await compileBrief(input, { model: mock });
    expect(Object.keys(brief).sort()).toEqual(["constraints", "criteria", "objective", "preferences", "stayed", "tokens"]);
  });
});

describe("preferenceItems", () => {
  it("reads the Wants line of a specialist's USER.md", () => {
    expect(preferenceItems(profileById("jonah"))).toEqual(["Short status updates", "Results with evidence"]);
  });
  it("is empty for a role with no USER.md items", () => {
    expect(preferenceItems(sanaNoPrefs)).toEqual([]);
  });
});

describe("assembleContext", () => {
  const tools = (pairs: [ToolName, ToolPolicy][]) => pairs.map(([name, policy]) => ({ name, policy }));
  const base = {
    run: runFixture,
    step: "Setup",
    brief: briefFixture,
    artifactRefs: [] as { id: string; name: string; by?: string }[],
    teamKnowledge: [] as string[],
    leadName: "Elliot",
  };

  async function snapshotFor(agent: StudioProfile, over: Partial<Parameters<typeof assembleContext>[0]> = {}) {
    const { system, snapshot } = await assembleContext({ ...base, agent, tools: tools([["sprite.exec", "allowed"]]), t: 6, ...over });
    return { system, snapshot };
  }

  it("uses the mock's labels and sources, with real content on every section", async () => {
    const { snapshot } = await snapshotFor(profileById("jonah"));
    expect(snapshot.sections.map((s) => s.label)).toEqual([
      "Soul / identity", "Task brief", "Tools & policy", "User preferences", "Artifact references", "Team knowledge",
    ]);
    expect(snapshot.sections.map((s) => s.source)).toEqual([
      "SOUL.md · IDENTITY.md", "compiled by Dana", "Executor", "USER.md · 2 items", "links, not content", "retrieved on demand",
    ]);
    for (const s of snapshot.sections) {
      expect(s.content!.length).toBeGreaterThan(0);
      expect(s.tokens).toBe(countTokens(s.content!).tokens);
      expect(s.estimated).toBe(true);
    }
  });

  it("section tokens sum to totalTokens, and system is the sections joined", async () => {
    const { system, snapshot } = await snapshotFor(profileById("jonah"));
    expect(snapshot.totalTokens).toBe(snapshot.sections.reduce((n, s) => n + s.tokens, 0));
    expect(system).toBe(snapshot.sections.map((s) => s.content).join("\n\n"));
    expect(snapshot.totalTokens).toBeGreaterThan(0);
  });

  it("the snapshot validates against the contract schema", async () => {
    const { snapshot } = await snapshotFor(profileById("jonah"));
    expect(ContextSnapshotSchema.safeParse({ ...snapshot, id: "snap-test" }).success).toBe(true);
  });

  it("the Task brief section is the inspector's rendering: objective, done-when, constraints, budget", async () => {
    const { snapshot } = await snapshotFor(profileById("jonah"));
    const content = snapshot.sections[1].content!;
    expect(content).toContain(`Objective: ${briefFixture.objective}`);
    expect(content).toContain(`- ${briefFixture.criteria[0]}`);
    expect(content).toContain(`- ${briefFixture.constraints[0]}`);
    expect(content).toContain(`Budget: rework ${runFixture.reworkBudget} · 4h 00m`);
  });

  it("a role with no USER.md items gets an empty preferences section", async () => {
    const { snapshot } = await snapshotFor(sanaNoPrefs, { tools: tools([["artifacts.read", "allowed"]]) });
    const prefs = snapshot.sections[3];
    expect(prefs.source).toBe("USER.md · 0 items");
    expect(prefs.content).toBe("None for this role. Dana passes on only what the role needs.");
  });

  it("notLoaded and note are right for each role", async () => {
    const lead = await snapshotFor(profileById("elliot"), { tools: tools([["artifacts.read", "allowed"]]) });
    expect(lead.snapshot.notLoaded).toBe("your chat transcript · personal memory · members' tool schemas");
    expect(lead.snapshot.note).toBe("Soul, brief and the team's workflow. Members' tools stay with them.");

    const investigator = await snapshotFor(profileById("megan"), { tools: tools([["exa.search", "allowed"]]) });
    expect(investigator.snapshot.notLoaded).toBe("your chat transcript · personal memory · the code sandbox");
    expect(investigator.snapshot.note).toBe("Soul, brief and search tools. No sandbox, no personal memory.");

    const coder = await snapshotFor(profileById("jonah"));
    expect(coder.snapshot.notLoaded).toBe("your chat transcript · personal memory · other specialists' skills");
    expect(coder.snapshot.note).toBe("Soul, task brief, tool policy. No chat transcript, no personal memory.");

    const validator = await snapshotFor(profileById("sana"), { tools: tools([["artifacts.read", "allowed"]]) });
    expect(validator.snapshot.notLoaded).toBe("your chat transcript · personal memory · Elliot's plan rationale");
    expect(validator.snapshot.note).toBe("Restricted: cannot edit acceptance criteria.");
    expect(validator.snapshot.tools).toEqual([{ name: "artifacts.read", policy: "allowed" }]);

    const reviewer = await snapshotFor(profileById("carlos"), { tools: tools([["artifacts.read", "allowed"]]) });
    expect(reviewer.snapshot.notLoaded).toBe("your chat transcript · personal memory · Elliot's plan rationale");
    expect(reviewer.snapshot.note).toBe("Reads the evidence, not the reasoning that produced it, so the review stays independent.");
  });

  it("notes grow with what the step actually loaded: artifact refs and team knowledge", async () => {
    const coder = await snapshotFor(profileById("jonah"), {
      artifactRefs: [{ id: "art-1", name: "survey.md", by: "Megan" }, { id: "art-2", name: "plan.md", by: "Elliot" }],
    });
    expect(coder.snapshot.note).toBe("Soul, task brief, tool policy, 2 artifact refs. No chat transcript, no personal memory.");
    expect(coder.snapshot.sections[4].content).toContain("artifact://survey.md (from Megan)");

    const validator = await snapshotFor(profileById("sana"), {
      tools: tools([["artifacts.read", "allowed"]]),
      teamKnowledge: ["Earlier loop: split overlap inflated the first gain"],
    });
    expect(validator.snapshot.note).toBe("Restricted: cannot edit acceptance criteria. Sees project facts, never yours.");
    expect(validator.snapshot.sections[5].content).toContain("split overlap");
  });

  it("carries the sandbox and stamps run/agent/step/t", async () => {
    const { snapshot } = await snapshotFor(profileById("jonah"), { sandbox: "sprite/fabric-coder-7f3 · egress: package index + model host only" });
    expect(snapshot.sandbox).toBe("sprite/fabric-coder-7f3 · egress: package index + model host only");
    expect(snapshot).toMatchObject({ runId: runFixture.id, agentId: "jonah", step: "Setup", assembledAtS: 6 });
  });
});

describe("measureAssistantContext", () => {
  it("measures Dana's base context with the same counter", () => {
    const dana = profileById("dana");
    const tokens = measureAssistantContext(dana);
    expect(tokens).toBeGreaterThan(300);
    expect(tokens).toBe(measureAssistantContext(dana));
  });
});
