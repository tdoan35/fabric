// @fabric/core/policy — the pure policy rules (ANY-44 T2). Served as a
// subpath so S2's decide/ and fold/ owners and the tools tracks import it
// without touching src/index.ts.
export {
  DEFAULT_APPROVAL_MODE,
  effectiveAccess,
  gateDecision,
  stricterMode,
  type ApprovalMode,
  type Gate,
  type ToolAccess,
  type ToolKind,
} from "./policy";
