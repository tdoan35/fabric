// The Sprites backend of the SandboxProvider (ANY-44 D9, T9): one sprite per
// (workspace, agent) — a remote microVM billed per second, so reaping is
// aggressive and every removal follows a final write-back. The agent folder is
// /workspace and each granted project /projects/<name>; there are no bind
// mounts in the cloud, so folders move by tar: T10's `pack` streamed in
// through `tar -xzf -` on acquire, and after every mutating tool call
// (anything but the read shapes the T8 tools exec with) the write-granted
// folders stream back with `tar -czf -` into `unpack(..., { replace: true })`.
// The sprite's policy is the open web (a sprite has no LAN), and no broker
// route exists (D3 — a local server can't reach the broker from here), so
// FABRIC_EGRESS_* never reaches the sprite's env and credentialed calls are
// not available in this sandbox. The token comes from the vault entry
// `sprites` (passed as `token` by the caller) or the FABRIC_SECRET_SPRITES
// env fallback; the legacy SPRITES_TOKEN stays the legacy path's.
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { LINE_CAP, TAIL_LINES } from "../host/shell";
import type { FolderRef, FolderStore } from "../folders";
import type {
  Sandbox,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxProvider,
} from "../sandbox";
import { SpritesClient } from "@fly/sprites";

/** The Sprites name limit the provider cuts to (DNS-label style). */
export const SPRITE_NAME_MAX = 63;

/** Length of the `-hhhhhhhh` disambiguating suffix. Two names equal after
 * cutting hash apart, so distinct agents never share a sprite. */
const HASH_LEN = 8;

/** Write-back cap: folders over this are left in the sprite and the call's
 * result says so; SPRITE_SYNC_MAX_BYTES overrides, in bytes. */
export const SPRITE_SYNC_DEFAULT_BYTES = 512 * 1024 * 1024;

/** The open-web network policy set on creation: allow everything, no domain
 * list — the public web only, per D9; a sprite has no LAN. */
export const OPEN_WEB_POLICY = { rules: [{ action: "allow" }] } as const;

/** The Docker lane's egress-gateway env (T18): stripped from the sprite's
 * env, because Sprites has no broker route to point them at (D3). */
const EGRESS_ENV_KEYS = ["FABRIC_EGRESS_URL", "FABRIC_EGRESS_TOKEN"] as const;

/** The mount points this backend serves; anything else is not synced. */
const WORKSPACE_DIR = "/workspace";
const PROJECT_DIR = /^\/projects\/([a-z0-9-]+)$/;

const TOKEN_REASON =
  "sprites: no token — put it in the vault entry `sprites` or set FABRIC_SECRET_SPRITES";

/** An exec result that can also carry the write-back outcome. */
export interface SpriteExecResult extends SandboxExecResult {
  /** Why the post-call write-back did not run to completion. */
  sync?: string;
}

/** Structural slice of @fly/sprites the provider drives; the tests' fake
 * implements the same surface. */
export interface SpriteCommandLike extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  wait(): Promise<number>;
  kill(signal?: string): void;
}

export interface SpriteLike {
  readonly name: string;
  spawn(
    command: string,
    args?: string[],
    options?: { cwd?: string; env?: Record<string, string> }
  ): SpriteCommandLike;
  delete(): Promise<void>;
  updateNetworkPolicy(policy: unknown): Promise<void>;
}

export interface SpriteClientLike {
  getSprite(name: string): Promise<SpriteLike>;
  createSprite(name: string, options?: { environment?: Record<string, string> }): Promise<SpriteLike>;
  listSprites(): Promise<unknown>;
}

export interface SpriteSandboxOptions {
  /** The API token — the vault entry `sprites`, resolved by the caller. */
  token?: string;
  /** Folder store for sync-in packs and write-back replaces. */
  folders: FolderStore;
  /** Prebuilt client (the tests' fake); default is the real SDK client. */
  client?: SpriteClientLike;
  /** Sprite-name prefix; default `fabric`. */
  namePrefix?: string;
  /** Env for the token fallback and the sync cap; default process.env. */
  env?: Record<string, string | undefined>;
}

/** Single-quotes for the composite shell; the value is data, never re-read. */
const shquote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** `<prefix>-<workspace>-<agent>`, slug-formed; past the SDK's name limit the
 * head is cut and a short hash of the full parts is appended, so distinct
 * (workspace, agent) pairs never collapse into one sprite. */
export function spriteName(prefix: string, workspaceId: string, agentId: string): string {
  const slug = (value: string): string =>
    value.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "sprite";
  const raw = slug(`${prefix}-${workspaceId}-${agentId}`);
  if (raw.length <= SPRITE_NAME_MAX) return raw;
  const digest = createHash("sha256")
    .update(`${prefix}\u0000${workspaceId}\u0000${agentId}`)
    .digest("hex")
    .slice(0, HASH_LEN);
  return `${raw.slice(0, SPRITE_NAME_MAX - HASH_LEN - 1)}-${digest}`;
}

