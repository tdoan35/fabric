// The push policy (ANY-44 T11, D3): before a git-receive-pack POST is
// forwarded, its ref-update commands are read off the front of the body
// (never the pack) and each is checked — only refs/heads/fabric/*, never a
// deletion. Fast-forward is GitHub's to enforce: a ruleset on
// refs/heads/fabric/** blocks force pushes (the new commits are still in
// the pack here, so the broker cannot compare them). A refused push is
// answered the way GitHub answers one, with a report-status that rejects
// each ref and says why, so git prints the reason to the agent.
import { FLUSH_PKT, parsePktLines, pktLine, type PktCommand } from "./pktline";

export type PolicyVerdict = { ok: true } | { ok: false; reason: string };

/** A push verdict: on refusal, every ref of the push with its reason (the
 * push is all or nothing). */
export type PushVerdict =
  | { ok: true }
  | { ok: false; reason: string; rejected: { ref: string; reason: string }[] };

const ZERO_SHA = "0".repeat(40);
const FABRIC_PREFIX = "refs/heads/fabric/";

/** The command section is a few lines per ref; past this it is refused. */
export const COMMAND_SECTION_LIMIT = 64 * 1024;

/** The GitHub `owner/repo` of a git smart-HTTP path, or null when the path
 * is not `<owner>/<repo>(.git)/…`. */
export function repoFromGitPath(path: string): { owner: string; repo: string } | null {
  const match = path.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?\//);
  return match === null ? null : { owner: match[1], repo: match[2] };
}

function commandRefusal(command: PktCommand): string | null {
  if (!command.ref.startsWith(FABRIC_PREFIX)) {
    return `pushes must stay under ${FABRIC_PREFIX}, got ${command.ref}`;
  }
  if (command.new === ZERO_SHA) {
    return `ref deletion is not allowed: ${command.ref}`;
  }
  return null;
}

/** Checks a push's ref commands. No commands is allowed: git's probe before
 * a large push is a bare flush, and receive-pack updates nothing for it. */
export function checkPushCommands(commands: readonly PktCommand[]): PushVerdict {
  const refusals = commands.map((command) => ({ ref: command.ref, reason: commandRefusal(command) }));
  const first = refusals.find((refusal) => refusal.reason !== null);
  if (first === undefined || first.reason === null) return { ok: true };
  return {
    ok: false,
    reason: first.reason,
    rejected: refusals.map(({ ref, reason }) => ({
      ref,
      reason: reason ?? `refused with the rest of the push: ${first.reason}`,
    })),
  };
}

export type PushCommands = {
  /** Every byte read so far — forwarded first, then the rest of the body. */
  head: Buffer;
  commands: PktCommand[];
  outcome: "complete" | "malformed" | "truncated" | "too-large";
};

/** Reads chunks until the command section's flush packet, and no further:
 * the pack behind it stays unread in `source` for the caller to stream. */
export async function readPushCommands(
  source: AsyncIterator<unknown>,
  limit: number = COMMAND_SECTION_LIMIT
): Promise<PushCommands> {
  let head = Buffer.alloc(0);
  for (;;) {
    const parsed = parsePktLines(head);
    if (parsed.state === "malformed") return { head, commands: [], outcome: "malformed" };
    if (parsed.state === "complete" && parsed.consumed <= limit) {
      return { head, commands: parsed.commands, outcome: "complete" };
    }
    if (parsed.state === "complete" || head.length >= limit) return { head, commands: [], outcome: "too-large" };
    const next = await source.next();
    if (next.done === true) return { head, commands: [], outcome: "truncated" };
    head = Buffer.concat([head, Buffer.from(next.value as Uint8Array)]);
  }
}

/** Band payload limits: side-band-64k frames 65520 bytes, side-band 1000. */
const BAND_LIMIT = { "side-band-64k": 65515, "side-band": 995 } as const;

/**
 * The receive-pack response refusing a push: `unpack ok` then `ng <ref>
 * <reason>` per ref, inside band 1 when the client asked for a side band.
 * Null when the client asked for no report-status (nothing to say it in).
 */
export function pushRejection(commands: readonly PktCommand[], verdict: Extract<PushVerdict, { ok: false }>): Buffer | null {
  const caps = new Set((commands[0]?.caps ?? "").split(" "));
  if (!caps.has("report-status") && !caps.has("report-status-v2")) return null;
  const status = Buffer.concat([
    pktLine("unpack ok\n"),
    ...verdict.rejected.map(({ ref, reason }) => pktLine(`ng ${ref} ${reason.replace(/[\r\n]+/g, " ")}\n`)),
    FLUSH_PKT,
  ]);
  const band = caps.has("side-band-64k") ? "side-band-64k" : caps.has("side-band") ? "side-band" : null;
  if (band === null) return status;
  const frames: Buffer[] = [];
  for (let at = 0; at < status.length; at += BAND_LIMIT[band]) {
    frames.push(pktLine(Buffer.concat([Buffer.from([1]), status.subarray(at, at + BAND_LIMIT[band])])));
  }
  return Buffer.concat([...frames, FLUSH_PKT]);
}

export type GitRequest =
  | { ok: true; kind: "info-refs" | "upload-pack" | "receive-pack"; owner: string; repo: string }
  | { ok: false; reason: string };

const GIT_SERVICES = new Set(["git-upload-pack", "git-receive-pack"]);

/** The git smart-HTTP allowlist: `GET …/info/refs?service=git-(upload|receive)-pack`
 * and `POST …/git-(upload|receive)-pack`, nothing else (no dumb HTTP). */
export function checkGitRequest(method: string, path: string, query: string): GitRequest {
  const match = path.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/);
  if (match === null) return { ok: false, reason: `not a git smart-HTTP path: ${path}` };
  const [, owner, repo, endpoint] = match;
  if (endpoint === "info/refs") {
    if (method !== "GET") return { ok: false, reason: `info/refs takes GET, got ${method}` };
    const service = new URLSearchParams(query.replace(/^\?/, "")).getAll("service");
    if (service.length !== 1 || !GIT_SERVICES.has(service[0])) {
      return { ok: false, reason: "info/refs needs service=git-upload-pack or git-receive-pack" };
    }
    return { ok: true, kind: "info-refs", owner, repo };
  }
  if (method !== "POST") return { ok: false, reason: `${endpoint} takes POST, got ${method}` };
  return { ok: true, kind: endpoint === "git-upload-pack" ? "upload-pack" : "receive-pack", owner, repo };
}
