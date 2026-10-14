// web_fetch (ANY-72, ANY-44 D1 step 0): server-side fetch with the SSRF guard.
// Each hop's hostname is resolved once, the addresses validated, and the
// socket connects to the validated address through a custom `lookup` — DNS
// rebinding cannot swap the target, and the URL keeps its hostname, so SNI,
// certificate checks and the Host header stay the original's. Redirects
// re-validate. http and https only; 2 MB body cap; 20 s timeout.
//
// Failures throw: the registry turns a throw into `{ ok: false, error }`.
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { z } from "zod";
import { defineTool } from "../define";

const MAX_BODY = 2 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Hostnames refused before any resolution. */
const REFUSED_HOSTS = new Set(["metadata.google.internal"]);

const parseV4 = (address: string): number[] | null => {
  const octets = address.split(".").map((n) => Number(n));
  return octets.length === 4 && octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? octets
    : null;
};

/** Loopback, unspecified (0/8), private (RFC 1918), CGNAT, link-local. */
const isRefusedV4 = ([a, b]: number[]): boolean =>
  a === 0 ||
  a === 10 ||
  a === 127 ||
  (a === 100 && (b! & 0xc0) === 64) ||
  (a === 169 && b === 254) ||
  (a === 172 && (b! & 0xf0) === 16) ||
  (a === 192 && b === 168);

/** An IPv6 address as its eight 16-bit groups; null when malformed. */
const parseV6 = (address: string): number[] | null => {
  let text = (address.split("%")[0] ?? "").toLowerCase();
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted !== null) {
    const v4 = parseV4(dotted[2]!);
    if (v4 === null) return null;
    text = `${dotted[1]}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string) => (part === "" ? [] : part.split(":").map((g) => Number.parseInt(g, 16)));
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 0) return null;
  const all = [...head, ...new Array<number>(fill).fill(0), ...tail];
  return all.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? all : null;
};

/** The IPv4 address an IPv6 one embeds — mapped (::ffff:0:0/96), compatible
 * (::/96, which also covers :: and ::1) or NAT64 (64:ff9b::/96) — else null. */
const embeddedV4 = (g: number[]): number[] | null => {
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  const mapped = zeros(0, 5) && g[5] === 0xffff;
  const compatible = zeros(0, 6);
  const nat64 = g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6);
  return mapped || compatible || nat64 ? [g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff] : null;
};

/** True for every address the guard refuses; anything that is not a
 * well-formed IP is refused too. */
export const isRefusedAddress = (address: string): boolean => {
  const family = isIP(address);
  if (family === 4) {
    const v4 = parseV4(address);
    return v4 === null || isRefusedV4(v4);
  }
  if (family !== 6) return true;
  const g = parseV6(address);
  if (g === null) return true;
  const v4 = embeddedV4(g);
  if (v4 !== null) return isRefusedV4(v4);
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7
  return false;
};

export interface FetchDeps {
  /** The resolver; defaults to node dns. Injectable for the rebinding test. */
  resolve?: (hostname: string) => string[] | Promise<string[]>;
  /** Called with the remote address of each socket once it connects (test seam). */
  onConnect?: (address: string) => void;
  /** One origin admitted despite the guard — the test server only. */
  allowLoopback?: string;
}

const systemResolve = async (hostname: string): Promise<string[]> =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

/** Validates one hop and returns the address its socket is pinned to. */
const pinnedAddress = async (url: URL, deps: FetchDeps): Promise<string> => {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`only http and https are supported, not ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (REFUSED_HOSTS.has(host)) throw new Error(`refused: ${host} is a metadata host`);

  const addresses = isIP(host) !== 0 ? [host] : await (deps.resolve ?? systemResolve)(host);
  if (addresses.length === 0) throw new Error(`no address for ${host}`);
  const admitted = deps.allowLoopback !== undefined && `${url.protocol}//${url.host}` === deps.allowLoopback;
  const usable = admitted ? addresses : addresses.filter((address) => !isRefusedAddress(address));
  if (usable.length === 0) {
    throw new Error(`refused: ${host} has no public address (${addresses.join(", ")})`);
  }
  return usable[0]!;
};

