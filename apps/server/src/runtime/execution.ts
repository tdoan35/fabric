// The workspace execution switch (ANY-91 T19): one workspace-wide choice —
// `host` (T14's path, this machine), `docker` or `sprites` (T8/T9's sandboxes).
// The switch is read once at boot: on a sandboxed mode the session registry's
// five host tools are replaced by `sandboxTools(provider, mountsFor)` under
// the same names — registry rows, toolsets and policies unchanged, only the
// step moves to 2 — and a provider that reports unavailable refuses the boot
// instead of falling back to the host (D11). Docker mode also starts the
// credential broker (T5) on T18's `brokerBindHost()`, fail-closed with no
// rules, and hands every acquire an egress token (TTL: the idle window plus
// one minute) through the sandbox env. A reaper runs every minute; run
// folders sweep once at boot and then daily; `stop()` reaps everything.
import { readFileSync } from "node:fs";
import { chmod } from "node:fs/promises";
import path from "node:path";
import type { ToolDef } from "@fabric/tools";
import {
  createTokenStore,
  startBroker,
  type BrokerDeps,
  type BrokerServer,
  type TokenStore,
} from "@fabric/tools/broker";
import {
  ensureFoldersSchema,
  folderGrants,
  localFolders,
  sweepRuns,
  type FolderGrants,
  type FolderStore,
} from "@fabric/tools/folders";
import {
  dockerSandboxes,
  sandboxTools,
  type SandboxMount,
  type SandboxProvider,
} from "@fabric/tools/sandbox";
import { spriteSandboxes } from "@fabric/tools/sprites";
// T18's bind-host probe lives in the sandbox module behind a file (no
// index re-export); the server reaches it directly, packages/** untouched.
import { brokerBindHost } from "../../../../packages/tools/src/sandbox/network";
import type { RuntimeStore } from "@fabric/runtime";
import type { Vault } from "@fabric/tools/vault";

export type ExecutionMode = "host" | "docker" | "sprites";

/** The execution keys of the server env (a subset of `RuntimeEnv`). */
export type ExecutionEnv = {
  FABRIC_EXECUTION?: ExecutionMode;
  FABRIC_WORK_DIR?: string;
  FABRIC_BROKER_RULES?: string;
  FABRIC_SANDBOX_IDLE_MS?: number;
};

/** The running execution: the stores every mode shares, the sandboxed modes'
 * provider plumbing, and the lifecycle. */
export type Execution = {
  readonly mode: ExecutionMode;
  /** The folder store rooted at FABRIC_WORK_DIR (default .data/work). */
  readonly folders: FolderStore;
  /** The workspace's folder grants over `folder_grants`. */
  readonly grants: FolderGrants;
  /** The idle window the reaper and the token TTL derive from. */
  readonly idleMs: number;
  /** The broker's egress-token store; docker mode only. */
  readonly tokens?: TokenStore;
  /** The credential broker; docker mode only. */
  readonly broker?: BrokerServer;
  /** The step-2 tool set replacing the host tools; undefined on host. */
  readonly tools?: ToolDef[];
  /** The live sandboxes: the agent and how long it has been idle. */
  sandboxes(): Array<{ agentId: string; idleMs: number }>;
  /** Whether the mode's provider is usable; always true on host. */
  available(): Promise<boolean>;
  /** One reaper tick: the provider reaps idle sandboxes, the layer revokes
   * their egress tokens. The minute interval calls this; so can tests. */
  reap(): Promise<void>;
  /** Reset workspace (D2): stop the agent's sandbox, revoke its token, empty
   * `agents/<id>`. The provider port has no per-agent stop, so the stop rides
   * a zero-idle reap; the other agents' sandboxes are transparently recreated
   * on their next call. */
  resetAgent(agentId: string): Promise<void>;
  /** Stop the timers, the sandboxes and the broker. Idempotent. */
  stop(): Promise<void>;
};

