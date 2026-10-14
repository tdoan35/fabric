// Discovery (ANY-77): a server's tools as Fabric ToolDefs, from the cached
// tools/list result when it is younger than 24 h and not stale, else from a
// fresh listing that rewrites the cache. `refresh: true` always lists. The
// first discover through a client subscribes it to list_changed, which
// marks the server's cache stale.
import type { McpClient } from "./client";
import type { McpServers } from "./servers";
import { mcpToolDefs, type McpSkipped } from "./tools";
import type { ToolDef } from "../define";

export const MCP_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** (client, server) pairs already subscribed to list_changed. */
const subscribed = new WeakMap<McpClient, Set<string>>();

function watch(servers: McpServers, client: McpClient, server: string): void {
  const names = subscribed.get(client) ?? new Set<string>();
  subscribed.set(client, names);
  const key = `${servers.workspaceId}\u0000${server}`;
  if (names.has(key)) return;
  names.add(key);
  client.onToolsChanged(() => {
    servers.markStale(server).catch(() => {
      // The next discover after the TTL lists anyway; a lost mark only delays it.
    });
  });
}

export async function discover(
  servers: McpServers,
  client: McpClient,
  server: string,
  options: { refresh?: boolean; now?: () => number; timeoutMs?: number } = {}
): Promise<{ tools: ToolDef[]; skipped: McpSkipped[] }> {
  const now = options.now ?? Date.now;
  watch(servers, client, server);

  const cache = options.refresh === true ? undefined : await servers.readCache(server);
  let listed = cache?.tools;
  if (cache === undefined || cache.stale || now() - cache.fetchedAt.getTime() >= MCP_CACHE_TTL_MS) {
    listed = await client.listTools();
    await servers.writeCache(server, listed, new Date(now()));
  }

  const timeoutMs = options.timeoutMs;
  const { defs, skipped } = mcpToolDefs(
    { name: server, isAttached: (agentId) => servers.isAttached(server, agentId) },
    listed ?? [],
    (_server, tool, args) =>
      client.callTool(tool, args, timeoutMs === undefined ? {} : { timeoutMs })
  );
  return { tools: defs, skipped };
}
