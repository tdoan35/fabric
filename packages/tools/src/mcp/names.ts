// Fabric names for MCP tools (ANY-77): `mcp_<server>_<tool>`, provider-safe
// under T1's ^[a-z][a-z0-9_]*$ rule and at most 64 characters. Server names
// carry no underscore, so the prefix parses one way and serverOfToolName can
// map a tool back to its server.
import { createHash } from "node:crypto";

export const MCP_TOOL_NAME_MAX = 64;
const PREFIX = "mcp_";

/** Lowercased, each run outside [a-z0-9] → `_`, edge underscores trimmed. */
export function sanitizeMcpToolName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function hash6(name: string): string {
  return createHash("sha256").update(name).digest("hex").slice(0, 6);
}

/** The Fabric name for one tool on `server`. `taken` holds the names already
 * given on this server; a clash gets `_<first 6 hex of sha256(original)>`,
 * still within 64 characters. Returns undefined when even that clashes. */
export function mcpToolName(
  server: string,
  original: string,
  taken: ReadonlySet<string>
): string | undefined {
  const sanitized = sanitizeMcpToolName(original);
  const base = `${PREFIX}${server}_${sanitized}`.slice(0, MCP_TOOL_NAME_MAX);
  if (sanitized !== "" && !taken.has(base)) return base;
  const suffix = `_${hash6(original)}`;
  const suffixed = `${base.replace(/_+$/, "").slice(0, MCP_TOOL_NAME_MAX - suffix.length)}${suffix}`;
  return taken.has(suffixed) ? undefined : suffixed;
}

/** The server a Fabric MCP tool name belongs to, or undefined for any other tool. */
export function serverOfToolName(name: string): string | undefined {
  const match = /^mcp_([a-z][a-z0-9]*)_/.exec(name);
  return match?.[1];
}
