// The broker pipeline (ANY-44 T5, D3): six checks in order — token, rule,
// agent, method, path, credential — each refusal a 403 with a JSON reason
// that never reaches the upstream, then a fail-closed forward: sanitized
// headers, the credential attached per the rule's auth, body streamed,
// redirects unfollowed (cross-host Location stripped). Every request is
// audited through `onUse` — identity, rule, method, host, path, status —
// never the secret value. `github-app` rules (T11) add the git and API
// policies of ./github; their git refusals are plain text, and a refused
// push is a receive-pack report, so git shows the agent the reason.
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import type { Vault } from "../vault";
import { normalizePath, pathAllowed, type CredentialAuth, type CredentialRule } from "./rules";
import type { TokenStore } from "./tokens";
import {
  checkApiRequest,
  checkGitRequest,
  checkPushCommands,
  createAppTokenManager,
  githubSurface,
  isGitHubRule,
  pushRejection,
  readPushCommands,
  repoAttached,
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

/** The installation credential: basic `x-access-token` over git HTTP
 * (git's native form), Bearer on the API. */
function gitHubCredential(surface: "git" | "api", token: string): Record<string, string> {
  if (surface === "api") return { authorization: `Bearer ${token}` };
  return {
    authorization: `Basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")}`,
  };
}

/** The bytes already read, then the rest of the request as it arrives —
 * the pack streams through, never buffered. */
function prefixedBody(head: Buffer, rest: AsyncIterator<unknown>): ReadableStream<Uint8Array> {
  let headSent = head.length === 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!headSent) {
        headSent = true;
        controller.enqueue(head);
        return;
      }
      const next = await rest.next();
      if (next.done === true) controller.close();
      else controller.enqueue(Buffer.from(next.value as Uint8Array));
    },
    async cancel() {
      await rest.return?.();
    },
  });
}

// -- the pipeline ----------------------------------------------------------------

function refuse(
  deps: BrokerDeps,
  res: ServerResponse,
  base: Omit<BrokerUseRecord, "status" | "allowed" | "reason">,
  reason: string,
  format: "json" | "text" = "json"
): void {
  deps.onUse({ ...base, status: 403, allowed: false, reason });
  if (format === "text") {
    // git prints a text/plain error body to the user ("remote: …")
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end(`${reason}\n`);
    return;
  }
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

  // 5. path — the RAW path is validated first, before any URL parsing can
  // rewrite it: a backslash (read as `/` by the WHATWG parser), `%2F`
  // smuggling or a `..` segment is refused outright. Only then is the final
  // URL built, and its canonical pathname is what the rule authorizes and
  // what gets forwarded — so the check and the request are the same path,
  // never one the parser resolved behind the check's back.
  const decodedPath = normalizePath(rawPath);
  if (decodedPath === null) {
    return refuse(deps, res, identified, "path not allowed");
  }
  let target: URL;
  try {
    target = new URL(`${rule.upstream.replace(/\/+$/, "")}${rawPath}${query}`);
  } catch {
    return refuse(deps, res, identified, "path not allowed");
  }
  const canonicalPath = normalizePath(target.pathname);
  if (canonicalPath === null || canonicalPath !== decodedPath) {
    return refuse(deps, res, identified, "path not allowed");
  }
  if (!pathAllowed(rule.paths, decodedPath)) {
    return refuse(deps, res, identified, "path not allowed");
  }

  // 6. credential + (github-app) policy — fail-closed: nothing is sent
  // without a credential, and GitHub rules enforce their repo/push/API
  // policy before a token is minted or anything leaves.
  const hasBody = method !== "GET" && method !== "HEAD";
  let credential: Record<string, string>;
  let body: ReadableStream<Uint8Array> | undefined;

  if (isGitHubRule(rule)) {
    const surface = githubSurface(rule);
    if (surface === null) {
      return refuse(deps, res, identified, "github-app rule needs a surface (git or api) for this upstream");
    }
    const format = surface === "git" ? "text" : "json";

    let manager = appTokenManagers.get(rule);
    if (manager === undefined) {
      try {
        manager = createAppTokenManager({ auth: rule.auth, vault: deps.vault });
      } catch (error) {
        // configuration errors only: the manager touches no secret until a mint
        return refuse(deps, res, identified, (error as Error).message, format);
      }
      appTokenManagers.set(rule, manager);
    }

    // policy first: a refusal never mints a token
    if (surface === "git") {
      const gitRequest = checkGitRequest(method, decodedPath, query);
      if (!gitRequest.ok) return refuse(deps, res, identified, gitRequest.reason, format);
      if (!repoAttached(rule.auth.repos, gitRequest.owner, gitRequest.repo)) {
        return refuse(deps, res, identified, `repo not attached to this installation: ${gitRequest.owner}/${gitRequest.repo}`, format);
      }
      if (gitRequest.kind === "receive-pack") {
        // read the ref commands off the front of the body, never the pack
        const source = req[Symbol.asyncIterator]();
        const read = await readPushCommands(source);
        if (read.outcome !== "complete") {
          return refuse(deps, res, identified, `push refused: ref-update commands ${read.outcome}`, format);
        }
        const verdict = checkPushCommands(read.commands);
        if (!verdict.ok) {
          const report = pushRejection(read.commands, verdict);
          if (report === null) return refuse(deps, res, identified, verdict.reason, format);
          // answered as GitHub answers a declined push: 200 with each ref
          // rejected and its reason, which git shows as `! [remote rejected]`
          deps.onUse({ ...identified, status: 200, allowed: false, reason: verdict.reason });
          res.writeHead(200, {
            "content-type": "application/x-git-receive-pack-result",
            "cache-control": "no-cache",
          });
          res.end(report);
          return;
        }
        body = prefixedBody(read.head, source);
      } else if (hasBody) {
        body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
      }
    } else {
      const verdict = checkApiRequest(method, decodedPath, rule.auth.repos);
      if (!verdict.ok) return refuse(deps, res, identified, verdict.reason, format);
      if (hasBody) body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
    }

    let token: string;
    try {
      token = await manager.getToken();
    } catch {
      return refuse(deps, res, identified, "credential unavailable", format);
    }
    credential = gitHubCredential(surface, token);
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

  // forward — the exact canonical URL authorized above
  const targetString = target.toString();
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
    upstream = await fetch(targetString, init);
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
        sameHost = new URL(location, targetString).host === target.host;
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
