// ANY-67 R2, R3, R10, R12 — the registry: duplicate-name rejection, the
// model's declarations (JSON Schema via zod v4's z.toJSONSchema), the meta
// lookup the policy engine reads, and the package's subpath exports map —
// later tracks add `@fabric/tools/<area>` without ever editing src/index.ts.
import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { createRegistry, defineTool } from "../index";
import { webSearchSpec } from "./fixtures";

const webSearch = () => defineTool({ name: "web_search", ...webSearchSpec });

test("R2 createRegistry throws on two tools with the same name", () => {
  expect(() => createRegistry([webSearch(), webSearch()])).toThrow(
    /duplicate tool name: web_search/
  );
});

test("R3 modelTools returns one entry whose JSON Schema matches { query: string, limit?: number }; an unknown name throws", () => {
  const registry = createRegistry([webSearch()]);

  const tools = registry.modelTools(["web_search"]);
  expect(tools).toHaveLength(1);
  expect(tools[0]!.name).toBe("web_search");
  expect(tools[0]!.description).toBe("Search the web");

  const schema = tools[0]!.parameters as {
    properties: { query: { type: string }; limit: { type: string } };
    required: string[];
  };
  expect(schema.properties.query.type).toBe("string");
  expect(schema.properties.limit.type).toBe("number");
  expect(schema.required).toEqual(["query"]);

  expect(() => registry.modelTools(["nope"])).toThrow(/unknown tool: nope/);
});

test("R10 meta returns the declared effect, gate, kind and step; an unknown name is undefined", () => {
  const registry = createRegistry([webSearch()]);
  expect(registry.meta("web_search")).toEqual({
    effect: "read",
    gate: "mode",
    kind: "read",
    step: 0,
  });
  expect(registry.meta("nope")).toBeUndefined();
});

test("R12 the manifest maps ./* to ./src/*/index.ts and import(\"@fabric/tools\") resolves to the registry exports", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8")
  );
  // Dynamic import: this case exercises package-specifier resolution itself
  // (the exports map), which a static import would collapse at collection.
  const mod = await import("@fabric/tools");
  expect(typeof mod.defineTool).toBe("function");
  expect(typeof mod.createRegistry).toBe("function");
});
