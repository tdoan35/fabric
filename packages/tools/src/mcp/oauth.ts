// MCP OAuth (ANY-78, ANY-44 D6): sign-in to a remote MCP server with OAuth
// 2.1 authorization code + PKCE S256, as the MCP authorization spec
// describes — RFC 9728 protected-resource discovery, RFC 8414 / OIDC
// authorization-server metadata, RFC 7591 registration when no client id is
// given, RFC 8707 `resource` — through the SDK's auth helpers. One sign-in
// per server per workspace (Ty, 2026-10-13); the tokens live in the vault
// under `mcp_<server>_oauth`, readable by the server's attached agents only,
// and follow attach/detach through servers.onAgentsChanged. `fetchFor` is
// the bearer-adding fetch M4's mcpClient takes, refreshing once on a 401.
// The HTTP routes (start, callback) come with the second batch.
import { randomBytes } from "node:crypto";
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  extractWWWAuthenticateParams,
  OAuthError,
  registerClient,
  startAuthorization,
  type AuthorizationServerMetadata,
  type FetchLike,
  type OAuthClientInformationMixed,
  type OAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/client";
import type { RuntimeStore } from "@fabric/runtime";
import type { Vault } from "../vault";
import type { McpServers } from "./servers";
import {
  McpNeedsSignIn,
  MCP_REFRESH_SKEW_MS,
  mcpOAuthVaultName,
  mcpTokenRefresher,
  parseMcpOAuthTokens,
  storeMcpOAuthTokens,
  type McpOAuthTokens,
} from "./tokens";

/** A started sign-in waits this long for its callback. */
export const MCP_OAUTH_PENDING_MS = 10 * 60 * 1000;

export type McpOAuth = {
  start(
    server: string,
    options: { redirectUri: string; clientId?: string; clientSecret?: string }
  ): Promise<{ authorizeUrl: string }>;
  /** The callback: `state` is single use and expires after 10 minutes. */
  finish(callback: { state: string; code: string }): Promise<void>;
  /** The bearer header for `agentId`; VaultDenied when it isn't attached. */
  headers(server: string, agentId: string): Promise<Record<string, string>>;
  /** M4's `mcpClient({ fetch })`: adds the bearer, refreshes once on a 401. */
  fetchFor(server: string, agentId: string): FetchLike;
  /** Revokes (best effort), deletes the tokens and pending sign-ins; status needs_auth. */
  disconnect(server: string): Promise<void>;
};

/** What finish needs from start, kept in the pending row's `client` column. */
type PendingClient = {
  clientId: string;
  clientSecret?: string;
  metadata: AuthorizationServerMetadata;
};

function clientInformation(client: { clientId: string; clientSecret?: string }): OAuthClientInformationMixed {
  return {
    client_id: client.clientId,
    ...(client.clientSecret === undefined ? {} : { client_secret: client.clientSecret }),
  };
}

/** RFC 9728 §3.3: the metadata must be about this resource (same origin, path prefix). */
function resourceMatches(metadata: OAuthProtectedResourceMetadata, resourceUrl: string): boolean {
  if (metadata.resource === undefined) return true;
  const declared = new URL(metadata.resource);
  const actual = new URL(resourceUrl);
  return declared.origin === actual.origin && actual.pathname.startsWith(declared.pathname.replace(/\/$/, ""));
}

function withAuthorization(init: RequestInit | undefined, authorization: string): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", authorization);
  return { ...init, headers };
}