export type StartExecutionOptions = {
  workspace: string;
  store: RuntimeStore;
  vault: Vault;
  env: ExecutionEnv;
  /** Test seam: the provider, instead of the mode's own. */
  provider?: SandboxProvider;
  /** Test seam: the broker bind host, instead of `brokerBindHost()`. */
  brokerHost?: string;
  /** Test seam: the clock for reaping and token TTL; default Date.now. */
  now?: () => number;
};

const REAPER_INTERVAL_MS = 60_000;
/** One minute of slack over the idle window, per the card. */
const TOKEN_TTL_SLACK_MS = 60_000;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

const parseMode = (raw: string | undefined): ExecutionMode => {
  if (raw === undefined) return "host";
  if (raw === "host" || raw === "docker" || raw === "sprites") return raw;
  throw new Error(`FABRIC_EXECUTION must be host | docker | sprites, got ${JSON.stringify(raw)}`);
};

/** The broker's rules from FABRIC_BROKER_RULES (a JSON file); with no file
 * every request is refused — fail-closed (D3). A malformed file refuses the
 * boot: a silent empty-rules broker would look like an outage. */
const loadRules = (file: string | undefined): BrokerDeps["rules"] => {
  if (file === undefined || file === "") return [];
  return JSON.parse(readFileSync(file, "utf8")) as BrokerDeps["rules"];
};

