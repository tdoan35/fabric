// MCP server records (ANY-77, decided by Ty 2026-10-13): a server is added
// and signed in to once per workspace, then attached per agent with an
// access level — `allowed` by default, so the gate follows the approval
// mode. Remote Streamable HTTP servers only, so the URL must be https:
// except plain http to the loopback host. Call `ensureMcpSchema` first.
import type { RuntimeStore } from "@fabric/runtime";
import type { McpTool } from "./client";

export type McpAuth = "none" | "oauth";
export type McpStatus = "ready" | "needs_auth" | "error";
export type McpAccess = "allowed" | "approval";

export type McpServerRecord = {
  name: string;
  url: string;
  auth: McpAuth;
  status: McpStatus;
  lastError: string | null;
  createdAt: Date;
};

export type McpAttachment = { server: string; agentId: string; access: McpAccess };

export type McpToolCache = { tools: McpTool[]; fetchedAt: Date; stale: boolean };

export type McpServers = {
  readonly workspaceId: string;
  add(input: { name: string; url: string; auth: McpAuth }): Promise<McpServerRecord>;
  get(name: string): Promise<McpServerRecord | undefined>;
  list(): Promise<McpServerRecord[]>;
  setStatus(name: string, status: McpStatus, lastError?: string): Promise<void>;
  /** Drops the server, its attachments and its cache. Vault cleanup is M5's. */
  remove(name: string): Promise<void>;
  /** Attaching again changes the access. */
  attach(server: string, agentId: string, access?: McpAccess): Promise<void>;
  detach(server: string, agentId: string): Promise<void>;
  attachedAgents(server: string): Promise<McpAttachment[]>;
  serversFor(agentId: string): Promise<McpAttachment[]>;
  isAttached(server: string, agentId: string): Promise<boolean>;
  readCache(server: string): Promise<McpToolCache | undefined>;
  /** Replaces the cached tools/list result and clears `stale`. */
  writeCache(server: string, tools: readonly McpTool[], fetchedAt: Date): Promise<void>;
  markStale(server: string): Promise<void>;
};

export const MCP_SERVER_NAME_PATTERN = /^[a-z][a-z0-9]{0,19}$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function assertValidMcpServerName(name: string): void {
  if (!MCP_SERVER_NAME_PATTERN.test(name)) {
    throw new Error(
      `invalid mcp server name ${JSON.stringify(name)}: must match ^[a-z][a-z0-9]{0,19}$`
    );
  }
}