export function mcpOAuth(deps: {
  servers: McpServers;
  vault: Vault;
  store: RuntimeStore;
  workspaceId: string;
  fetch?: FetchLike;
  now?: () => number;
}): McpOAuth {
  const { servers, vault, store, workspaceId } = deps;
  const fetchFn: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));
  const now = deps.now ?? Date.now;
  const refresher = mcpTokenRefresher({ vault, servers, fetch: fetchFn, now });
  const query = (sql: string, params: readonly unknown[]) =>
    store.transaction((tx) => tx.query(sql, params));

  async function serverUrl(server: string): Promise<string> {
    const record = await servers.get(server);
    if (record === undefined) throw new Error(`unknown mcp server ${server}`);
    return record.url;
  }

  /** The stored tokens, read as any agent the entry lists; undefined when
   * there is no entry or no one can read it. For disconnect and agent sync. */
  async function readStored(server: string): Promise<McpOAuthTokens | undefined> {
    const name = mcpOAuthVaultName(server);
    const entry = (await vault.list()).find((candidate) => candidate.name === name);
    if (entry === undefined) return undefined;
    const reader = entry.agents === "all" ? "fabric" : entry.agents[0];
    if (reader === undefined) return undefined;
    try {
      return parseMcpOAuthTokens(server, await vault.get(name, { agentId: reader }));
    } catch {
      return undefined;
    }
  }

  /** RFC 7009, best effort: a failure is ignored. */
  async function revoke(tokens: McpOAuthTokens): Promise<void> {
    if (tokens.revocationEndpoint === undefined) return;
    const body = new URLSearchParams({
      token: tokens.refreshToken ?? tokens.accessToken,
      token_type_hint: tokens.refreshToken === undefined ? "access_token" : "refresh_token",
      client_id: tokens.clientId,
    });
    if (tokens.clientSecret !== undefined) body.set("client_secret", tokens.clientSecret);
    try {
      const response = await fetchFn(tokens.revocationEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      await response.body?.cancel();
    } catch {
      // Best effort: the tokens are deleted here either way.
    }
  }

  async function signOut(server: string): Promise<void> {
    const tokens = await readStored(server);
    if (tokens !== undefined) await revoke(tokens);
    await vault.delete(mcpOAuthVaultName(server));
    await query(`delete from mcp_oauth_pending where workspace_id = $1 and server = $2`, [workspaceId, server]);
    if ((await servers.get(server)) !== undefined) await servers.setStatus(server, "needs_auth");
  }

  // Agent sync: the vault entry's agents are the server's attached agents.
  // With none left nobody could read the tokens again (not even to re-list
  // them for a later attach), so the last detach — like remove — signs out.
  servers.onAgentsChanged(async ({ server, agents, removed }) => {
    if (removed || agents.length === 0) {
      await signOut(server);
      return;
    }
    const tokens = await readStored(server);
    if (tokens !== undefined) await storeMcpOAuthTokens(vault, servers, server, tokens);
  });

  async function headers(server: string, agentId: string): Promise<Record<string, string>> {
    const stored = parseMcpOAuthTokens(server, await vault.get(mcpOAuthVaultName(server), { agentId }));
    const expiring = stored.expiresAt !== undefined && stored.expiresAt - MCP_REFRESH_SKEW_MS <= now();
    const tokens = expiring ? await refresher.refresh(server, agentId, stored.accessToken) : stored;
    return { Authorization: `Bearer ${tokens.accessToken}` };
  }

  return {
    async start(server, { redirectUri, clientId, clientSecret }) {
      const resourceUrl = await serverUrl(server);
      await query(`delete from mcp_oauth_pending where workspace_id = $1 and expires_at <= $2`, [
        workspaceId,
        new Date(now()),
      ]);

      // Discovery: the server unauthenticated, then RFC 9728 and RFC 8414.
      const probe = await fetchFn(resourceUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fabric", version: "0.1.0" } },
        }),
      });
      const challenged = probe.status === 401 ? extractWWWAuthenticateParams(probe).resourceMetadataUrl : undefined;
      await probe.body?.cancel();

      let resource: OAuthProtectedResourceMetadata | undefined;
      try {
        resource = await discoverOAuthProtectedResourceMetadata(
          resourceUrl,
          challenged === undefined ? {} : { resourceMetadataUrl: challenged },
          fetchFn
        );
      } catch {
        resource = undefined;
      }
      if (resource === undefined) throw new Error(`mcp server ${server} has no OAuth protected-resource metadata`);
      if (!resourceMatches(resource, resourceUrl)) {
        throw new Error(`mcp server ${server}: protected-resource metadata is for another resource`);
      }
      const issuer = resource.authorization_servers?.[0];
      if (issuer === undefined) throw new Error(`mcp server ${server} names no authorization server`);
      const metadata = await discoverAuthorizationServerMetadata(issuer, { fetchFn });
      if (metadata === undefined) throw new Error(`mcp server ${server}: no authorization-server metadata at ${issuer}`);

      if (!(metadata.code_challenge_methods_supported ?? []).includes("S256")) {
        throw new Error(`mcp server ${server}: the authorization server does not support PKCE S256`);
      }

      let client: { clientId: string; clientSecret?: string };
      if (clientId !== undefined) {
        client = { clientId, ...(clientSecret === undefined ? {} : { clientSecret }) };
      } else if (metadata.registration_endpoint !== undefined) {
        const registered = await registerClient(issuer, {
          metadata,
          clientMetadata: {
            client_name: "Fabric",
            redirect_uris: [redirectUri],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
          },
          fetchFn,
        });
        client = {
          clientId: registered.client_id,
          ...(registered.client_secret === undefined ? {} : { clientSecret: registered.client_secret }),
        };
      } else {
        throw new Error(`mcp server ${server} needs a client id`);
      }

      const state = randomBytes(32).toString("base64url");
      const scope = resource.scopes_supported?.length ? resource.scopes_supported.join(" ") : undefined;
      const { authorizationUrl, codeVerifier } = await startAuthorization(issuer, {
        metadata,
        clientInformation: clientInformation(client),
        redirectUrl: redirectUri,
        ...(scope === undefined ? {} : { scope }),
        state,
        resource: new URL(resourceUrl),
      });

      const pending: PendingClient = { ...client, metadata };
      await query(
        `insert into mcp_oauth_pending (workspace_id, state, server, code_verifier, redirect_uri, client, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [workspaceId, state, server, codeVerifier, redirectUri, JSON.stringify(pending), new Date(now() + MCP_OAUTH_PENDING_MS)]
      );
      return { authorizeUrl: authorizationUrl.toString() };
    },

    async finish({ state, code }) {
      const rows = await query(
        `delete from mcp_oauth_pending where workspace_id = $1 and state = $2
         returning server, code_verifier, redirect_uri, client, expires_at`,
        [workspaceId, state]
      );
      const row = rows[0];
      if (row === undefined) throw new Error("mcp oauth sign-in state is unknown or already used");
      if (!(row.expires_at instanceof Date) || row.expires_at.getTime() <= now()) {
        throw new Error("mcp oauth sign-in state has expired");
      }
      const server = String(row.server);
      const resourceUrl = await serverUrl(server);
      const client = JSON.parse(String(row.client)) as PendingClient;

      let issued;
      try {
        issued = await exchangeAuthorization(client.metadata.issuer, {
          metadata: client.metadata,
          clientInformation: clientInformation(client),
          authorizationCode: code,
          codeVerifier: String(row.code_verifier),
          redirectUri: String(row.redirect_uri),
          resource: new URL(resourceUrl),
          fetchFn,
        });
      } catch (error) {
        const reason = error instanceof OAuthError ? error.code : "token_request_failed";
        await servers.setStatus(server, "needs_auth", reason);
        throw new Error(`mcp server ${server} sign-in failed: ${reason}`);
      }

      // RFC 8414 metadata may name one; the SDK's OIDC-shaped type doesn't list it.
      const revocation = (client.metadata as { revocation_endpoint?: unknown }).revocation_endpoint;
      const revocationEndpoint = typeof revocation === "string" ? revocation : undefined;
      const tokens: McpOAuthTokens = {
        accessToken: issued.access_token,
        ...(issued.refresh_token === undefined ? {} : { refreshToken: issued.refresh_token }),
        ...(issued.expires_in === undefined ? {} : { expiresAt: now() + issued.expires_in * 1000 }),
        tokenEndpoint: String(client.metadata.token_endpoint),
        clientId: client.clientId,
        ...(client.clientSecret === undefined ? {} : { clientSecret: client.clientSecret }),
        resource: resourceUrl,
        ...(revocationEndpoint === undefined ? {} : { revocationEndpoint }),
      };
      await storeMcpOAuthTokens(vault, servers, server, tokens);
      await servers.setStatus(server, "ready");
    },

    headers,

    fetchFor(server, agentId) {
      return async (url, init) => {
        const first = await headers(server, agentId);
        const response = await fetchFn(url, withAuthorization(init, first.Authorization!));
        if (response.status !== 401) return response;
        await response.body?.cancel();

        const refreshed = await refresher.refresh(server, agentId, first.Authorization!.slice("Bearer ".length));
        const retry = await fetchFn(url, withAuthorization(init, `Bearer ${refreshed.accessToken}`));
        if (retry.status !== 401) return retry;
        await retry.body?.cancel();
        await servers.setStatus(server, "needs_auth", "unauthorized");
        throw new McpNeedsSignIn(server);
      };
    },

    disconnect: signOut,
  };
}
