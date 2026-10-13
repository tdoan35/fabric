// Egress tokens (ANY-44 T5, D3): what a sandbox holds instead of a
// credential. Random 32 bytes, base64url, in memory owned by the broker
// process; resolving returns the identity until the token expires or is
// revoked. The clock is injectable so expiry is testable.
import { randomBytes } from "node:crypto";

export type TokenIdentity = { workspaceId: string; agentId: string };

export type TokenStore = {
  issue(input: { workspaceId: string; agentId: string; ttlMs: number }): string;
  revoke(token: string): void;
  /** The identity, or null once expired or revoked. */
  resolve(token: string): TokenIdentity | null;
};

export function createTokenStore(now: () => number = () => Date.now()): TokenStore {
  const live = new Map<
    string,
    { identity: TokenIdentity; expiresAt: number; revoked: boolean }
  >();

  return {
    issue({ workspaceId, agentId, ttlMs }) {
      const token = randomBytes(32).toString("base64url");
      live.set(token, {
        identity: { workspaceId, agentId },
        expiresAt: now() + ttlMs,
        revoked: false,
      });
      return token;
    },

    revoke(token) {
      const entry = live.get(token);
      if (entry !== undefined) entry.revoked = true;
    },

    resolve(token) {
      const entry = live.get(token);
      if (entry === undefined || entry.revoked || now() >= entry.expiresAt) return null;
      return { ...entry.identity };
    },
  };
}
