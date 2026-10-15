// ANY-81 T14 — the listed cases J1..J5, verbatim from the card. The toolset is
// the pure layer between an agent's registry row and the session definition:
// LEGACY_TOOL_MAP expands the legacy row names, definitionAccess intersects
// with the registry's available tools (strictest policy wins), and withToolset
// appends the surviving tools to a definition in registry order. Pure: same
// inputs, same definition — a re-stamp cannot fork a turn's shape.
import { expect, test } from "vitest";
import { z } from "zod";
import { createRegistry, defineTool } from "@fabric/tools";
import {
  LEGACY_TOOL_MAP,
  danaSessionDef,
  definitionAccess,
  specialistSessionDef,
  withBridges,
  withToolset,
  type SpecialistAgent,
  type SpecialistSessionDef,
} from "../../assistant/session";

const AVAILABLE = new Set([
  "web_search",
  "web_fetch",
  "shell",
  "read_file",
  "write_file",
  "edit_file",
  "search_files",
]);

type Row = { name: string; policy: "allowed" | "approval" | "blocked" };
type Access = Record<string, "allowed" | "approval" | "blocked">;

const FAKE_AGENT: SpecialistAgent = {
  id: "researcher",
  name: "Renna",
  role: "Research",
  instructions: "# SOUL.md\n\nYou are the studio's researcher.",
};

interface FakeMeta {
  effect?: "read" | "once" | "rerunnable";
  gate?: "none" | "mode" | "always";
  kind?: "read" | "edit" | "command" | "external";
}

const fakeTool = (name: string, meta: FakeMeta = {}) =>
  defineTool({
    name,
    description: `${name} fixture`,
    parameters: z.object({}),
    effect: meta.effect ?? "read",
    gate: meta.gate ?? "none",
    kind: meta.kind ?? "read",
    step: 0,
    execute: () => ({}),
  });

// -- J1 ------------------------------------------------------------------------

test("J1 definitionAccess: legacy rows expand, unknown names drop, strictest policy wins", () => {
  const access = definitionAccess(
    [
      { name: "exa.search", policy: "allowed" },
      { name: "sprite.exec", policy: "approval" },
      { name: "network.fetch", policy: "blocked" },
      { name: "web_fetch", policy: "allowed" },
      { name: "artifacts.read", policy: "allowed" },
      { name: "docs.write", policy: "allowed" },
    ] satisfies Row[],
    AVAILABLE,
  );

  expect(access).toEqual({
    web_search: "allowed",
    shell: "approval",
    read_file: "approval",
    write_file: "approval",
    edit_file: "approval",
    search_files: "approval",
    // blocked (network.fetch) beats the direct allowed row
    web_fetch: "blocked",
  });
  // display-only names map to nothing
  expect("artifacts.read" in access).toBe(false);
  expect("docs.write" in access).toBe(false);
});

// -- J2 ------------------------------------------------------------------------

test("J2 definitionAccess: a row outside available maps to nothing; defaults fill only unmentioned tools", () => {
  const withoutSend = new Set(["web_search", "web_fetch"]);
  const access = definitionAccess([{ name: "agentmail.send", policy: "allowed" }] satisfies Row[], withoutSend);
  expect("send" in access).toBe(false);
  expect(access).toEqual({});

  const withDefaults = definitionAccess(
    [{ name: "exa.search", policy: "allowed" }] satisfies Row[],
    new Set(["web_search", "shell", "read_file"]),
    { web_search: "approval", shell: "allowed", read_file: "approval" } satisfies Access,
  );
  // the row mentioned web_search: its policy stands, the default does not apply
  expect(withDefaults).toEqual({ web_search: "allowed", shell: "allowed", read_file: "approval" });
});

// -- J3 ------------------------------------------------------------------------

test("J3 withToolset appends in registry order with metas; blocked tools appear nowhere", () => {
  const alpha = fakeTool("alpha", { effect: "read", gate: "none", kind: "read" });
  const beta = fakeTool("beta", { effect: "once", gate: "always", kind: "external" });
  const gamma = fakeTool("gamma", { effect: "rerunnable", gate: "mode", kind: "edit" });
  const registry = createRegistry([alpha, beta, gamma]);

  const def = specialistDef();
  const base = def.tools.length;

  // access keyed out of registry order: the append follows the registry
  const next = withToolset(def, {
    registry,
    access: { beta: "allowed", alpha: "approval", gamma: "blocked" },
  }) as typeof def;

  expect(next.tools).toEqual([...def.tools, "alpha", "beta"]);
  expect(next.toolSchemas.slice(base)).toEqual(registry.modelTools(["alpha", "beta"]));
  expect(next.toolEffects.alpha).toBe("read");
  expect(next.toolEffects.beta).toBe("once");
  expect(next.toolPolicy.alpha).toEqual({ access: "approval", gate: "none", kind: "read" });
  expect(next.toolPolicy.beta).toEqual({ access: "allowed", gate: "always", kind: "external" });
  // blocked: in none of the four
  expect(next.tools).not.toContain("gamma");
  expect(next.toolSchemas.map((schema) => schema.name)).not.toContain("gamma");
  expect("gamma" in next.toolEffects).toBe(false);
  expect("gamma" in next.toolPolicy).toBe(false);
});

// -- J4 ------------------------------------------------------------------------

test("J4 withToolset with nothing surviving is the identity, on the S8b and S9 stamps alike", () => {
  const registry = createRegistry([fakeTool("web_search"), fakeTool("write_file")]);

  const dana = withBridges(danaSessionDef());
  expect(withToolset(dana, { registry, access: {} })).toEqual(dana);
  expect(
    withToolset(dana, { registry, access: { web_search: "blocked", write_file: "blocked" } }),
  ).toEqual(dana);

  const specialist = specialistDef();
  expect(withToolset(specialist, { registry, access: {} })).toEqual(specialist);
});

// -- J5 ------------------------------------------------------------------------

test("J5 withToolset is deterministic; a session-tool collision throws, naming the tool", () => {
  const registry = createRegistry([fakeTool("web_search"), fakeTool("recall")]);

  const dana = withBridges(danaSessionDef());
  const access: Access = { web_search: "allowed", recall: "allowed" };
  expect(withToolset(dana, { registry, access })).toEqual(withToolset(dana, { registry, access }));

  // dana's definition already carries recall: the collision names it
  expect(() => withToolset(dana, { registry, access: { recall: "allowed" } })).toThrow(/recall/);
});

// -- the frozen map ------------------------------------------------------------

test("J5b LEGACY_TOOL_MAP is frozen and carries exactly the five mapped rows", () => {
  expect(Object.isFrozen(LEGACY_TOOL_MAP)).toBe(true);
  expect(Object.keys(LEGACY_TOOL_MAP).sort()).toEqual(
    ["agentmail.send", "exa.search", "network.fetch", "sprite.exec", "workspace.write"].sort(),
  );
  expect(LEGACY_TOOL_MAP["sprite.exec"]).toEqual([
    "shell",
    "read_file",
    "write_file",
    "edit_file",
    "search_files",
  ]);
});

// -- helpers -------------------------------------------------------------------

type SpecialistDef = SpecialistSessionDef & {
  tools: string[];
  toolSchemas: { name: string }[];
  toolEffects: Record<string, string>;
  toolPolicy: Record<string, { access: string; gate: string; kind: string }>;
};

function specialistDef(): SpecialistDef {
  return specialistSessionDef(FAKE_AGENT) as unknown as SpecialistDef;
}
