// Sprites (S2): Jonah/Sana use the package/model DNS allowlist. Dana's dedicated
// browser Sprite permits public-web DNS; its setup service enforces public-only browser
// egress with a validating proxy and an unprivileged browser UID firewall.
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { ExecError, SpritesClient } from "@fly/sprites";
import type { Sprite } from "@fly/sprites";
import type { NetworkPolicy } from "@fly/sprites";
import { env } from "./env";

/** The egress allowlist (ARCH §9): Python package index + Hugging Face and its CDN. */
export const EGRESS_ALLOWLIST = [
  "pypi.org",
  "files.pythonhosted.org",
  "huggingface.co",
  "cdn-lfs.huggingface.co",
  "cdn-lfs-us-1.huggingface.co",
  "cas-bridge.xethub.hf.co",
] as const;

/** Where the experiment lives inside the sandbox; LAB (step 8) installs into it. */
export const SPRITE_WORKDIR = "/root";

/** Which sandbox an agent runs in; the sandbox id the inspector shows is the Sprite name. */
const spriteNameFor = (agentId: string): string | undefined => {
  if (agentId === "jonah") return env("SPRITE_CODER") ?? "fabric-coder";
  if (agentId === "sana") return env("SPRITE_VALIDATOR") ?? "fabric-validator";
  if (agentId === "dana") return env("SPRITE_ASSISTANT") ?? "fabric-assistant";
  return undefined;
};

export const sandboxIdFor = spriteNameFor;

let client: SpritesClient | undefined;

export function spritesClient(): SpritesClient {
  const token = env("SPRITES_TOKEN");
  if (!token) throw new Error("SPRITES_TOKEN is not set: the sandbox tools need it");
  client ??= new SpritesClient(token);
  return client;
}

export function spriteFor(agentId: string): Sprite | undefined {
  const name = spriteNameFor(agentId);
  return name ? spritesClient().sprite(name) : undefined;
}

/** True when the host is on the egress allowlist (exact, or a subdomain of an entry). */
export function egressAllowed(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return EGRESS_ALLOWLIST.some((d) => h === d || h.endsWith(`.${d}`));
}

const isDanaSprite = (sprite: Sprite): boolean => sprite.name === spriteNameFor("dana")
  && sprite.name !== spriteNameFor("jonah") && sprite.name !== spriteNameFor("sana");

const desiredPolicy = (sprite: Sprite): NetworkPolicy => ({
  // SDK policies match DNS names only, not destination CIDRs. This rule is not an
  // SSRF boundary: Dana's browser service supplies the actual IP-level restriction.
  rules: isDanaSprite(sprite)
    ? [{ domain: "*", action: "allow" }]
    : EGRESS_ALLOWLIST.map((domain) => ({ domain, action: "allow" as const })),
});

/** Applies the identity-specific DNS policy; unknown Sprites keep the restricted policy. */
export async function ensureEgressPolicy(sprite: Sprite): Promise<void> {
  const current = await sprite.getNetworkPolicy();
  const policy = desiredPolicy(sprite);
  const canonical = (rules: NetworkPolicy["rules"]) => JSON.stringify(
    [...rules].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
  if (canonical(policy.rules) !== canonical(current.rules)) await sprite.updateNetworkPolicy(policy);
}

/** Wake the already provisioned service, never install packages on the errand hot path. */
export async function ensureDanaBrowser(signal?: AbortSignal): Promise<Sprite> {
  const sprite = spriteFor("dana")!;
  if (!isDanaSprite(sprite)) throw new Error("SPRITE_ASSISTANT must be distinct from Jonah's and Sana's Sprite names");
  await ensureEgressPolicy(sprite);
  const health = async () => {
    try {
      await sprite.execFile("curl", [
        "-fsS", "--max-time", "2", "http://127.0.0.1:9223/health",
      ], { timeout: 5000, signal });
      return true;
    } catch (error) {
      if (!(error instanceof ExecError)) throw error;
      return false;
    }
  };
  if (await health()) return sprite;
  try {
    await sprite.getService("dana-browser");
    const stream = await sprite.startService("dana-browser", "1s");
    for await (const item of stream) {
      if (item.type === "error") throw new Error(item.data);
    }
  } catch (error) {
    throw new Error("Dana browser service unavailable; run bash scripts/setup-dana-sprite.sh", { cause: error });
  }
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (await health()) return sprite;
    await delay(500, undefined, { signal });
  }
  throw new Error("Dana headed browser did not become ready within 40 seconds");
}

