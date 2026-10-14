// The push policy (ANY-44 T11, D3): before a git-receive-pack POST is
// forwarded, its ref-update commands are parsed (never the pack) and each
// is checked — only refs/heads/fabric/*, never a deletion, never a
// non-fast-forward. Old != zeros is checked against the compare endpoint
// with the same installation token; anything but ahead/identical refuses.
import type { PktCommand } from "./pktline";
import { parsePktLines } from "./pktline";

export type PolicyVerdict = { ok: true } | { ok: false; reason: string };

const ZERO_SHA = "0".repeat(40);
const FABRIC_PREFIX = "refs/heads/fabric/";

export type PushCheckOptions = {
  body: Uint8Array;
  owner: string;
  repo: string;
  apiUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
};

/** The GitHub `owner/repo` of a git smart-HTTP path, or null when the path
 * is not `<owner>/<repo>(.git)/…`. */
export function repoFromGitPath(path: string): { owner: string; repo: string } | null {
  const match = path.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?\//);
  return match === null ? null : { owner: match[1], repo: match[2] };
}

function commandVerdict(command: PktCommand): PolicyVerdict | null {
  if (!command.ref.startsWith(FABRIC_PREFIX)) {
    return { ok: false, reason: `pushes must stay under ${FABRIC_PREFIX}, got ${command.ref}` };
  }
  if (command.new === ZERO_SHA) {
    return { ok: false, reason: `ref deletion is not allowed: ${command.ref}` };
  }
  return null;
}

/** Checks one receive-pack body. Repo attachment is checked first; a body
 * with no commands is refused (a push always has at least one). */
export async function checkPushCommands(options: PushCheckOptions): Promise<PolicyVerdict> {
  const { body, owner, repo, apiUrl, token, fetchImpl = fetch } = options;
  const { commands } = parsePktLines(body);
  if (commands.length === 0) {
    return { ok: false, reason: "no ref-update commands found" };
  }
  for (const command of commands) {
    const local = commandVerdict(command);
    if (local !== null) return local;
    if (command.old === ZERO_SHA) continue; // new branch: fast-forward by definition
    const response = await fetchImpl(
      `${apiUrl.replace(/\/+$/, "")}/repos/${owner}/${repo}/compare/${command.old}...${command.new}`,
      { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } }
    );
    if (!response.ok) {
      return { ok: false, reason: `cannot verify fast-forward for ${command.ref}` };
    }
    const compare = (await response.json()) as { status?: string };
    if (compare.status !== "ahead" && compare.status !== "identical") {
      return { ok: false, reason: `non-fast-forward push to ${command.ref} (compare: ${compare.status ?? "unknown"})` };
    }
  }
  return { ok: true };
}