/** Emits one completed line: streamed live, kept in the bounded tail. */
const emitLine = (
  line: string,
  onLine: ((line: string) => void) | undefined,
  tail: string[]
): void => {
  onLine?.(line);
  tail.push(line.length > LINE_CAP ? line.slice(0, LINE_CAP) : line);
  if (tail.length > TAIL_LINES) tail.shift();
};

/** A data listener that also flushes its trailing partial line. */
type LineSink = ((chunk: Buffer) => void) & { flush: () => void };

const lineSink = (onLine: ((line: string) => void) | undefined, tail: string[]): LineSink => {
  let buffer = "";
  const sink = (chunk: Buffer): void => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      emitLine(buffer.slice(0, newline).replace(/\r$/, ""), onLine, tail);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  };
  sink.flush = (): void => {
    if (buffer !== "") {
      emitLine(buffer.replace(/\r$/, ""), onLine, tail);
      buffer = "";
    }
  };
  return sink;
};

interface RunOutcome {
  exitCode: number | null;
  timedOut: boolean;
  tail: string[];
}

/** Waits out a spawned command. */
const exitCodeOf = (command: SpriteCommandLike): Promise<number | null> =>
  command.wait().then((code) => (typeof code === "number" ? code : null));

/** Feeds `source` into the command's stdin and waits for the flush. */
const pipeStdin = (source: Readable, command: SpriteCommandLike): Promise<void> =>
  new Promise((resolve, reject) => {
    source.pipe(command.stdin).on("finish", () => resolve()).on("error", reject);
    command.on("error", reject);
  });

/** Runs `argv` on the sprite, streaming stdout/stderr lines and honouring the
 * timeout with a kill. A non-zero exit is a normal result. */
async function runOn(
  sprite: SpriteLike,
  argv: string[],
  options: {
    cwd?: string;
    stdin?: string | Buffer | Readable;
    onLine?: (line: string) => void;
    timeoutMs?: number;
  } = {}
): Promise<RunOutcome> {
  const command = sprite.spawn(argv[0], argv.slice(1), { cwd: options.cwd });
  const tail: string[] = [];
  const out = lineSink(options.onLine, tail);
  const err = lineSink(options.onLine, tail);
  command.stdout.on("data", out);
  command.stderr.on("data", err);
  command.stdout.on("end", () => out.flush());
  command.stderr.on("end", () => err.flush());

  if (options.stdin === undefined) {
    command.stdin.end();
  } else if (typeof options.stdin === "string" || Buffer.isBuffer(options.stdin)) {
    command.stdin.end(options.stdin);
  } else {
    options.stdin.on("error", () => command.stdin.destroy());
    void options.stdin.pipe(command.stdin);
  }

  return await new Promise<RunOutcome>((resolve, reject) => {
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let failsafe: NodeJS.Timeout | undefined;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (failsafe !== undefined) clearTimeout(failsafe);
      resolve({ exitCode, timedOut, tail });
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (failsafe !== undefined) clearTimeout(failsafe);
      reject(error);
    };
    command.on("error", (error: Error) => fail(error));
    command.stdout.on("error", () => finish(null));
    exitCodeOf(command).then(finish, () => finish(null));
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        command.kill();
        // The kill lands inside the sprite; if the exit never surfaces, say
        // so rather than hang — the result is lost either way.
        failsafe = setTimeout(() => finish(null), 5_000);
      }, options.timeoutMs);
    }
  });
}

/** The sprite-side size of a dir, files included; a failed probe is 0, which
 * only means the cap check passes. */
const spriteBytes = async (sprite: SpriteLike, dir: string): Promise<number> => {
  const outcome = await runOn(sprite, ["du", "-sb", "--", dir]);
  if (outcome.exitCode !== 0 || outcome.tail.length === 0) return 0;
  const bytes = Number.parseInt(outcome.tail[0], 10);
  return Number.isFinite(bytes) ? bytes : 0;
};

const syncCap = (env: Record<string, string | undefined>): number => {
  const raw = env.SPRITE_SYNC_MAX_BYTES;
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : SPRITE_SYNC_DEFAULT_BYTES;
};

/** The read shapes the T8 tools exec with — `read_file`'s base64 round-trip
 * and `search_files`' ripgrep. Every other exec is treated as mutating. */
const READ_COMMAND = /^\s*(?:base64|rg)\b/;

/** Where a mount lives in the sprite, and the folder ref it pack/unpacks
 * through: the agent folder at /workspace, granted projects under /projects.
 * The caller's mountsFor glue guarantees the pairing (the port's note). */
