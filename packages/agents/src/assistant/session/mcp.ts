// The MCP stamp and run hook (ANY-84 M6): an agent's attached MCP servers
// become session tools. The I/O — the server records, the client factory and
// the scope factory — is the server's (bootstrap.ts); this module is the
// seam both drivers share. At stamp, every attached ready server is
// discovered (M4's 24 h cache) and its ToolDefs join the definition through
// withToolset, so T2's policy and T3's approval gates apply unchanged: the
// attachment's access, gate `mode`, kind `read` for readOnlyHint tools and
// `external` for the rest. A server that is needs_auth or error is skipped;
// a discovery that throws or times out is skipped with the server's status
// set to error and one log line — creating a session never fails because of
// MCP. At run, a `mcp_*` name the static registry doesn't carry resolves
// through serverOfToolName and the cache, then runs behind a one-def
// registry port with the call's scope: arguments are validated, M4's
// attachment re-check runs, and the output is truncated as M4 does. A
// session keeps the MCP tools it was stamped with — detaching later fails
// the attachment check, attaching later reaches new sessions only.
import type { ToolRunResult } from "@fabric/runtime";
import { createRegistry } from "@fabric/tools";
import type { ToolDef, ToolScope } from "@fabric/tools";
import {
  discover,
  McpNeedsSignIn,
  mcpDefinitionAccess,
  serverOfToolName,
  type McpClient,
  type McpServers,
} from "@fabric/tools/mcp";
import { withToolset } from "./toolset";

/** A discovery at stamp gives up after this long (the card's 10 s). */
export const MCP_STAMP_TIMEOUT_MS = 10_000;

/** The I/O the server supplies: the workspace's server records, the client
 * factory (OAuth's fetchFor for `auth: "oauth"` servers), the scope factory
 * the run hook builds its one-def port behind, and the log line a skipped
 * discovery leaves. */
export type McpSessionDeps = {
  servers: McpServers;
  clientFor(server: string, agentId: string): Promise<McpClient>;
  scope(io: { workspaceId: string; streamId: string; agentId: string; callId?: string }): Promise<ToolScope>;
  log?(line: string): void;
};

/** The io the session port hands a run (tools.ts's shape). */
export type SessionMcpIo = {
  onLine?: (line: string) => void;
  callId?: string;
  streamId?: string;
  workspaceId?: string;
  agentId?: string;
};

/** M6's run hook: resolves a dynamic tool name the static registry doesn't
 * carry; undefined = not an MCP name, so the port's own tools answer. */
export type SessionMcpRunner = (
  name: string,
  args: Record<string, unknown>,
  io: SessionMcpIo
) => Promise<ToolRunResult | undefined>;

/** The definition shape withToolset appends to (its local shape, mirrored
 * here because the file scope keeps toolset.ts untouched). */
type ToolsetDef = {
  tools: readonly string[];
  toolSchemas?: unknown[];
  toolEffects?: Record<string, unknown>;
  toolPolicy?: Record<string, unknown>;
};

/**
 * Stamp the agent's attached MCP servers' tools onto the definition: each
 * ready attached server is discovered once (the 24 h cache), and the finished
 * ToolDefs append through withToolset with the attachments' access — so
 * `approval` asks in every mode, and the names (`mcp_<server>_…`, M4) cannot
 * collide with the static tools. needs_auth/error servers are skipped, and a
 * discovery that fails marks the server error and leaves the definition
 * without its tools; nothing here rejects.
 */
export async function withMcpTools<D extends ToolsetDef>(
  def: D,
  agentId: string,
  deps: McpSessionDeps
): Promise<D> {
  const attachments = await deps.servers.serversFor(agentId);
  const defs: ToolDef[] = [];
  for (const attachment of attachments) {
    const record = await deps.servers.get(attachment.server);
    if (record === undefined || record.status !== "ready") continue;
    try {
      const client = await deps.clientFor(attachment.server, agentId);
      const { tools } = await discover(deps.servers, client, attachment.server, {
        timeoutMs: MCP_STAMP_TIMEOUT_MS,
      });
      defs.push(...tools);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await deps.servers.setStatus(attachment.server, "error", message);
      deps.log?.(`[mcp] ${attachment.server}: discovery failed, skipped (${message})`);
    }
  }
  if (defs.length === 0) return def;

  const access = mcpDefinitionAccess(attachments, defs.map((tool) => tool.name));
  return withToolset(def, { registry: createRegistry(defs), access });
}

/**
 * The run hook: `serverOfToolName` maps the name to its server, the record
 * and M4's cache (no network within 24 h) supply the def, and a one-def
 * registry port runs it behind the call's scope — validated arguments, the
 * attachment re-check, M4's truncation. An unknown server or tool is
 * `unknown tool: <name>`; `McpNeedsSignIn` returns the sign-in message with
 * the server's status set to needs_auth; every other failure is a result,
 * not a job failure.
 */
export function mcpToolRunner(deps: McpSessionDeps): SessionMcpRunner {
  return async (name, args, io) => {
    const server = serverOfToolName(name);
    if (server === undefined) return undefined;

    try {
      const record = await deps.servers.get(server);
      if (record === undefined) return { ok: false, error: `unknown tool: ${name}` };
      if (io.agentId === undefined || io.agentId === "") {
        return { ok: false, error: "session tools need the session's agent" };
      }

      const client = await deps.clientFor(server, io.agentId);
      const { tools } = await discover(deps.servers, client, server);
      const def = tools.find((candidate) => candidate.name === name);
      if (def === undefined) return { ok: false, error: `unknown tool: ${name}` };

      const scope = await deps.scope({
        workspaceId: io.workspaceId ?? "",
        streamId: io.streamId ?? "",
        agentId: io.agentId,
        callId: io.callId,
      });
      return await createRegistry([def]).toolPort(scope).run(name, args, {
        onLine: io.onLine,
        callId: io.callId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof McpNeedsSignIn) {
        await deps.servers.setStatus(server, "needs_auth", message).catch(() => {
          // The status is best effort here; the result already says it.
        });
      }
      return { ok: false, error: message };
    }
  };
}