export function assertValidMcpServerUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid mcp server url ${JSON.stringify(url)}: not a URL`);
  }
  const allowed =
    parsed.protocol === "https:" ||
    (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname));
  if (!allowed) {
    throw new Error(
      `invalid mcp server url ${JSON.stringify(url)}: must be https: (http: only to localhost, 127.0.0.1 or [::1])`
    );
  }
}

// -- driver row narrowing -----------------------------------------------------
// pg and PGlite hand back `unknown` columns; these check what they read.

function textOf(value: unknown, column: string): string {
  if (typeof value !== "string") {
    throw new Error(`mcp: ${column}: expected text, got ${typeof value}`);
  }
  return value;
}

function oneOf<T extends string>(value: unknown, column: string, allowed: readonly T[]): T {
  const text = textOf(value, column);
  if (!(allowed as readonly string[]).includes(text)) {
    throw new Error(`mcp: ${column}: unexpected value ${JSON.stringify(text)}`);
  }
  return text as T;
}

function dateOf(value: unknown, column: string): Date {
  if (!(value instanceof Date)) {
    throw new Error(`mcp: ${column}: expected timestamptz, got ${typeof value}`);
  }
  return value;
}

function toolsOf(value: unknown): McpTool[] {
  const parsed: unknown = JSON.parse(textOf(value, "mcp_tool_cache.tools"));
  const tools = (parsed as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) throw new Error("mcp: mcp_tool_cache.tools: bad tools/list JSON");
  return tools as McpTool[];
}

const AUTHS: readonly McpAuth[] = ["none", "oauth"];
const STATUSES: readonly McpStatus[] = ["ready", "needs_auth", "error"];
const ACCESSES: readonly McpAccess[] = ["allowed", "approval"];

function recordOf(row: Record<string, unknown>): McpServerRecord {
  return {
    name: textOf(row.name, "mcp_servers.name"),
    url: textOf(row.url, "mcp_servers.url"),
    auth: oneOf(row.auth, "mcp_servers.auth", AUTHS),
    status: oneOf(row.status, "mcp_servers.status", STATUSES),
    lastError: typeof row.last_error === "string" ? row.last_error : null,
    createdAt: dateOf(row.created_at, "mcp_servers.created_at"),
  };
}

function attachmentOf(row: Record<string, unknown>): McpAttachment {
  return {
    server: textOf(row.server, "mcp_server_agents.server"),
    agentId: textOf(row.agent_id, "mcp_server_agents.agent_id"),
    access: oneOf(row.access, "mcp_server_agents.access", ACCESSES),
  };
}

const SERVER_COLUMNS = "name, url, auth, status, last_error, created_at";

/** The workspace's MCP servers and their per-agent attachments. */
export function mcpServers(store: RuntimeStore, workspaceId: string): McpServers {
  const query = (sql: string, params: readonly unknown[]) =>
    store.transaction((tx) => tx.query(sql, params));

  return {
    workspaceId,

    async add({ name, url, auth }) {
      assertValidMcpServerName(name);
      assertValidMcpServerUrl(url);
      if (!AUTHS.includes(auth)) throw new Error(`invalid mcp server auth ${JSON.stringify(auth)}`);
      const rows = await query(
        `insert into mcp_servers (workspace_id, name, url, auth, status, last_error, created_at)
         values ($1, $2, $3, $4, $5, null, $6)
         on conflict (workspace_id, name) do nothing
         returning ${SERVER_COLUMNS}`,
        [workspaceId, name, url, auth, auth === "none" ? "ready" : "needs_auth", new Date()]
      );
      const row = rows[0];
      if (row === undefined) throw new Error(`mcp server ${name} already exists`);
      return recordOf(row);
    },

    async get(name) {
      const rows = await query(
        `select ${SERVER_COLUMNS} from mcp_servers where workspace_id = $1 and name = $2`,
        [workspaceId, name]
      );
      return rows[0] === undefined ? undefined : recordOf(rows[0]);
    },

    async list() {
      const rows = await query(
        `select ${SERVER_COLUMNS} from mcp_servers where workspace_id = $1 order by name`,
        [workspaceId]
      );
      return rows.map(recordOf);
    },

    async setStatus(name, status, lastError) {
      if (!STATUSES.includes(status)) throw new Error(`invalid mcp server status ${JSON.stringify(status)}`);
      const rows = await query(
        `update mcp_servers set status = $3, last_error = $4
         where workspace_id = $1 and name = $2 returning name`,
        [workspaceId, name, status, lastError ?? null]
      );
      if (rows.length === 0) throw new Error(`unknown mcp server ${name}`);
    },

    async remove(name) {
      await store.transaction(async (tx) => {
        await tx.query(`delete from mcp_tool_cache where workspace_id = $1 and server = $2`, [workspaceId, name]);
        await tx.query(`delete from mcp_server_agents where workspace_id = $1 and server = $2`, [workspaceId, name]);
        await tx.query(`delete from mcp_servers where workspace_id = $1 and name = $2`, [workspaceId, name]);
      });
    },

    async attach(server, agentId, access = "allowed") {
      if (!ACCESSES.includes(access)) throw new Error(`invalid mcp access ${JSON.stringify(access)}`);
      await store.transaction(async (tx) => {
        const known = await tx.query(
          `select name from mcp_servers where workspace_id = $1 and name = $2`,
          [workspaceId, server]
        );
        if (known.length === 0) throw new Error(`unknown mcp server ${server}`);
        await tx.query(
          `insert into mcp_server_agents (workspace_id, server, agent_id, access)
           values ($1, $2, $3, $4)
           on conflict (workspace_id, server, agent_id) do update set access = excluded.access`,
          [workspaceId, server, agentId, access]
        );
      });
    },

    async detach(server, agentId) {
      await query(
        `delete from mcp_server_agents where workspace_id = $1 and server = $2 and agent_id = $3`,
        [workspaceId, server, agentId]
      );
    },

    async attachedAgents(server) {
      const rows = await query(
        `select server, agent_id, access from mcp_server_agents
         where workspace_id = $1 and server = $2 order by agent_id`,
        [workspaceId, server]
      );
      return rows.map(attachmentOf);
    },

    async serversFor(agentId) {
      const rows = await query(
        `select server, agent_id, access from mcp_server_agents
         where workspace_id = $1 and agent_id = $2 order by server`,
        [workspaceId, agentId]
      );
      return rows.map(attachmentOf);
    },

    async isAttached(server, agentId) {
      const rows = await query(
        `select 1 as attached from mcp_server_agents
         where workspace_id = $1 and server = $2 and agent_id = $3`,
        [workspaceId, server, agentId]
      );
      return rows.length > 0;
    },

    async readCache(server) {
      const rows = await query(
        `select tools, fetched_at, stale from mcp_tool_cache where workspace_id = $1 and server = $2`,
        [workspaceId, server]
      );
      const row = rows[0];
      if (row === undefined) return undefined;
      return {
        tools: toolsOf(row.tools),
        fetchedAt: dateOf(row.fetched_at, "mcp_tool_cache.fetched_at"),
        stale: row.stale === true,
      };
    },

    async writeCache(server, tools, fetchedAt) {
      await query(
        `insert into mcp_tool_cache (workspace_id, server, tools, fetched_at, stale)
         values ($1, $2, $3, $4, false)
         on conflict (workspace_id, server) do update set
           tools = excluded.tools, fetched_at = excluded.fetched_at, stale = false`,
        [workspaceId, server, JSON.stringify({ tools }), fetchedAt]
      );
    },

    async markStale(server) {
      await query(`update mcp_tool_cache set stale = true where workspace_id = $1 and server = $2`, [
        workspaceId,
        server,
      ]);
    },
  };
}