interface BackedMount {
  ref: FolderRef;
  /** The mount's path inside the sprite. */
  dir: string;
  /** Read-only mounts sync in but never write back. */
  readOnly: boolean;
}

const backedMounts = (request: {
  agentId: string;
  mounts?: Array<{ containerPath: string; readOnly?: boolean }>;
}): BackedMount[] => {
  const backed: BackedMount[] = [];
  for (const mount of request.mounts ?? []) {
    if (mount.containerPath === WORKSPACE_DIR) {
      backed.push({
        ref: { kind: "agent", name: request.agentId },
        dir: WORKSPACE_DIR,
        readOnly: mount.readOnly === true,
      });
      continue;
    }
    const project = PROJECT_DIR.exec(mount.containerPath);
    if (project !== null) {
      backed.push({
        ref: { kind: "project", name: project[1] },
        dir: mount.containerPath,
        readOnly: mount.readOnly === true,
      });
    }
    // Other container paths have no folder behind them to sync; skipped.
  }
  return backed;
};

class SpriteSandbox implements Sandbox {
  readonly id: string;
  /** Idle clock, refreshed on every use; per-second billing reaps hard. */
  lastUsed = Date.now();

  readonly #sprite: SpriteLike;
  readonly #folders: FolderStore;
  /** Every synced mount, for the final write-back on reap/stopAll. */
  readonly #backed: BackedMount[];
  readonly #env: Record<string, string | undefined>;
  #gone = false;

  constructor(
    name: string,
    sprite: SpriteLike,
    folders: FolderStore,
    backed: BackedMount[],
    env: Record<string, string | undefined>
  ) {
    this.id = name;
    this.#sprite = sprite;
    this.#folders = folders;
    this.#backed = backed;
    this.#env = env;
  }

  touch(): void {
    this.lastUsed = Date.now();
  }

