// MCP OAuth tokens in the vault (ANY-78): one `mcp_<server>_oauth` entry
// per server per workspace, readable by the server's attached agents only.
// The value is JSON; nothing here ever puts a token, refresh token or client
// secret into an error message. Refresh is single-flight per server, so
// concurrent callers share one request and a rotating refresh token is
// spent exactly once.
import {
  OAuthError,
  refreshAuthorization,
  type AuthorizationServerMetadata,
  type FetchLike,
} from "@modelcontextprotocol/client";
import type { Vault } from "../vault";
import type { McpServers } from "./servers";

/** The vault entry's JSON. */
export type McpOAuthTokens = {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  resource: string;
  revocationEndpoint?: string;
};

/** Refresh when the token has this little life left. */
export const MCP_REFRESH_SKEW_MS = 60_000;

export const mcpOAuthVaultName = (server: string): string => `mcp_${server}_oauth`;

/** The error a caller sees when only a new sign-in can help. */
export class McpNeedsSignIn extends Error {
  constructor(server: string) {
    super(`mcp server ${server} needs sign-in again`);
    this.name = "McpNeedsSignIn";
  }
}

export function parseMcpOAuthTokens(server: string, raw: string): McpOAuthTokens {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`vault entry ${mcpOAuthVaultName(server)} is not JSON`);
  }
  const tokens = parsed as Partial<McpOAuthTokens>;
  if (
    typeof tokens.accessToken !== "string" ||
    typeof tokens.tokenEndpoint !== "string" ||
    typeof tokens.clientId !== "string" ||
    typeof tokens.resource !== "string"
  ) {
    throw new Error(`vault entry ${mcpOAuthVaultName(server)} is missing token fields`);
  }
  return tokens as McpOAuthTokens;
}

/** The server's attached agents: the vault entry's agent list. */
export async function attachedAgentIds(servers: McpServers, server: string): Promise<string[]> {
  return (await servers.attachedAgents(server)).map((attachment) => attachment.agentId);
}

export async function storeMcpOAuthTokens(
  vault: Vault,
  servers: McpServers,
  server: string,
  tokens: McpOAuthTokens
): Promise<void> {
  await vault.put(mcpOAuthVaultName(server), JSON.stringify(tokens), {
    agents: await attachedAgentIds(servers, server),
    description: `OAuth tokens for MCP server ${server}`,
  });
}

/** The token endpoint as the SDK's metadata shape; refresh needs only that. */
function tokenMetadata(tokens: McpOAuthTokens): AuthorizationServerMetadata {
  return {
    issuer: new URL(tokens.tokenEndpoint).origin,
    authorization_endpoint: tokens.tokenEndpoint,
    token_endpoint: tokens.tokenEndpoint,
    response_types_supported: ["code"],
  } as AuthorizationServerMetadata;
}

export type McpTokenRefresher = {
  /** Refreshes unless the stored access token already differs from `stale`
   * (someone else refreshed meanwhile); returns the current tokens. */
  refresh(server: string, agentId: string, stale: string): Promise<McpOAuthTokens>;
};

export function mcpTokenRefresher(deps: {
  vault: Vault;
  servers: McpServers;
  fetch: FetchLike;
  now: () => number;
}): McpTokenRefresher {
  const inFlight = new Map<string, Promise<McpOAuthTokens>>();

  async function refreshOnce(server: string, agentId: string, stale: string): Promise<McpOAuthTokens> {
    const current = parseMcpOAuthTokens(
      server,
      await deps.vault.get(mcpOAuthVaultName(server), { agentId })
    );
    if (current.accessToken !== stale) return current;
    if (current.refreshToken === undefined) {
      await deps.servers.setStatus(server, "needs_auth", "no_refresh_token");
      throw new McpNeedsSignIn(server);
    }

    let issued;
    try {
      issued = await refreshAuthorization(current.tokenEndpoint, {
        metadata: tokenMetadata(current),
        clientInformation: {
          client_id: current.clientId,
          ...(current.clientSecret === undefined ? {} : { client_secret: current.clientSecret }),
        },
        refreshToken: current.refreshToken,
        resource: new URL(current.resource),
        fetchFn: deps.fetch,
      });
    } catch (error) {
      if (error instanceof OAuthError) {
        await deps.servers.setStatus(server, "needs_auth", error.code);
        if (error.code === "invalid_grant") throw new McpNeedsSignIn(server);
        throw new Error(`mcp server ${server} token refresh failed: ${error.code}`);
      }
      throw new Error(`mcp server ${server} token refresh failed`);
    }

    const next: McpOAuthTokens = {
      ...current,
      accessToken: issued.access_token,
      refreshToken: issued.refresh_token ?? current.refreshToken,
      expiresAt: issued.expires_in === undefined ? undefined : deps.now() + issued.expires_in * 1000,
    };
    if (next.expiresAt === undefined) delete next.expiresAt;
    await storeMcpOAuthTokens(deps.vault, deps.servers, server, next);
    return next;
  }

  return {
    refresh(server, agentId, stale) {
      const running = inFlight.get(server);
      if (running !== undefined) return running;
      const flight = refreshOnce(server, agentId, stale).finally(() => inFlight.delete(server));
      inFlight.set(server, flight);
      return flight;
    },
  };
}
