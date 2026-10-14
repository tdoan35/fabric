// @fabric/tools/mcp (ANY-77, ANY-66 M4): the MCP client for remote
// Streamable HTTP servers — server records and per-agent attachments,
// discovery with a tools/list cache, and discovered tools as Fabric
// ToolDefs. Served through T1's subpath map; src/index.ts stays untouched.
export { ensureMcpSchema } from "./schema";
export {
  assertValidMcpServerName,
  assertValidMcpServerUrl,
  MCP_SERVER_NAME_PATTERN,
  mcpServers,
  type McpAccess,
  type McpAgentsChange,
  type McpAttachment,
  type McpAuth,
  type McpServerRecord,
  type McpServers,
  type McpStatus,
  type McpToolCache,
} from "./servers";
export {
  MCP_CALL_TIMEOUT_MS,
  mcpClient,
  type McpCallResult,
  type McpClient,
  type McpContentBlock,
  type McpTool,
} from "./client";
export { discover, MCP_CACHE_TTL_MS } from "./discover";
export {
  MCP_DESCRIPTION_MAX,
  MCP_RESULT_MAX_CHARS,
  mcpDefinitionAccess,
  mcpToolDefs,
  type McpCall,
  type McpSkipped,
  type McpToolResult,
  type McpToolSource,
} from "./tools";
export { MCP_TOOL_NAME_MAX, mcpToolName, sanitizeMcpToolName, serverOfToolName } from "./names";
export { MCP_OAUTH_PENDING_MS, mcpOAuth, type McpOAuth } from "./oauth";
export {
  McpNeedsSignIn,
  MCP_REFRESH_SKEW_MS,
  mcpOAuthVaultName,
  type McpOAuthTokens,
} from "./tokens";
