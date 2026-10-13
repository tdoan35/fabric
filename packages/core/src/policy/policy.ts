// The policy engine (ANY-44 T2, decisions D5 and PRODUCT §8.3 as amended
// 2026-10-13): the pure rules behind effective access and approval-mode gate
// decisions. No I/O. T3 calls these from decide; ANY-66's MCP tools reuse
// them. Effective access is agent definition ∩ workspace policy, with a
// grants hook for ANY-42's delegation grants to plug into later.

/** What each layer says about a tool; the intersection omits `blocked`. */
export type ToolAccess = "allowed" | "approval" | "blocked";

/** The tool's gate: `mode` follows the session's approval mode, `always`
 * always asks a human. Mirrors @fabric/tools' `ToolGate` (T1). */
export type Gate = "none" | "mode" | "always";

/** What the tool touches; "Auto-approve edits" covers read and edit. */
export type ToolKind = "read" | "edit" | "command" | "external";

/** The session's approval mode (PRODUCT §8.3); runs inherit it and can only
 * tighten it via stricterMode. */
export type ApprovalMode = "ask" | "auto_edits" | "full_auto";

export const DEFAULT_APPROVAL_MODE: ApprovalMode = "ask";

/** Definition ∩ workspace ∩ grants. Only tools in `definition` appear;
 * blocked tools and tools outside a present `grants` list are omitted;
 * `grants` null/undefined narrows nothing. */
export function effectiveAccess(input: {
  definition: Record<string, ToolAccess>;
  workspace?: Record<string, ToolAccess>;
  grants?: readonly string[] | null;
}): Record<string, Exclude<ToolAccess, "blocked">> {
  const { definition, workspace, grants } = input;
  const access: Record<string, Exclude<ToolAccess, "blocked">> = {};
  for (const tool of Object.keys(definition)) {
    const declared = definition[tool];
    const policy = workspace?.[tool];
    if (declared === "blocked" || policy === "blocked") continue;
    if (grants != null && !grants.includes(tool)) continue;
    access[tool] =
      declared === "approval" || policy === "approval" ? "approval" : "allowed";
  }
  return access;
}

/** Which kinds an approval mode runs without asking: `ask` covers nothing,
 * `auto_edits` covers read and edit ("Auto-approve edits"), `full_auto`
 * covers every kind. */
function modeCovers(mode: ApprovalMode, kind: ToolKind): boolean {
  if (mode === "full_auto") return true;
  return mode === "auto_edits" && (kind === "read" || kind === "edit");
}

/** The gate decision: `gated` marks the always-human gates (send, spend,
 * credentials — R10's `human.requested` waits); `action` is ask when the
 * gate is `always`, the access is `approval`, or a `mode` gate's mode does
 * not cover the kind. Otherwise run. */
export function gateDecision(input: {
  access: Exclude<ToolAccess, "blocked">;
  gate: Gate;
  kind: ToolKind;
  mode: ApprovalMode;
}): { action: "run" | "ask"; gated: boolean } {
  const { access, gate, kind, mode } = input;
  const gated = gate === "always";
  const ask =
    gated || access === "approval" || (gate === "mode" && !modeCovers(mode, kind));
  return { action: ask ? "ask" : "run", gated };
}

const MODE_STRICTNESS: Record<ApprovalMode, number> = {
  ask: 2,
  auto_edits: 1,
  full_auto: 0,
};

/** The stricter of two modes (ask > auto_edits > full_auto). A run started
 * from a session gets stricterMode(session, requested), so a mode can only
 * tighten. */
export function stricterMode(a: ApprovalMode, b: ApprovalMode): ApprovalMode {
  return MODE_STRICTNESS[a] >= MODE_STRICTNESS[b] ? a : b;
}
