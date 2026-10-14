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
  /** Which GitHub this rule fronts: git smart HTTP or the REST API. Defaults
   * from the upstream (github.com → git, api.github.com → api); any other
   * upstream must say, or every request is refused. */
  surface?: "git" | "api";
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

/** The rule's surface, explicit or from the upstream host; null when neither. */
export function githubSurface(rule: GitHubRule): "git" | "api" | null {
  if (rule.surface !== undefined) return rule.surface;
  const host = new URL(rule.upstream).host;
  if (host === "github.com") return "git";
  if (host === "api.github.com") return "api";
  return null;
}

/** The attached repositories' names under their one owner. An installation
 * belongs to one account, so `repos` spanning owners is a misconfiguration. */
export function installationRepoNames(repos: readonly string[]): string[] {
  const split = repos.map((repo) => repo.split("/"));
  if (split.length === 0 || split.some((parts) => parts.length !== 2 || parts[0] === "" || parts[1] === "")) {
    throw new Error("github-app repos must be non-empty `owner/name` entries");
  }
  if (new Set(split.map(([owner]) => owner)).size !== 1) {
    throw new Error("github-app repos must share one owner (an installation covers one account)");
  }
  return split.map(([, name]) => name);
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
  const repositories = installationRepoNames(auth.repos);
  let cached: { token: string; expiresAtMs: number } | null = null;
  // concurrent callers share one mint instead of each minting a token
  let inFlight: Promise<string> | null = null;

  async function mint(): Promise<string> {
    // The key belongs to the broker, not to the calling agent (rule.agents
    // gates agents), so its vault entry must allow the "broker" identity.
    const privateKey = await vault.get(auth.privateKeySecret, { agentId: "broker" });
    const jwt = buildAppJwt(auth.appId, privateKey, now());
    const response = await fetchImpl(`${apiUrl.replace(/\/+$/, "")}/app/installations/${auth.installationId}/access_tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json", accept: "application/vnd.github+json" },
      // repository names only, exactly the attached set, and the least
      // permissions git+PR work needs.
      body: JSON.stringify({
        repositories,
        permissions: { contents: "write", pull_requests: "write", metadata: "read" },
      }),
    });
    if (!response.ok) {
      throw new Error(`installation token request failed: ${response.status}`);
    }
    const minted = (await response.json()) as { token?: unknown; expires_at?: unknown };
    const expiresAtMs = typeof minted.expires_at === "string" ? Date.parse(minted.expires_at) : Number.NaN;
    if (typeof minted.token !== "string" || minted.token === "" || !Number.isFinite(expiresAtMs)) {
      throw new Error("installation token response is malformed");
    }
    cached = { token: minted.token, expiresAtMs };
    return minted.token;
  }

  return {
    async getToken(): Promise<string> {
      if (cached !== null && now() < cached.expiresAtMs - EXPIRY_MARGIN_MS) {
        return cached.token;
      }
      if (inFlight === null) {
        inFlight = mint().finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
    },
  };
}
