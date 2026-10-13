// Credential rules (ANY-44 T5, D3): a rule fixes the upstream an egress
// endpoint may reach — the destination host is never the caller's choice —
// plus the credential to attach, the allowed methods, path globs (`**`
// crosses segments) and the agent scope. Paths are normalised before
// matching: `..` segments and encoded slashes are refused outright.
export type CredentialAuth =
  | { type: "bearer" }
  | { type: "header"; header: string }
  | { type: "basic"; user: string };

export type CredentialRule = {
  name: string;
  /** The fixed upstream origin; the broker forwards only here. */
  upstream: string;
  auth: CredentialAuth;
  /** The vault entry holding the secret. */
  secret: string;
  methods: string[];
  /** Path globs, `*` within a segment, `**` across segments. */
  paths: string[];
  agents: string[] | "all";
};

/** Decoded path for matching, or null when the raw path is not acceptable:
 * `%2F` smuggling, undecodable escapes, or `..` segments. */
export function normalizePath(rawPath: string): string | null {
  if (/%2f/i.test(rawPath)) return null;
  for (const segment of rawPath.split("/")) {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (decoded === "..") return null;
  }
  try {
    return decodeURIComponent(rawPath);
  } catch {
    return null;
  }
}

function pathGlobToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const withStars = escaped
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${withStars}$`);
}

/** True when the decoded path matches any of the rule's globs. */
export function pathAllowed(globs: readonly string[], decodedPath: string): boolean {
  return globs.some((glob) => pathGlobToRegExp(glob).test(decodedPath));
}
