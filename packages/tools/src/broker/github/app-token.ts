// GitHub App auth (ANY-44 T11, D3): installation tokens minted through
// POST /app/installations/{id}/access_tokens, authenticated by an RS256 JWT
// signed with the vault-held private key. Tokens are cached per manager
// until five minutes before expires_at. The broker creates one manager per
// github-app rule; the unit tests drive the manager directly against a fake
// GitHub.
import { createSign } from "node:crypto";
import type { Vault } from "../../vault";

export type GitHubAppAuth = {
  type: "github-app";
  appId: number;
  installationId: number;
  /** The vault entry holding the GitHub App private key (PEM, PKCS#8). */
  privateKeySecret: string;
  /** Attached repositories, `owner/name`. */
  repos: readonly string[];
  /** The API origin for token minting; defaults to GitHub. */
  apiUrl?: string;
};

/** A rule whose credential is a GitHub App installation token. */
export type GitHubRule = {
  name: string;
  /** The git or API upstream origin this rule fronts. */
  upstream: string;
  auth: GitHubAppAuth;
  methods: string[];
  paths: string[];
  agents: readonly string[] | "all";
};

const DEFAULT_API_URL = "https://api.github.com";

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Narrows a broker rule to the GitHub App form (the broker branches on this). */
export function isGitHubRule(rule: { auth: { type: string } }): rule is GitHubRule {
  return rule.auth.type === "github-app";
}
export function buildAppJwt(appId: number, privateKeyPem: string, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000) - 60;
  const header = base64Url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64Url(Buffer.from(JSON.stringify({ iat, exp: iat + 9 * 60, iss: appId })));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  return `${header}.${payload}.${base64Url(signer.sign(privateKeyPem))}`;
}

/** A token minted (or cached) for one installation. */
export type AppTokenManager = {
  /** The installation token, minting when absent or near expiry. */
  getToken(): Promise<string>;
};

export type AppTokenOptions = {
  auth: GitHubAppAuth;
  vault: Vault;
  /** Injectable clock for tests; defaults to Date.now(). */
  now?: () => number;
  /** Injectable fetch for tests; defaults to the global. */
  fetchImpl?: typeof fetch;
};

/** Re-mint this early before the token's expires_at. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export function createAppTokenManager(options: AppTokenOptions): AppTokenManager {
  const { auth, vault, now = Date.now, fetchImpl = fetch } = options;
  const apiUrl = auth.apiUrl ?? DEFAULT_API_URL;
  let cached: { token: string; expiresAtMs: number } | null = null;

  return {
    async getToken(): Promise<string> {
      if (cached !== null && now() < cached.expiresAtMs - EXPIRY_MARGIN_MS) {
        return cached.token;
      }
      const privateKey = await vault.get(auth.privateKeySecret, { agentId: "broker" });
      const jwt = buildAppJwt(auth.appId, privateKey, now());
      const response = await fetchImpl(`${apiUrl.replace(/\/+$/, "")}/app/installations/${auth.installationId}/access_tokens`, {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json", accept: "application/vnd.github+json" },
        // repository names only, exactly the attached set, and the least
        // permissions git+PR work needs.
        body: JSON.stringify({
          repositories: auth.repos.map((repo) => repo.split("/")[1] ?? repo),
          permissions: { contents: "write", pull_requests: "write", metadata: "read" },
        }),
      });
      if (!response.ok) {
        throw new Error(`installation token request failed: ${response.status}`);
      }
      const minted = (await response.json()) as { token: string; expires_at: string };
      cached = { token: minted.token, expiresAtMs: Date.parse(minted.expires_at) };
      return cached.token;
    },
  };
}
