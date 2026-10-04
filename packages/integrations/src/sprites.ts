// Sprites (S2): Jonah's and Sana's sandboxes, via the @fly/sprites SDK. The two Sprites are
// pre-created (8 CPU, 8 GiB, no GPU); attaching is just a client handle — the machine boots on
// the first exec, which is the cold start we measure. The egress policy (package index + model
// host only) is enforced by the Sprite itself, DNS-based, and applied here idempotently.
import { createInterface } from "node:readline";
import { SpritesClient } from "@fly/sprites";
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

const desiredPolicy = (): NetworkPolicy => ({
  rules: [...EGRESS_ALLOWLIST.map((domain) => ({ domain, action: "allow" as const }))],
});

/** Applies the allowlist unless it is already in force. Safe to call before every exec. */
export async function ensureEgressPolicy(sprite: Sprite): Promise<void> {
  const current = await sprite.getNetworkPolicy();
  const want = JSON.stringify(desiredPolicy().rules);
  const have = JSON.stringify([...current.rules].sort((a, b) => String(a.domain).localeCompare(String(b.domain))));
  if (want !== have) await sprite.updateNetworkPolicy(desiredPolicy());
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
  const pump = (stream: NodeJS.ReadableStream) => {
    const rl = createInterface({ input: stream });
    rl.on("line", (line) => {
      chunks.push(line);
      if (chunks.length > 200) chunks.splice(0, chunks.length - 200);
      void opts.onLine?.(line);
    });
  };
  await cmd.start();
  pump(cmd.stdout);
  pump(cmd.stderr);
  const exitCode = await cmd.wait();
  clearTimeout(timer);

  const output = chunks.join("\n");
  // A failed fetch to a host outside the allowlist is the sandbox doing its job: report it as a
  // denied network.fetch so the Tools tab shows the enforcement (S2's blocked-fetch check).
  const blockedHosts = killed || exitCode === 0 ? [] : [...new Set([...command.matchAll(URL_RE)].map((m) => m[1].split(":")[0]))]
    .filter((h) => !egressAllowed(h) && (!output || NET_FAIL.test(output)));
  return { exitCode: killed ? 124 : exitCode, tail: output.slice(-2000), blockedHosts };
}

// ---- file helpers for workspace.write (§5.3 TOOLS 3) ----

export async function writeSpriteFile(sprite: Sprite, path: string, content: string): Promise<void> {
  await sprite.filesystem(SPRITE_WORKDIR).writeFile(path, content);
}

export async function readSpriteFile(sprite: Sprite, path: string): Promise<string> {
  return sprite.filesystem(SPRITE_WORKDIR).readFile(path, "utf8");
}
