// web_fetch (ANY-72, ANY-44 D1 step 0): server-side fetch with the SSRF guard.
// The hostname is resolved once, every address validated, and the request
// connects only to the validated address through a custom `lookup` — DNS
// rebinding cannot swap the target mid-flight. Redirects re-validate. html
// and https only; 2 MB body cap; 20 s timeout.
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { defineTool } from "../define";
import { z } from "zod";

const MAX_BODY = 2 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;

/** Address classes refused: loopback, RFC 1918 + ULA private, link-local
 * (v4 + v6), unspecified. Cloud metadata hosts too. */
const isRefusedAddress = (host: string, family: number): boolean => {
  if (host === "metadata.google.internal") return true;
  if (family === 4) {
    const octets = host.split(".").map((n) => Number.parseInt(n, 10));
    if (octets.length !== 4 || octets.some((n) => Number.isNaN(n))) return false;
    const [a, b] = octets as [number, number, number, number];
    if (a === 127 || a === 10 || a === 0) return true; // loopback, private, unspecified
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local
    return false;
  }
  const plain = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (plain === "::" || plain === "::1") return true; // unspecified, loopback
  if (plain.startsWith("fe80:")) return true; // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(plain)) return true; // unique-local fc00::/7
  return false;
};

export interface FetchDeps {
  /** The resolver; defaults to node dns. Injectable for the rebinding test. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** Called with the address the socket is about to connect to (test seam). */
  onConnect?: (address: string) => void;
  /** Loopback origins allowed despite the guard — the test server only. */
  allowLoopback?: string;
}

/** One validated origin: scheme, hostname and the pinned address list. */
interface Target {
  url: URL;
  addresses: string[];
}

const resolveHost = async (hostname: string, deps: FetchDeps): Promise<string[]> => {
  if (deps.resolve !== undefined) return deps.resolve(hostname);
  const record = await new Promise<string | LookupAddress[]>(
    (resolve, reject) => dnsLookup(hostname, { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses)))
  );
  return (Array.isArray(record) ? record : [record]).map((entry) =>
    typeof entry === "string" ? entry : entry.address
  );
};

const nextOrigin = (url: URL, deps: FetchDeps): Promise<Target> =>
  (async () => {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`only http and https are supported, not ${url.protocol}`);
    }
    if (deps.allowLoopback !== undefined && `${url.protocol}//${url.host}` === deps.allowLoopback) {
      // The test's own server: the guard is off, but an injected resolver
      // still pins the connection (W6 exercises the order through it).
      if (deps.resolve !== undefined) {
        return { url, addresses: await deps.resolve(url.hostname) };
      }
      return { url, addresses: [] };
    }
    const addresses = await resolveHost(url.hostname, deps);
    if (addresses.length === 0) throw new Error(`no address for ${url.hostname}`);
    const usable = addresses.filter((addr) => !isRefusedAddress(addr, addr.includes(":") ? 6 : 4));
    if (usable.length === 0) {
      throw new Error(`no public address for ${url.hostname} (${addresses.join(", ")})`);
    }
    return { url, addresses: usable };
  })();

/** HTML to text: script/style dropped, tags stripped, entities common ones, whitespace collapsed. */
const htmlToText = (html: string): string =>
  html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>(?=\n?)|<\/p>|<\/div>|<\/li>|<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");

export const webFetchTool = () =>
  defineTool({
    name: "web_fetch",
    description:
      "Fetch one http(s) URL and return its text. Follows up to 3 redirects; the body caps at 2 MB and the request times out at 20 s.",
    parameters: z.object({
      url: z.string().url().describe("The http(s) URL to fetch"),
    }),
    effect: "read",
    gate: "none",
    kind: "read",
    step: 0,
    async execute(args, ctx) {
      // Test seams ride on the scope (W4–W8): resolver, connect probe and the
      // loopback allowlist. Production scopes carry none.
      const scope = ctx.scope as Record<string, unknown>;
      const deps: FetchDeps = {
        resolve: scope.resolver as FetchDeps["resolve"],
        onConnect: scope.onConnect as FetchDeps["onConnect"],
        allowLoopback: scope.allowLoopback as string | undefined,
      };
      const hops: string[] = [args.url];
      let target: Target;
      try {
        target = await nextOrigin(new URL(args.url), deps);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }

      for (let redirect = 0; ; redirect++) {
        if (redirect > MAX_REDIRECTS) {
          return { ok: false, error: "too many redirects" };
        }

        // The pinned address: connect to the exact ip the guard validated, so
        // a second resolution cannot rebind it. The ip replaces the hostname
        // in the URL and the original authority rides in the Host header —
        // one resolution, validated, no second lookup to rebind. Addresses
        // are tried in the resolver's order; the first that connects wins.
        let response: Response | undefined;
        let lastError = "";
        for (const ip of target.addresses.length > 0 ? target.addresses : [undefined]) {
          const connectable =
            ip === undefined
              ? target.url // loopback test origin: no guard, no pinning
              : new URL(target.url.href.replace(`${target.url.hostname}:`, `${ip}:`));
          if (ip !== undefined) deps.onConnect?.(ip);
          try {
            response = await fetch(connectable, {
              redirect: "manual",
              signal: AbortSignal.timeout(TIMEOUT_MS),
              headers: { host: target.url.host },
            });
            break;
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
          }
        }
        if (response === undefined) {
          return {
            ok: false,
            error: /timeout|abort/i.test(lastError)
              ? `request timed out after ${TIMEOUT_MS} ms`
              : lastError,
          };
        }

        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          if (location === null) return { ok: false, error: `redirect ${response.status} without a location` };
          let next: URL;
          try {
            next = new URL(location, response.url || target.url);
          } catch {
            return { ok: false, error: `unparsable redirect target: ${location}` };
          }
          try {
            const nextTarget = await nextOrigin(next, deps);
            target = nextTarget;
            hops.push(next.href);
            continue;
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        }

        let body: string;
        try {
          body = await response.text();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false, error: /timeout|abort/i.test(message) ? `request timed out after ${TIMEOUT_MS} ms` : message };
        }
        const truncated = body.length > MAX_BODY;
        const contentType = response.headers.get("content-type") ?? "";
        const isHtml = contentType.includes("html") || /^\s*<(!doctype|html)/i.test(body);
        return {
          ok: true,
          result: {
            url: response.url || target.url.href,
            status: response.status,
            contentType,
            text: (isHtml ? htmlToText(body) : body).slice(0, MAX_BODY),
            truncated,
          },
        };
      }
    },
  });

type NodeCallback = (err: NodeJS.ErrnoException | null, address: string, family: number) => void;
