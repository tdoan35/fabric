// The API policy (ANY-44 T11, D3): what an agent may do on api.github.com
// through the broker — read attached repos, open PRs, comment on issues;
// never merge (that is the human's call), never delete, never graphql.
import type { PolicyVerdict } from "./receive-pack";

/** The `owner/repo` an API path addresses, or null when the path is not
 * under /repos. */
export function repoFromApiPath(path: string): { owner: string; repo: string } | null {
  const match = path.match(/^\/repos\/([^/]+)\/([^/]+)/);
  return match === null ? null : { owner: match[1], repo: match[2] };
}

/** True when `owner/repo` is one of the attached repositories. */
export function repoAttached(repos: readonly string[], owner: string, repo: string): boolean {
  return repos.includes(`${owner}/${repo}`);
}

/** One API request against the allowlist. Repo attachment is assumed to be
 * checked by the caller for /repos paths (the git rules need it too). */
export function checkApiRequest(method: string, path: string, repos: readonly string[]): PolicyVerdict {
  if (path === "/graphql" || path.startsWith("/graphql/")) {
    return { ok: false, reason: "graphql is not allowed through the broker" };
  }
  const addressed = repoFromApiPath(path);
  if (addressed === null) {
    return { ok: false, reason: `api path outside /repos is not allowed: ${path}` };
  }
  if (!repoAttached(repos, addressed.owner, addressed.repo)) {
    return { ok: false, reason: `repo not attached to this installation: ${addressed.owner}/${addressed.repo}` };
  }
  if (method === "DELETE") {
    return { ok: false, reason: "DELETE is not allowed through the broker" };
  }
  if (method === "PUT" && /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/merge$/.test(path)) {
    return { ok: false, reason: "merge is always human: PUT …/pulls/n/merge is not allowed" };
  }
  if (method === "GET") {
    return { ok: true };
  }
  if (method === "POST") {
    if (/^\/repos\/[^/]+\/[^/]+\/pulls$/.test(path)) return { ok: true };
    if (/^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.test(path)) return { ok: true };
    return { ok: false, reason: `api ${method} is not allowed: ${path}` };
  }
  return { ok: false, reason: `api ${method} is not allowed: ${path}` };
}
