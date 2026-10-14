// The broker pipeline (ANY-44 T5, D3): six checks in order — token, rule,
// agent, method, path, credential — each refusal a 403 with a JSON reason
// that never reaches the upstream, then a fail-closed forward: sanitized
// headers, the credential attached per the rule's auth, body streamed,
// redirects unfollowed (cross-host Location stripped). Every request is
// audited through `onUse` — identity, rule, method, host, path, status —
// never the secret value.
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import type { Vault } from "../vault";
import { normalizePath, pathAllowed, type CredentialAuth, type CredentialRule } from "./rules";
import type { TokenStore } from "./tokens";
import {
  checkApiRequest,
  checkPushCommands,
  createAppTokenManager,
  isGitHubRule,
  repoAttached,
  repoFromGitPath,
  type AppTokenManager,
  type GitHubRule,
} from "./github";

export type BrokerUseRecord = {
  workspaceId: string | null;
  agentId: string | null;
  rule: string;
  method: string;
  /** The rule's upstream host; null when the rule itself was unknown. */
  host: string | null;
  path: string;
  status: number;
  allowed: boolean;
  reason?: string;
};

/** A credential rule, or a GitHub App rule (T11) whose credential is an
 * installation token and whose traffic passes the git/API policies. */
export type BrokerRule = CredentialRule | GitHubRule;

export type BrokerDeps = {
  vault: Vault;
  rules: readonly BrokerRule[];
  tokens: TokenStore;
  onUse: (record: BrokerUseRecord) => void;
};

export type BrokerServer = { url: string; close(): Promise<void> };

// -- header hygiene -------------------------------------------------------------

const DROPPED_REQUEST_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function isDroppedRequestHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    DROPPED_REQUEST_HEADERS.has(lower) ||
    lower.startsWith("proxy-") ||
    lower.startsWith("x-fabric-")
  );
}

function credentialHeader(auth: CredentialAuth, secret: string): Record<string, string> {
  if (auth.type === "bearer") return { authorization: `Bearer ${secret}` };
  if (auth.type === "header") return { [auth.header]: secret };
  return {
    authorization: `Basic ${Buffer.from(`${auth.user}:${secret}`, "utf8").toString("base64")}`,
  };
}

function forwardHeaders(
  incoming: IncomingHttpHeaders,
  credential: Record<string, string>
): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || isDroppedRequestHeader(name)) continue;
    forwarded[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return { ...forwarded, ...credential };
}

/** The egress token: `Bearer <token>` or the password of a basic-auth pair
 * (so git works later). Null when no usable token is presented. */
function tokenFromAuth(header: unknown): string | null {
  if (typeof header !== "string" || header === "") return null;
  if (header.startsWith("Bearer ")) {
    const token = header.slice("Bearer ".length).trim();
    return token === "" ? null : token;
  }
  if (header.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(header.slice("Basic ".length).trim(), "base64").toString(
        "utf8"
      );
      const colon = decoded.indexOf(":");
      if (colon === -1) return null;
      const token = decoded.slice(colon + 1);
      return token === "" ? null : token;
    } catch {
      return null;
    }
  }
  return null;
}

// -- github-app rules (T11) -------------------------------------------------------

/** One token manager per rule object: the installation token is cached
 * across requests for the rule's lifetime. */
const appTokenManagers = new WeakMap<GitHubRule, AppTokenManager>();

/** git smart-HTTP paths: `/<owner>/<repo>(.git)/(info/refs|git-*-pack)`. */
const GIT_SMART_PATH = /^\/[^/]+\/[^/]+(?:\.git)?\/(?:info\/refs|git-upload-pack|git-receive-pack)$/;

/** The installation credential: basic `x-access-token` over git HTTP
 * (git's native form), Bearer everywhere else (the API). */
function gitCredential(isGitPath: boolean, token: string): Record<string, string> {
  if (!isGitPath) return { authorization: `Bearer ${token}` };
  return {
    authorization: `Basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")}`,
  };
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

// -- the pipeline ----------------------------------------------------------------

function refuse(
  deps: BrokerDeps,
  res: ServerResponse,
  base: Omit<BrokerUseRecord, "status" | "allowed" | "reason">,
  reason: string
): void {
  deps.onUse({ ...base, status: 403, allowed: false, reason });
  res.writeHead(403, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: reason }));
}

/**
 * Handle one broker request: `/egress/<rule>/<path>?<query>`. Refusals are
 * answered 403 and never forwarded; an allowed request is forwarded and the
 * upstream response streamed back.
 */
