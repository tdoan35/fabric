// ANY-50 S1 contract guards for the agents → llm extraction. The behavioural
// suite lives in llm.test.ts (moved verbatim); this file pins the structural
// promises the card makes: the move is lossless, the agents subpath is a pure
// re-export, and @fabric/llm stands alone from the internal packages.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it, expect } from "vitest";
import * as agentsLlm from "@fabric/agents/llm";
import * as llm from "../index";

// The 21 cases of the original packages/agents/src/__tests__/llm.test.ts at the
// extraction point (ANY-50 S1). L1.1 requires the moved suite to keep every
// case, same names and count — this manifest is that inventory; edit it only
// together with llm.test.ts.
const ORIGINAL_CASES = [
  "maps every level to the probed request body and never sends none",
  "merges chat_template_kwargs instead of clobbering it",
  "off sends chat_template_kwargs.enable_thinking=false and no reasoning_effort",
  "low and medium send top-level reasoning_effort",
  "high sends nothing extra (the template's xhigh default)",
  "defaults: dana off, everyone else medium, without opts.thinking",
  "always asks for JSON-tool structured output (the gateway rejects output_config.format)",
  "off disables thinking",
  "5-series: adaptive thinking steered by effort",
  "Haiku 4.5: a token budget per level",
  "Opus 5.5 schema calls run on claude-opus-5 as a forced JSON tool, thinking off",
  "a forced tool choice (Dana's first step) on Opus 5.5 stays on Opus 5.5",
  "Fable 5.1 free calls stay on claude-fable-5-1 with adaptive xhigh effort",
  "a forced tool choice on Sonnet keeps the force and turns thinking off",
  "Sonnet schema calls stay on their model with thinking off",
  "spark maps every display model to SPARK_MODEL",
  "openrouter and neon map display families to their catalog ids",
  "neon without the venue env throws a clear configuration error",
  "records usage with the model that actually ran, and accumulates run cost (generate)",
  "spark costs $0 and still records tokens",
  "records exactly once per stream, from the finish part",
];

it("L1.1 the moved suite keeps every case of the original agents llm test, same names and count", () => {
  const moved = readFileSync(new URL("./llm.test.ts", import.meta.url), "utf8");
  const names = [...moved.matchAll(/^ {2}it\("([^"]+)"/gm)].map((m) => m[1]);
  expect(names, "the moved suite must keep the original cases, in order").toEqual(ORIGINAL_CASES);
  // and it must be wired to this package's entrypoint, not a agents-relative path
  expect(moved).toMatch(/from "\.\.\/index"/);
});

it("L1.2 @fabric/agents/llm re-exports @fabric/llm: same export names, identical values", () => {
  const shim = agentsLlm as unknown as Record<string, unknown>;
  const pkg = llm as unknown as Record<string, unknown>;
  const shimNames = Object.keys(shim).sort();
  const pkgNames = Object.keys(pkg).sort();
  expect(shimNames, "the agents subpath must expose exactly the llm exports").toEqual(pkgNames);
  for (const name of pkgNames) {
    expect(shim[name], `agents re-export "${name}" must be the identical value`).toBe(pkg[name]);
  }
});

it("L1.3 @fabric/llm stands alone: no @fabric/agents, @fabric/db or @fabric/contracts in any dependency field or src import", () => {
  const INTERNAL = ["@fabric/agents", "@fabric/db", "@fabric/contracts"];
  const pkgUrl = new URL("../../package.json", import.meta.url);
  expect(existsSync(pkgUrl), "packages/llm/package.json must exist").toBe(true);
  const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as Record<string, unknown>;

  const problems: string[] = [];
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = (pkg[field] ?? {}) as Record<string, string>;
    for (const name of INTERNAL) {
      // Exact-name match: "@fabric/agents/llm" (the review shim import) is a
      // subpath, not a dependency on the agents internals.
      if (Object.keys(deps).some((k) => k === name || k.startsWith(`${name}/`))) {
        problems.push(`${field} must not contain ${name}`);
      }
    }
  }

  const srcRoot = fileURLToPath(new URL("../", import.meta.url));
  for (const rel of readdirSync(srcRoot, { recursive: true }) as string[]) {
    if (!rel.endsWith(".ts")) continue;
    const src = readFileSync(`${srcRoot}${rel}`, "utf8");
    for (const name of INTERNAL) {
      if (new RegExp(`(from|import)\\s*["']${name}["']`).test(src)) {
        problems.push(`src/${rel} imports ${name}`);
      }
    }
  }
  expect(problems, "@fabric/llm must not depend on internal packages").toEqual([]);
});
