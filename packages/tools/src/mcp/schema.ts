// The MCP area's own schema (ANY-77), idempotent like the vault's
// ensureVaultSchema; the runtime's migrations are untouched. A server is
// added (and signed in to) once per workspace, then attached per agent with
// an access level; the tools/list result is cached per server.
import type { RuntimeStore } from "@fabric/runtime";

export async function ensureMcpSchema(store: RuntimeStore): Promise<void> {
  await store.transaction(async (tx) => {
    await tx.query(`create table if not exists mcp_servers (
      workspace_id text not null,
      name text not null,
      url text not null,
      auth text not null check (auth in ('none', 'oauth')),
      status text not null check (status in ('ready', 'needs_auth', 'error')),
      last_error text,
      created_at timestamptz not null,
      primary key (workspace_id, name)
    )`);
    await tx.query(`create table if not exists mcp_server_agents (
      workspace_id text not null,
      server text not null,
      agent_id text not null,
      access text not null check (access in ('allowed', 'approval')),
      primary key (workspace_id, server, agent_id)
    )`);
    await tx.query(`create table if not exists mcp_tool_cache (
      workspace_id text not null,
      server text not null,
      tools text not null,
      fetched_at timestamptz not null,
      stale boolean not null,
      primary key (workspace_id, server)
    )`);
    // ANY-78: a started OAuth sign-in, single use, 10 minutes. `client` is
    // the client and authorization-server details finish needs, as JSON.
    await tx.query(`create table if not exists mcp_oauth_pending (
      workspace_id text not null,
      state text not null,
      server text not null,
      code_verifier text not null,
      redirect_uri text not null,
      client text not null,
      expires_at timestamptz not null,
      primary key (workspace_id, state)
    )`);
  });
}
