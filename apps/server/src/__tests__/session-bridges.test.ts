// ANY-58 S8b — the server half of the bridge registration: the definition the
// session stream is stamped with carries the bridge tools (`once` effects, the
// S2 disposition kinds) for Dana — incognito included, the placeholder agents
// untouched — and the worker ToolPort serves them with their `once` effect.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openStore, type RuntimeStore } from "@fabric/runtime";
import { expect, test } from "vitest";
import { InProcessLiveBus } from "../runtime/live-bus";
import { sessionTurnDefinition, workerPorts } from "../runtime/bootstrap";

const BRIDGE_DISPOSITIONS = {
  handoff_to_team: { kind: "team", targetArg: "teamId" },
  browser_task: { kind: "agent", target: "browser" },
};

const bridgeToolsOf = (definition: Record<string, unknown>) => {
  const tools = definition.tools as string[];
  const effects = definition.toolEffects as Record<string, string>;
  return { tools, effects };
};

test("the stamped dana definition carries the bridge tools: once effects and the S2 disposition kinds", async () => {
  const definition = await sessionTurnDefinition("dana") as Record<string, unknown>;
  const { tools, effects } = bridgeToolsOf(definition);

  expect(tools).toContain("handoff_to_team");
  expect(tools).toContain("browser_task");
  expect(effects.handoff_to_team).toBe("once");
  expect(effects.browser_task).toBe("once");
  expect(definition.dispositionKinds).toEqual(BRIDGE_DISPOSITIONS);

  const schemas = definition.toolSchemas as { name: string }[];
    expect(schemas.map((schema) => schema.name)).toContain("handoff_to_team");
  expect(schemas.map((schema) => schema.name)).toContain("browser_task");
});

test("incognito keeps the bridges while dropping only the memory path", async () => {
  const definition = await sessionTurnDefinition("dana", { incognito: true }) as Record<string, unknown>;
  const { tools, effects } = bridgeToolsOf(definition);

  expect(tools).toContain("handoff_to_team");
  expect(tools).toContain("browser_task");
  expect(effects.handoff_to_team).toBe("once");
  expect(effects.browser_task).toBe("once");
  expect(definition.dispositionKinds).toEqual(BRIDGE_DISPOSITIONS);
  expect(tools).not.toContain("recall");
});

test("the placeholder definition stays placeholder: no bridge tools on non-dana agents", async () => {
  const definition = await sessionTurnDefinition("anyone-else") as Record<string, unknown>;
  const { tools } = bridgeToolsOf(definition);
  expect(tools).not.toContain("handoff_to_team");
  expect(tools).not.toContain("browser_task");
});

test("the worker ToolPort serves both bridges with their once effect", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "fabric-s8b-server-"));
  const store: RuntimeStore = await openStore({ driver: "pglite", dataDir });
  try {
    const ports = workerPorts({ MODEL_PORT: "test" }, new InProcessLiveBus(), undefined, store);
    const describe = (name: string) => ports.tools?.describe(name);

    expect(describe("handoff_to_team")).toMatchObject({ effect: "once" });
    expect(describe("browser_task")).toMatchObject({ effect: "once" });
    expect(describe("not_a_tool")).toBeUndefined();
  } finally {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
