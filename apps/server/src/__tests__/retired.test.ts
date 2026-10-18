// S14 (ANY-64): the retirement contract. Scripted Dana and the one-response
// chat path are gone; these assertions fail while any of it remains, so the
// removal cannot silently regress. The legacy history GETs stay (S12/S13
// render old threads read-only) and are covered in contract.test.ts.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** Every tracked file except docs/ and this test, as paths relative to the repo root. */
const tracked = (execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" })
  .split("\n")
  .filter(Boolean) as string[]).filter((f) => !f.startsWith("docs/") && f !== "apps/server/src/__tests__/retired.test.ts");

const occurrences = (needle: string): string[] =>
  tracked.filter((f) => {
    try {
      return readFileSync(resolve(repoRoot, f), "utf8").includes(needle);
    } catch {
      return false; // binary or unreadable: not a source file
    }
  });

describe("retired chat path (S14)", () => {
  it("X1 leaves no DANA_MODE in tracked source", () => {
    expect(occurrences("DANA_MODE")).toEqual([]);
  });

  it("X1 leaves no x-fabric-fixture header in tracked source", () => {
    expect(occurrences("x-fabric-fixture")).toEqual([]);
  });

  it("X1 leaves no fixture flag on a chat request in tracked source", () => {
    expect(occurrences("fixture: true")).toEqual([]);
  });
});