  async exec(command: string, options: SandboxExecOptions = {}): Promise<SpriteExecResult> {
    this.touch();
    const outcome = await runOn(this.#sprite, ["bash", "-lc", command], {
      cwd: options.cwd,
      stdin: options.stdin,
      onLine: options.onLine,
      timeoutMs: options.timeoutMs,
    });
    // Write-back after every mutating call (D1: the working folder goes back
    // to storage). A failure or an over-cap folder must not fail the call
    // that just succeeded; the result says `sync` when the cap skipped it.
    let sync: string | undefined;
    if (!READ_COMMAND.test(command)) sync = await this.writeBack().catch(() => undefined);
    return sync === undefined ? { ...outcome } : { ...outcome, sync };
  }

  /** Streams every write-granted folder back into its folder ref. */
  async writeBack(): Promise<string | undefined> {
    if (this.#gone) return undefined;
    const cap = syncCap(this.#env);
    const writable = this.#backed.filter((mount) => !mount.readOnly);
    if (writable.length === 0) return undefined;
    for (const mount of writable) {
      if ((await spriteBytes(this.#sprite, mount.dir)) > cap) return "skipped: too large";
    }
    for (const mount of writable) {
      // An empty sprite dir must empty the host folder, but folders.unpack
      // creates its staging dir from the entries — an empty archive would
      // rename nothing. Probe first and mirror emptiness with remove+path.
      const probe = await runOn(this.#sprite, [
        "bash",
        "-lc",
        `cd ${shquote(mount.dir)} || exit 3; if [ -z "$(find . -mindepth 1 -print -quit)" ]; then exit 0; fi; exit 1`,
      ]);
      if (probe.exitCode === 0) {
        await this.#folders.remove(mount.ref);
        await this.#folders.path(mount.ref);
        continue;
      }
      // Pack-style entries only: folders.unpack refuses tar's `.` root entry,
      // so the name list comes from find's %P (relative, NUL-separated) and
      // tar adds nothing recursively. pipefail keeps find's failure visible.
      const command = this.#sprite.spawn(
        "bash",
        [
          "-lc",
          `set -o pipefail; cd ${shquote(mount.dir)} && find . -mindepth 1 -printf '%P\\0' | tar --null --no-recursion -T - -czf -`,
        ],
        {}
      );
      command.stdout.on("error", () => command.stdout.destroy());
      const exited = exitCodeOf(command);
      await this.#folders.unpack(mount.ref, command.stdout, { replace: true });
      const code = await exited;
      if (code !== 0) {
        throw new Error(`sprites: write-back tar failed for ${mount.dir} (exit ${code})`);
      }
    }
    return undefined;
  }

  /** Sync-in: T10's pack of every mounted folder, untarred into place. */
  async syncIn(mounts: BackedMount[]): Promise<void> {
    for (const mount of mounts) {
      const made = await runOn(this.#sprite, ["mkdir", "-p", mount.dir]);
      if (made.exitCode !== 0) {
        throw new Error(`sprites: mkdir ${mount.dir} failed: ${made.tail.join(" ").trim()}`);
      }
      const command = this.#sprite.spawn("tar", ["-xzf", "-", "-C", mount.dir]);
      command.stdout.on("error", () => command.stdout.destroy());
      const exited = exitCodeOf(command);
      await pipeStdin(this.#folders.pack(mount.ref), command);
      const code = await exited;
      if (code !== 0) {
        throw new Error(`sprites: sync-in tar failed for ${mount.dir} (exit ${code})`);
      }
    }
  }

  /** Extracts a plain tar of relative paths into `dir`. */
  async putArchive(dir: string, tar: Readable): Promise<void> {
    this.touch();
    const command = this.#sprite.spawn("tar", ["-xpf", "-", "-C", dir]);
    command.stdout.on("error", () => command.stdout.destroy());
    const exited = exitCodeOf(command);
    await pipeStdin(tar, command);
    const code = await exited;
    if (code !== 0) throw new Error(`sprites: putArchive ${dir} failed (exit ${code})`);
  }

  /** A tar stream of `dir`'s contents (`./`-prefixed relative paths). */
  getArchive(dir: string): Readable {
    this.touch();
    const command = this.#sprite.spawn("tar", ["-cf", "-", "-C", dir, "."]);
    const { stdout } = command;
    command.on("error", (error: Error) => stdout.destroy(error));
    void exitCodeOf(command).then((code) => {
      if (code !== 0) stdout.destroy(new Error(`sprites: getArchive ${dir} failed (exit ${code})`));
    });
    return stdout;
  }

  /** The final write-back, then deletion — reap and stopAll both end here. */
  async finalize(): Promise<void> {
    if (this.#gone) return;
    // Final write-back first: gone flags the post-delete no-op paths.
    await this.writeBack().catch(() => {});
    this.#gone = true;
    await this.#sprite.delete().catch(() => {});
  }
}

/** The env passed to the created sprite: the caller's, minus the Docker
 * lane's egress keys — Sprites has no broker route (D3). */
const spriteEnv = (env: Record<string, string> | undefined): Record<string, string> => {
  const environment = { ...(env ?? {}) };
  for (const key of EGRESS_ENV_KEYS) delete environment[key];
  return environment;
};

export function spriteSandboxes(options: SpriteSandboxOptions): SandboxProvider {
  const namePrefix = options.namePrefix ?? "fabric";
  const env = options.env ?? process.env;
  const live = new Map<string, SpriteSandbox>();
  const pending = new Map<string, Promise<Sandbox>>();
  let api: SpriteClientLike | undefined;

  const token = (): string | undefined => options.token ?? env.FABRIC_SECRET_SPRITES;

  const client = (bearer: string): SpriteClientLike => {
    if (options.client !== undefined) return options.client;
    if (api === undefined) api = new SpritesClient(bearer);
    return api;
  };

  return {
    async acquire(request): Promise<Sandbox> {
      const bearer = token();
      if (bearer === undefined) throw new Error(TOKEN_REASON);
      const key = `${request.workspaceId}/${request.agentId}`;
      const existing = live.get(key);
      if (existing !== undefined) {
        existing.touch();
        return existing;
      }
      const inflight = pending.get(key);
      if (inflight !== undefined) return inflight;

      const created = (async (): Promise<SpriteSandbox> => {
        const name = spriteName(namePrefix, request.workspaceId, request.agentId);
        const apiClient = client(bearer);
        let sprite: SpriteLike;
        try {
          sprite = await apiClient.getSprite(name);
        } catch {
          sprite = await apiClient.createSprite(name, { environment: spriteEnv(request.env) });
          await sprite.updateNetworkPolicy(OPEN_WEB_POLICY);
        }
        const backed = backedMounts(request);
        const sandbox = new SpriteSandbox(name, sprite, options.folders, backed, env);
        await sandbox.syncIn(backed);
        return sandbox;
      })();
      pending.set(key, created);
      void created
        .then((sandbox) => live.set(key, sandbox))
        .catch(() => {})
        .finally(() => pending.delete(key));
      return created;
    },

    async reap(options?: { idleMs?: number }): Promise<void> {
      const idleMs = options?.idleMs ?? 300_000;
      const cutoff = Date.now() - idleMs;
      for (const [key, sandbox] of [...live]) {
        if (sandbox.lastUsed < cutoff) {
          live.delete(key);
          await sandbox.finalize();
        }
      }
    },

    async stopAll(): Promise<void> {
      const all = [...live.values()];
      live.clear();
      await Promise.all(all.map((sandbox) => sandbox.finalize()));
    },

    async available(): Promise<{ ok: true } | { ok: false; reason: string }> {
      const bearer = token();
      if (bearer === undefined) return { ok: false, reason: TOKEN_REASON };
      try {
        await client(bearer).listSprites();
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