type Hop =
  | { kind: "redirect"; status: number; location: string | undefined }
  | { kind: "body"; status: number; contentType: string; body: Buffer; truncated: boolean };

/** One GET whose socket can only reach `address`: the lookup answers every
 * query with it, so nothing resolves the hostname a second time. */
const get = (url: URL, address: string, deps: FetchDeps, signal: AbortSignal): Promise<Hop> =>
  new Promise<Hop>((resolve, reject) => {
    const family = isIP(address);
    const lookup = ((_hostname, options, callback) => {
      if ((options as { all?: boolean }).all === true) {
        (callback as (err: null, addresses: { address: string; family: number }[]) => void)(null, [
          { address, family },
        ]);
      } else {
        callback(null, address, family);
      }
    }) as LookupFunction;

    let settled = false;
    const settle = (hop: Hop | Error) => {
      if (settled) return;
      settled = true;
      if (hop instanceof Error) reject(hop);
      else resolve(hop);
    };

    const req = (url.protocol === "https:" ? https : http).request(url, {
      method: "GET",
      agent: false,
      lookup,
      signal,
      headers: { accept: "text/html, text/plain;q=0.9, */*;q=0.5", "accept-encoding": "identity" },
    });
    req.on("socket", (socket) => {
      socket.once("connect", () => deps.onConnect?.(socket.remoteAddress ?? ""));
    });
    req.on("error", (error) => settle(error));
    req.on("response", (res) => {
      const status = res.statusCode ?? 0;
      if (REDIRECT_STATUSES.has(status)) {
        settle({ kind: "redirect", status, location: res.headers.location });
        req.destroy();
        return;
      }
      // The cap is enforced while reading: past 2 MB the socket is dropped.
      const chunks: Buffer[] = [];
      let size = 0;
      const done = (truncated: boolean) =>
        settle({
          kind: "body",
          status,
          contentType: res.headers["content-type"] ?? "",
          body: Buffer.concat(chunks),
          truncated,
        });
      res.on("data", (chunk: Buffer) => {
        const room = MAX_BODY - size;
        if (chunk.length > room) {
          chunks.push(chunk.subarray(0, room));
          size = MAX_BODY;
          done(true);
          req.destroy();
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
      });
      res.on("end", () => done(false));
      res.on("error", (error) => settle(error));
    });
    req.end();
  });

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
      // One deadline for the whole fetch, redirects included. Armed before
      // the first await, so fake timers drive it (W8).
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), TIMEOUT_MS);
      // Test seams ride on the scope (W4–W8): resolver, connect probe and the
      // loopback allowlist. Production scopes carry none.
      const scope = ctx.scope as Record<string, unknown>;
      const deps: FetchDeps = {
        resolve: scope.resolver as FetchDeps["resolve"],
        onConnect: scope.onConnect as FetchDeps["onConnect"],
        allowLoopback: scope.allowLoopback as string | undefined,
      };
      try {
        let url = new URL(args.url);
        for (let redirects = 0; ; redirects++) {
          const address = await pinnedAddress(url, deps);
          if (deadline.signal.aborted) throw new Error("aborted");
          const hop = await get(url, address, deps, deadline.signal);
          if (hop.kind === "body") {
            const raw = hop.body.toString("utf8");
            const isHtml = hop.contentType.includes("html") || /^\s*<(!doctype|html)/i.test(raw);
            return {
              url: url.href,
              status: hop.status,
              contentType: hop.contentType,
              text: isHtml ? htmlToText(raw) : raw,
              truncated: hop.truncated,
            };
          }
          if (redirects >= MAX_REDIRECTS) throw new Error("too many redirects");
          if (hop.location === undefined) throw new Error(`redirect ${hop.status} without a location`);
          try {
            url = new URL(hop.location, url);
          } catch {
            throw new Error(`unparsable redirect target: ${hop.location}`);
          }
        }
      } catch (error) {
        if (deadline.signal.aborted) throw new Error(`request timed out after ${TIMEOUT_MS} ms`);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  });
