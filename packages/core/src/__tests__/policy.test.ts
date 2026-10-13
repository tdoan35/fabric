// ANY-68 T2 — the policy engine: effective access (definition ∩ workspace ∩
// grants, blocked omitted), the approval-mode gate decision, and mode
// strictness (ANY-44 D5, PRODUCT §8.3 as amended 2026-10-13). Pure rules, no
// I/O; T3 calls them from decide and ANY-66's MCP tools reuse them. One test
// per listed case, named by its ID, flat names for Stryker's per-test filter.
import { expect, test } from "vitest";
import {
  DEFAULT_APPROVAL_MODE,
  effectiveAccess,
  gateDecision,
  stricterMode,
  type ApprovalMode,
  type Gate,
  type ToolAccess,
  type ToolKind,
} from "../policy";

type Access = Exclude<ToolAccess, "blocked">;
type Action = "run" | "ask";

const MODES: readonly ApprovalMode[] = ["ask", "auto_edits", "full_auto"];
const GATES: readonly Gate[] = ["none", "mode", "always"];
const KINDS: readonly ToolKind[] = ["read", "edit", "command", "external"];

test("P1 effectiveAccess with a definition only: allowed and approval pass through, blocked is omitted", () => {
  expect(
    effectiveAccess({ definition: { a: "allowed", b: "approval", c: "blocked" } })
  ).toEqual({ a: "allowed", b: "approval" });
});

test("P2 the workspace layer narrows: approval downgrades allowed, blocked omits, and a workspace-only tool never appears", () => {
  expect(
    effectiveAccess({
      definition: { a: "allowed", d: "allowed", e: "allowed" },
      workspace: { a: "approval", d: "blocked", z: "allowed" },
    })
  ).toEqual({ a: "approval", e: "allowed" });
});

test("P3 grants narrow: [\"a\"] keeps a and omits b, [] omits everything, null narrows nothing", () => {
  expect(
    effectiveAccess({ definition: { a: "allowed", b: "allowed" }, grants: ["a"] })
  ).toEqual({ a: "allowed" });
  expect(effectiveAccess({ definition: { a: "allowed", b: "allowed" }, grants: [] })).toEqual(
    {}
  );
  expect(
    effectiveAccess({ definition: { a: "allowed", b: "allowed" }, grants: null })
  ).toEqual({ a: "allowed", b: "allowed" });
});

/** The P4 table: every (access, gate, kind, mode) → action, written out —
 * approval asks (24), gate always asks (12), gate mode asks when the mode
 * doesn't cover the kind (10), everything else runs. Not computed from the
 * rule; each row is its own expectation. */
const TRUTH_TABLE: readonly (readonly [Access, Gate, ToolKind, ApprovalMode, Action])[] = [
  // approval access: ask under every gate, kind and mode.
  ["approval", "none", "read", "ask", "ask"],
  ["approval", "none", "read", "auto_edits", "ask"],
  ["approval", "none", "read", "full_auto", "ask"],
  ["approval", "none", "edit", "ask", "ask"],
  ["approval", "none", "edit", "auto_edits", "ask"],
  ["approval", "none", "edit", "full_auto", "ask"],
  ["approval", "none", "command", "ask", "ask"],
  ["approval", "none", "command", "auto_edits", "ask"],
  ["approval", "none", "command", "full_auto", "ask"],
  ["approval", "none", "external", "ask", "ask"],
  ["approval", "none", "external", "auto_edits", "ask"],
  ["approval", "none", "external", "full_auto", "ask"],
  ["approval", "mode", "read", "ask", "ask"],
  ["approval", "mode", "read", "auto_edits", "ask"],
  ["approval", "mode", "read", "full_auto", "ask"],
  ["approval", "mode", "edit", "ask", "ask"],
  ["approval", "mode", "edit", "auto_edits", "ask"],
  ["approval", "mode", "edit", "full_auto", "ask"],
  ["approval", "mode", "command", "ask", "ask"],
  ["approval", "mode", "command", "auto_edits", "ask"],
  ["approval", "mode", "command", "full_auto", "ask"],
  ["approval", "mode", "external", "ask", "ask"],
  ["approval", "mode", "external", "auto_edits", "ask"],
  ["approval", "mode", "external", "full_auto", "ask"],
  ["approval", "always", "read", "ask", "ask"],
  ["approval", "always", "read", "auto_edits", "ask"],
  ["approval", "always", "read", "full_auto", "ask"],
  ["approval", "always", "edit", "ask", "ask"],
  ["approval", "always", "edit", "auto_edits", "ask"],
  ["approval", "always", "edit", "full_auto", "ask"],
  ["approval", "always", "command", "ask", "ask"],
  ["approval", "always", "command", "auto_edits", "ask"],
  ["approval", "always", "command", "full_auto", "ask"],
  ["approval", "always", "external", "ask", "ask"],
  ["approval", "always", "external", "auto_edits", "ask"],
  ["approval", "always", "external", "full_auto", "ask"],
  // allowed, gate none: run under every kind and mode.
  ["allowed", "none", "read", "ask", "run"],
  ["allowed", "none", "read", "auto_edits", "run"],
  ["allowed", "none", "read", "full_auto", "run"],
  ["allowed", "none", "edit", "ask", "run"],
  ["allowed", "none", "edit", "auto_edits", "run"],
  ["allowed", "none", "edit", "full_auto", "run"],
  ["allowed", "none", "command", "ask", "run"],
  ["allowed", "none", "command", "auto_edits", "run"],
  ["allowed", "none", "command", "full_auto", "run"],
  ["allowed", "none", "external", "ask", "run"],
  ["allowed", "none", "external", "auto_edits", "run"],
  ["allowed", "none", "external", "full_auto", "run"],
  // allowed, gate always: ask under every kind and mode.
  ["allowed", "always", "read", "ask", "ask"],
  ["allowed", "always", "read", "auto_edits", "ask"],
  ["allowed", "always", "read", "full_auto", "ask"],
  ["allowed", "always", "edit", "ask", "ask"],
  ["allowed", "always", "edit", "auto_edits", "ask"],
  ["allowed", "always", "edit", "full_auto", "ask"],
  ["allowed", "always", "command", "ask", "ask"],
  ["allowed", "always", "command", "auto_edits", "ask"],
  ["allowed", "always", "command", "full_auto", "ask"],
  ["allowed", "always", "external", "ask", "ask"],
  ["allowed", "always", "external", "auto_edits", "ask"],
  ["allowed", "always", "external", "full_auto", "ask"],
  // allowed, gate mode: the mode's coverage decides.
  ["allowed", "mode", "read", "ask", "ask"],
  ["allowed", "mode", "read", "auto_edits", "run"],
  ["allowed", "mode", "read", "full_auto", "run"],
  ["allowed", "mode", "edit", "ask", "ask"],
  ["allowed", "mode", "edit", "auto_edits", "run"],
  ["allowed", "mode", "edit", "full_auto", "run"],
  ["allowed", "mode", "command", "ask", "ask"],
  ["allowed", "mode", "command", "auto_edits", "ask"],
  ["allowed", "mode", "command", "full_auto", "run"],
  ["allowed", "mode", "external", "ask", "ask"],
  ["allowed", "mode", "external", "auto_edits", "ask"],
  ["allowed", "mode", "external", "full_auto", "run"],
];