export async function handleBrokerRequest(
  deps: BrokerDeps,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = req.url ?? "/";
  if (!url.startsWith("/egress/")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  const rest = url.slice("/egress/".length);
  const queryAt = rest.indexOf("?");
  const pathQuery = queryAt === -1 ? rest : rest.slice(0, queryAt);
  const query = queryAt === -1 ? "" : `?${rest.slice(queryAt + 1)}`;
  const slashAt = pathQuery.indexOf("/");
  const ruleName = slashAt === -1 ? pathQuery : pathQuery.slice(0, slashAt);
  const rawPath = slashAt === -1 ? "/" : pathQuery.slice(slashAt);
  const method = (req.method ?? "GET").toUpperCase();

  const rule = deps.rules.find((candidate) => candidate.name === ruleName);
  const host = rule === undefined ? null : new URL(rule.upstream).host;
  const base = {
    rule: ruleName,
    method,
    host,
    path: rawPath,
  };

  // 1. token
  const token = tokenFromAuth(req.headers.authorization);
  if (token === null) {
    return refuse(deps, res, { ...base, workspaceId: null, agentId: null }, "missing token");
  }
  const identity = deps.tokens.resolve(token);
  if (identity === null) {
    return refuse(deps, res, { ...base, workspaceId: null, agentId: null }, "invalid token");
  }
  const identified = { ...base, workspaceId: identity.workspaceId, agentId: identity.agentId };

  // 2. rule
  if (rule === undefined) {
    return refuse(deps, res, identified, "unknown rule");
  }

  // 3. agent
  if (rule.agents !== "all" && !rule.agents.includes(identity.agentId)) {
    return refuse(deps, res, identified, "agent not allowed");
  }

  // 4. method
  if (!rule.methods.includes(method)) {
    return refuse(deps, res, identified, "method not allowed");
  }

  // 5. path (normalised first: .. segments and encoded slashes are refused)
  const decodedPath = normalizePath(rawPath);
  if (decodedPath === null || !pathAllowed(rule.paths, decodedPath)) {
    return refuse(deps, res, identified, "path not allowed");
  }

  // 6. credential + (github-app) policy — fail-closed: nothing is sent
  // without a credential, and GitHub rules enforce their repo/push/API
  // policy before anything leaves.
  const hasBody = method !== "GET" && method !== "HEAD";
  let credential: Record<string, string>;
  let body: Buffer | ReadableStream<Uint8Array> | undefined;

  if (isGitHubRule(rule)) {
    const isGitPath = GIT_SMART_PATH.test(decodedPath);
    if (isGitPath) {
      // git smart HTTP: only the attached repositories, ever
      const addressed = repoFromGitPath(decodedPath);
      if (addressed === null || !repoAttached(rule.auth.repos, addressed.owner, addressed.repo)) {
        return refuse(deps, res, identified, "repo not attached to this installation");
      }
    } else {
      // api.github.com traffic: the API policy decides before a token is minted
      const verdict = checkApiRequest(method, decodedPath, rule.auth.repos);
      if (!verdict.ok) {
        return refuse(deps, res, identified, verdict.reason);
      }
    }

    let token: string;
    try {
      let manager = appTokenManagers.get(rule);
      if (manager === undefined) {
        manager = createAppTokenManager({ auth: rule.auth, vault: deps.vault });
        appTokenManagers.set(rule, manager);
      }
      token = await manager.getToken();
    } catch {
      return refuse(deps, res, identified, "credential unavailable");
    }

    const isReceivePack = method === "POST" && decodedPath.endsWith("/git-receive-pack");
    if (isReceivePack) {
      // the push policy reads the ref commands (never the pack), then the
      // buffered body is forwarded unchanged
      const buffered = await readBody(req);
      const addressed = repoFromGitPath(decodedPath);
      const verdict = await checkPushCommands({
        body: buffered,
        owner: addressed === null ? "" : addressed.owner,
        repo: addressed === null ? "" : addressed.repo,
        apiUrl: rule.auth.apiUrl ?? "https://api.github.com",
        token,
      });
      if (!verdict.ok) {
        return refuse(deps, res, identified, verdict.reason);
      }
      body = buffered;
    } else if (hasBody) {
      body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
    }
    credential = gitCredential(isGitPath, token);
  } else {
    let secret: string;
    try {
      secret = await deps.vault.get(rule.secret, { agentId: identity.agentId });
    } catch {
      return refuse(deps, res, identified, "credential unavailable");
    }
    if (hasBody) {
      body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
    }
    credential = credentialHeader(rule.auth, secret);
  }

  // forward
  const target = `${rule.upstream.replace(/\/+$/, "")}${rawPath}${query}`;
  // Readable.toWeb returns a web stream structurally identical to undici's
  // body type; the DOM-less typings cannot unify them.
  const init: RequestInit = {
    method,
    headers: forwardHeaders(req.headers, credential),
    redirect: "manual",
    ...(body === undefined ? {} : { body, duplex: "half" }),
  };

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch {
    deps.onUse({ ...identified, status: 502, allowed: true, reason: "upstream unreachable" });
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "upstream unreachable" }));
    return;
  }

  deps.onUse({ ...identified, status: upstream.status, allowed: true });

  const responseHeaders: Record<string, string> = {};
  const dropped = new Set([
    "content-encoding",
    "content-length",
    "transfer-encoding",
    "connection",
    "keep-alive",
  ]);
  upstream.headers.forEach((value, name) => {
    if (!dropped.has(name.toLowerCase())) responseHeaders[name] = value;
  });

  // Redirects are returned unfollowed; a Location pointing at another host
  // is stripped so the caller cannot be bounced off the rule's upstream.
  if (upstream.status >= 300 && upstream.status < 400) {
    const location = upstream.headers.get("location");
    if (location !== null) {
      let sameHost = false;
      try {
        sameHost = new URL(location, target).host === new URL(target).host;
      } catch {
        sameHost = false;
      }
      if (!sameHost) delete responseHeaders["location"];
    }
  }

  res.writeHead(upstream.status, responseHeaders);
  if (upstream.body === null) {
    res.end();
    return;
  }
  await pipeline(
    Readable.fromWeb(upstream.body as unknown as NodeWebReadableStream<Uint8Array>),
    res
  );
}
