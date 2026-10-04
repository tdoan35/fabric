// @fabric/integrations — TOOLS owns this package: tool registry and policies, Sprites, Exa, AgentMail, Executor.
//
// The public surface (§4.6): toolsFor, createInbox, sendReportEmail. Plus what TEAM needs to
// compose the runtime: the provider-key mapping, the team.assign factory, and the egress list.
export { toolsFor } from "./tools-for";
export type { AgentTools, ToolsForCtx } from "./tools-for";
export { createInbox, sendReportEmail, renderReportEmail, agentMailClient, OWNER_INBOX } from "./agentmail";
export type { AgentMailLike, InboxUpdate } from "./agentmail";
export { TOOL_KEYS, TOOL_NAMES_BY_KEY, toolKeyOf, toolNameOf } from "./names";
export { teamAssignTool } from "./tools/team-assign";
export type { TeamAssign, TeamAssignInput } from "./tools/team-assign";
export { EGRESS_ALLOWLIST, SPRITE_WORKDIR, egressAllowed, sandboxIdFor, spriteFor, spritesClient, ensureEgressPolicy, execInSprite } from "./sprites";
export { exaClient, exaSearch, exaNarration } from "./exa";
export type { ExaHit, ExaSearchOutcome } from "./exa";
export { spriteFileReader } from "./tools/sprite";
export { browserTaskInputSchema, browserTaskResultSchema, browserTaskTool, runBrowserTask, resumeBrowserTask, cancelBrowserTask } from "./tools/browser";
export type { BrowserTaskInput, BrowserTaskResult, BrowserDeps, BrowserAction, BrowserObservation, BrowserDecision, BrowserUsage, BrowserConfirmation } from "./tools/browser";

/** The AI SDK's tool type — what every entry of AgentTools.tools is (S1: plain AI SDK, not Mastra). */
export type Tool = import("ai").Tool;