test("P4 gateDecision matches the explicit 72-row truth table", () => {
  expect(TRUTH_TABLE).toHaveLength(72);
  expect(new Set(TRUTH_TABLE.map((row) => row.slice(0, 4).join("|"))).size).toBe(72);
  for (const [access, gate, kind, mode, action] of TRUTH_TABLE) {
    expect(
      gateDecision({ access, gate, kind, mode }).action,
      `${access} / ${gate} / ${kind} / ${mode}`
    ).toBe(action);
  }
});

test("P5 gated is true exactly for gate \"always\", in every mode, including full_auto", () => {
  for (const mode of MODES) {
    for (const kind of KINDS) {
      expect(gateDecision({ access: "allowed", gate: "always", kind, mode }).gated).toBe(true);
      for (const gate of ["none", "mode"] as const) {
        expect(gateDecision({ access: "allowed", gate, kind, mode }).gated).toBe(false);
      }
    }
  }
});

test("P6 full_auto never runs an approval-access tool without asking, and never runs a gate \"always\" tool", () => {
  for (const kind of KINDS) {
    expect(gateDecision({ access: "approval", gate: "none", kind, mode: "full_auto" })).toEqual({
      action: "ask",
      gated: false,
    });
    expect(gateDecision({ access: "allowed", gate: "always", kind, mode: "full_auto" })).toEqual({
      action: "ask",
      gated: true,
    });
  }
});

test("P7 stricterMode returns the stricter of each of the 9 ordered pairs", () => {
  const PAIRS: readonly (readonly [ApprovalMode, ApprovalMode, ApprovalMode])[] = [
    ["ask", "ask", "ask"],
    ["ask", "auto_edits", "ask"],
    ["ask", "full_auto", "ask"],
    ["auto_edits", "ask", "ask"],
    ["auto_edits", "auto_edits", "auto_edits"],
    ["auto_edits", "full_auto", "auto_edits"],
    ["full_auto", "ask", "ask"],
    ["full_auto", "auto_edits", "auto_edits"],
    ["full_auto", "full_auto", "full_auto"],
  ];
  for (const [a, b, expected] of PAIRS) {
    expect(stricterMode(a, b), `${a} / ${b}`).toBe(expected);
  }
});

test("P8 DEFAULT_APPROVAL_MODE is \"ask\"", () => {
  expect(DEFAULT_APPROVAL_MODE).toBe("ask");
});

test("P9 purity: frozen inputs do not throw and repeated calls give equal results", () => {
  const accessInput = Object.freeze({
    definition: Object.freeze({ a: "allowed", b: "approval", c: "blocked" }),
    workspace: Object.freeze({ a: "approval", z: "blocked" }),
    grants: Object.freeze(["a"]),
  });
  expect(() => effectiveAccess(accessInput)).not.toThrow();
  expect(effectiveAccess(accessInput)).toEqual(effectiveAccess(accessInput));

  const gateInput = Object.freeze({ access: "allowed", gate: "mode", kind: "edit", mode: "auto_edits" } as const);
  expect(() => gateDecision(gateInput)).not.toThrow();
  expect(gateDecision(gateInput)).toEqual(gateDecision(gateInput));
});

test("P10 the subpath import works: @fabric/core/policy resolves", async () => {
  // Dynamic import: this case exercises the package-specifier resolution
  // itself (the ./policy exports entry), which a static import would
  // collapse at collection.
  const mod = await import("@fabric/core/policy");
  expect(typeof mod.gateDecision).toBe("function");
  expect(typeof mod.effectiveAccess).toBe("function");
  expect(typeof mod.stricterMode).toBe("function");
  expect(mod.DEFAULT_APPROVAL_MODE).toBe("ask");
});