export async function startExecution(options: StartExecutionOptions): Promise<Execution> {
  const mode = parseMode(options.env.FABRIC_EXECUTION);
  const now = options.now ?? (() => Date.now());
  const idleMs = options.env.FABRIC_SANDBOX_IDLE_MS ?? 300_000;

  // T10's stores, every mode: the same root the host run dirs live under.
  const folders = localFolders(options.env.FABRIC_WORK_DIR ?? path.join(".data", "work"));
  const grants = folderGrants(options.store, options.workspace);
  await ensureFoldersSchema(options.store);

  // T10's retention: once now, then daily. A failure is logged, never fatal.
  const sweep = (): void => {
    void sweepRuns(folders).catch((error: unknown) =>
      console.log(`[execution] run-folder sweep failed (${error instanceof Error ? error.message : String(error)})`),
    );
  };
  sweep();
  const sweeper = setInterval(sweep, SWEEP_INTERVAL_MS);
  sweeper.unref?.();

  /** T10 grants -> T8 mounts: the agent folder at /workspace (write) first,
   * then each granted project at /projects/<name>, read-only for `read`. The
   * mkdir'd host dirs land umask-masked (022 -> 0755); the container's uid is
   * neither the owner nor in the group, so every mount dir carries the
   * other-write bit explicitly (the sandbox D-suite's chmod precedent) —
   * read mounts are :ro inside, so the extra bit costs nothing there. */
  const mountsFor = async (agentId: string): Promise<SandboxMount[]> =>
    Promise.all(
      (await grants.mountsFor(agentId)).map(async (mount) => {
        const hostPath = await folders.path(mount.ref);
        await chmod(hostPath, 0o777);
        return {
          hostPath,
          containerPath: mount.ref.kind === "agent" ? "/workspace" : `/projects/${mount.ref.name}`,
          readOnly: mount.access === "read",
        };
      }),
    );

  let inner: SandboxProvider | undefined;
  let tokens: TokenStore | undefined;
  let broker: BrokerServer | undefined;

  if (mode === "docker" || mode === "sprites") {
    if (mode === "docker") tokens = createTokenStore(now);
    const ensureAvailable = async (provider: SandboxProvider): Promise<void> => {
      const availability = await provider.available();
      if (!availability.ok) {
        // Refused, never a silent host fallback (D11): the reason is the boot's.
        throw new Error(`execution ${mode} unavailable: ${availability.reason}`);
      }
    };

    if (options.provider !== undefined) {
      // Injected provider (the tests'): gate the boot on it before anything
      // starts, so a refusal never leaves a broker behind.
      inner = options.provider;
      await ensureAvailable(inner);
    }
    if (mode === "docker") {
      // The broker first: the egress gateway's forwarder wants its port at
      // provider construction. The bind host is T18's; its probe failing is
      // a refusal, same as an unavailable daemon.
      const host = options.brokerHost ?? (await brokerBindHost());
      const tokenStore = tokens as TokenStore;
      broker = await startBroker({
        host,
        vault: options.vault,
        rules: loadRules(options.env.FABRIC_BROKER_RULES),
        tokens: tokenStore,
        onUse: (record) =>
          console.log(
            `[broker] ${record.agentId ?? "-"} ${record.method} ${record.host ?? "-"}${record.path} -> ${record.status}`,
          ),
      });
      if (inner === undefined) {
        inner = dockerSandboxes({ egress: { brokerPort: Number(new URL(broker.url).port) } });
        try {
          await ensureAvailable(inner);
        } catch (error: unknown) {
          await broker.close();
          throw error;
        }
      }
    } else if (inner === undefined) {
      inner = spriteSandboxes({ folders });
      await ensureAvailable(inner);
    }
  }

  // The layer around the provider: the egress token per (workspace, agent) on
  // first acquire — the env is baked at container creation, so the token is
  // issued once and reused — and the bookkeeping the reaper and /execution read.
  const live = new Map<string, { token?: string; at: number }>();
  const provider: SandboxProvider | undefined =
    inner === undefined
      ? undefined
      : {
          async acquire(request) {
            const held = live.get(request.agentId);
            const token =
              tokens !== undefined && held?.token === undefined
                ? tokens.issue({
                    workspaceId: request.workspaceId,
                    agentId: request.agentId,
                    ttlMs: idleMs + TOKEN_TTL_SLACK_MS,
                  })
                : held?.token;
            const sandbox = await inner!.acquire(
              token === undefined
                ? request
                : { ...request, env: { ...request.env, FABRIC_EGRESS_TOKEN: token } },
            );
            live.set(request.agentId, { token, at: now() });
            return sandbox;
          },

          async reap(opts) {
            await inner!.reap(opts);
            const idle = opts?.idleMs ?? idleMs;
            const cutoff = now() - idle;
            for (const [agent, entry] of [...live]) {
              if (entry.at <= cutoff) {
                if (tokens !== undefined && entry.token !== undefined) tokens.revoke(entry.token);
                live.delete(agent);
              }
            }
          },

          async stopAll() {
            if (tokens !== undefined) {
              for (const entry of live.values()) {
                if (entry.token !== undefined) tokens.revoke(entry.token);
              }
            }
            live.clear();
            await inner!.stopAll();
          },

          available: () => inner!.available(),
        };

  const reaper =
    provider === undefined
      ? undefined
      : setInterval(() => {
          void provider.reap().catch((error: unknown) =>
            console.log(`[execution] reap failed (${error instanceof Error ? error.message : String(error)})`),
          );
        }, REAPER_INTERVAL_MS);
  reaper?.unref?.();

  let stopped = false;
  const execution: Execution = {
    mode,
    folders,
    grants,
    idleMs,
    ...(tokens !== undefined ? { tokens } : {}),
    ...(broker !== undefined ? { broker } : {}),
    ...(provider !== undefined ? { tools: sandboxTools(provider, mountsFor) } : {}),

    sandboxes: () =>
      [...live.entries()].map(([agentId, entry]) => ({
        agentId,
        idleMs: Math.max(0, now() - entry.at),
      })),

    available: async () => (provider === undefined ? true : (await provider.available()).ok),

    reap: async () => {
      await provider?.reap();
    },

    resetAgent: async (agentId) => {
      const entry = live.get(agentId);
      if (entry !== undefined) {
        if (tokens !== undefined && entry.token !== undefined) tokens.revoke(entry.token);
        live.delete(agentId);
      }
      // The port's only lever is the idle window: zero it for the stop. The
      // other agents' containers are transparently reacquired on their next
      // call; their tokens stay valid (the layer's entries are untouched).
      await provider?.reap({ idleMs: 0 });
      await folders.remove({ kind: "agent", name: agentId });
    },

    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (reaper !== undefined) clearInterval(reaper);
      clearInterval(sweeper);
      await provider?.stopAll();
      await broker?.close();
    },
  };

  return execution;
}