export interface SpriteExecResult {
  exitCode: number;
  /** The last ~2 KB of combined output, for the model. */
  tail: string;
  /** Hosts the command tried to fetch that the sandbox refused (surfaced as tool.denied). */
  blockedHosts: string[];
}

/** Network-failure markers a blocked fetch leaves in curl/wget/python output. */
const NET_FAIL = /could not resolve|connection (?:refused|timed out|reset)|failed to connect|timed?\s?out|refused|no route to host|unable to connect|network is unreachable/i;
const URL_RE = /https?:\/\/([^/\s"'<>]+)/g;

export interface SpriteExecOptions {
  onLine?: (line: string) => void | Promise<void>;
  timeoutMs?: number;
}

/**
 * Runs one command in the Sprite, streaming stdout+stderr line-by-line (interleaved by arrival).
 * Non-zero exits are returned, not thrown — the model sees the exit code and the tail.
 */
export async function execInSprite(sprite: Sprite, command: string, opts: SpriteExecOptions = {}): Promise<SpriteExecResult> {
  await ensureEgressPolicy(sprite);
  const cmd = sprite.spawn("bash", ["-c", command], { cwd: SPRITE_WORKDIR });
  const chunks: string[] = [];
  let killed = false;
  const timer = opts.timeoutMs && opts.timeoutMs > 0 ? setTimeout(() => { killed = true; cmd.kill("SIGKILL"); }, opts.timeoutMs) : undefined;
  const lineJobs: Promise<void>[] = [];
  const drained: Promise<void>[] = [];
  const pump = (stream: NodeJS.ReadableStream) => {
    const rl = createInterface({ input: stream });
    drained.push(new Promise<void>((resolve) => rl.once("close", resolve)));
    rl.on("line", (line) => {
      chunks.push(line);
      if (chunks.length > 200) chunks.splice(0, chunks.length - 200);
      lineJobs.push(Promise.resolve(opts.onLine?.(line)).then(() => undefined));
    });
  };
  await new Promise<void>((resolve, reject) => {
    cmd.once("spawn", () => resolve());
    cmd.once("error", (err: Error) => reject(err));
  });
  pump(cmd.stdout);
  pump(cmd.stderr);
  const exitCode = await cmd.wait();
  clearTimeout(timer);
  await Promise.race([Promise.all([...drained, ...lineJobs]), new Promise((r) => setTimeout(r, 2000))]);

  const output = chunks.join("\n");
  // A failed fetch to a host outside the allowlist is the sandbox doing its job: report it as a
  // denied network.fetch so the Tools tab shows the enforcement (S2's blocked-fetch check).
  const blockedHosts = killed || isDanaSprite(sprite) ? [] : [...new Set([...command.matchAll(URL_RE)].map((m) => m[1].split(":")[0]))]
    .filter((h) => !egressAllowed(h) && NET_FAIL.test(output));
  return { exitCode: killed ? 124 : exitCode, tail: output.slice(-2000), blockedHosts };
}

// ---- file helpers for workspace.write (§5.3 TOOLS 3) ----

export async function writeSpriteFile(sprite: Sprite, path: string, content: string): Promise<void> {
  await sprite.filesystem(SPRITE_WORKDIR).writeFile(path, content);
}

export async function readSpriteFile(sprite: Sprite, path: string): Promise<string> {
  return sprite.filesystem(SPRITE_WORKDIR).readFile(path, "utf8");
}
