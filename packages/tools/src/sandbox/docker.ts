// The docker backend of the SandboxProvider (ANY-44 D9, T8): one container per
// (workspace, agent), driven entirely through the `docker` CLI — the same
// against Docker Desktop on Windows — with no new dependency. Containers run
// with no network (T18 owns policy), a non-root user (uid 1000, from the
// image), capped pids/memory/cpu and no capabilities; the agent folder is
// /workspace (rw) and each granted project /projects/<name> (read-only for
// `read` grants, per the mounts the caller passes). At startup the provider
// removes sandboxes left labelled `fabric.sandbox=1` by a dead run.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { LINE_CAP, TAIL_LINES } from "../host/shell";
import type {
  Sandbox,
  SandboxAcquireRequest,
  SandboxAvailability,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxProvider,
} from "./provider";
import { SANDBOX_IMAGE } from "./image";
import { SANDBOX_NETWORK, ensureSandboxNetwork } from "./network";
import { ensureEgressGateway, stopEgressGateway, type EgressGatewayOptions } from "./egress-gateway";

/** Where a live sandbox records its process-group id for the timeout kill. */
const PIDFILE_DIR = "/tmp/.fabric-exec";

/** The gateway's per-instance network alias: sandboxes proxy to their own
 * provider's gateway only. The shared `egress` alias round-robins across
 * every provider's gateway on the network, so a parallel suite's gateway
 * teardown resets a live tunnel mid-TLS (curl 56, CI run 38979873174 E8). */
export const egressAlias = (instance: string): string => `egress-${instance}`;

/** The proxy environment of T18: the open web only through this provider's
 * gateway, addressed by the per-instance alias. */
const egressProxyEnv = (instance: string): Record<string, string> => {
  const host = egressAlias(instance);
  return {
    HTTP_PROXY: `http://${host}:3128`,
    HTTPS_PROXY: `http://${host}:3128`,
    http_proxy: `http://${host}:3128`,
    https_proxy: `http://${host}:3128`,
    ALL_PROXY: `http://${host}:3128`,
    NO_PROXY: host,
    FABRIC_EGRESS_URL: `http://${host}`,
  };
};

/** Single-quotes for bash; the value is data, never re-read as syntax. */
const shquote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

export interface DockerSandboxOptions {
  /** The image to run; default SANDBOX_IMAGE (FABRIC_SANDBOX_IMAGE). */
  image?: string;
  /** Path to the docker CLI; default `docker` on PATH. */
  docker?: string;
  /** Egress gateway configuration (T18). The egress token itself is the
   * caller's env (FABRIC_EGRESS_TOKEN), never the provider's. */
  egress?: EgressGatewayOptions;
}

/** Emits one completed line: streamed live, kept in the bounded tail. */
const emitLine = (line: string, onLine: ((line: string) => void) | undefined, tail: string[]): void => {
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

/** Kills the whole docker CLI process group, releasing the exec streams. */
const killTree = (child: ChildProcess): void => {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // already gone
  }
};

class DockerSandbox implements Sandbox {
  readonly id: string;
  lastUsed = Date.now();

  readonly #docker: string;

  constructor(id: string, docker: string) {
    this.id = id;
    this.#docker = docker;
  }

  touch(): void {
    this.lastUsed = Date.now();
  }

  async exec(command: string, options: SandboxExecOptions = {}): Promise<SandboxExecResult> {
    this.touch();
    const execId = randomUUID();
    const pidfile = `${PIDFILE_DIR}/${execId}.pid`;
    // The inner bash is a session leader via setsid, so `kill -- -PID` takes
    // the whole process group inside the container, whatever the command
    // spawned. The command travels in an env var, never re-quoted.
    const outer =
      `mkdir -p ${PIDFILE_DIR}\n` +
      `setsid --wait bash -c 'echo "$$" > ${pidfile}; exec bash -lc "$FABRIC_CMD"'\n` +
      `RC=$?\nrm -f ${pidfile}\nexit $RC`;
    const argv = [this.#docker, "exec", "-i"];
    if (options.cwd !== undefined) argv.push("-w", options.cwd);
    argv.push("-e", `FABRIC_CMD=${command}`, this.id, "bash", "-c", outer);

    return await new Promise<SandboxExecResult>((resolve, reject) => {
      const tail: string[] = [];
      // detached: the negative-pid kill below takes the whole CLI tree.
      const child = spawn(argv[0], argv.slice(1), {
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });

      let timedOut = false;
      let settled = false;
      let failsafe: NodeJS.Timeout | undefined;
      let timeout: NodeJS.Timeout | undefined;
      /** Resolves when the container-side kill has run (or given up). */
      let killed = Promise.resolve();
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        if (timeout !== undefined) clearTimeout(timeout);
        if (failsafe !== undefined) clearTimeout(failsafe);
        fn();
      };

      const stdout = lineSink(options.onLine, tail);
      const stderr = lineSink(options.onLine, tail);
      child.stdout?.on("data", stdout);
      child.stderr?.on("data", stderr);
      child.stdout?.on("end", stdout.flush);
      child.stderr?.on("end", stderr.flush);

      if (options.stdin === undefined) {
        child.stdin?.end();
      } else if (typeof options.stdin === "string" || Buffer.isBuffer(options.stdin)) {
        child.stdin?.end(options.stdin);
      } else {
        options.stdin.pipe(child.stdin ?? process.stdout);
        options.stdin.on("error", () => child.stdin?.destroy());
      }

      const killGroup = (): void => {
        // Kill the process group inside the container; the CLI closes on its
        // own once the outer script reaps the killed session.
        const killer = spawn(
          this.#docker,
          [
            "exec",
            this.id,
            "bash",
            "-c",
            `for i in 1 2 3 4 5 6 7 8 9 10; do P=\$(cat ${pidfile} 2>/dev/null); [ -n "\$P" ] && kill -KILL -- "-\$P" && break; sleep 0.1; done; true`,
          ],
          { stdio: "ignore" }
        );
        killed = new Promise<void>((done) => {
          const fin = (): void => done();
          killer.on("exit", fin);
          killer.on("error", fin);
        });
      };

      if (options.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          timedOut = true;
          killGroup();
          // If the container-side kill could not close the streams (a wedged
          // daemon), take the CLI down; the result is already lost either way.
          failsafe = setTimeout(() => {
            if (!settled) killTree(child);
          }, 5_000);
        }, options.timeoutMs);
      }

      child.on("error", (error) => {
        settle(() => reject(error));
      });
      // close (not exit): the pipes have drained, so the tail is complete.
      child.on("close", (code) => {
        const finish = (): void => settle(() => resolve({ exitCode: code, timedOut, tail }));
        if (!timedOut) return finish();
        // A timed-out result implies the kill landed: an immediate follow-up
        // exec (or the no-survivor assertions) races a fire-and-forget killer
        // otherwise. Bounded — the failsafe below is the real wedged-daemon cap.
        const bail = setTimeout(finish, 1_500);
        void killed.then(() => {
          clearTimeout(bail);
          finish();
        });
      });
    });
  }

  async putArchive(dir: string, tar: Readable): Promise<void> {
    this.touch();
    const script = `mkdir -p -- ${shquote(dir)} && tar -xpf - -C ${shquote(dir)}`;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        this.#docker,
        ["exec", "-i", this.id, "bash", "-c", script],
        { stdio: ["pipe", "pipe", "pipe"] }
      );
      const chunks: Buffer[] = [];
      let failure = "";
      child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => (failure += chunk.toString("utf8")));
      tar.on("error", reject);
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`docker putArchive ${dir} failed: ${failure.trim()}`));
        }
      });
      tar.pipe(child.stdin ?? process.stdout);
    });
  }

  getArchive(dir: string): Readable {
    this.touch();
    const child = spawn(this.#docker, ["exec", this.id, "tar", "-cf", "-", "-C", dir, "."], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const { stdout } = child;
    child.on("error", (error) => {
      stdout.destroy(error);
    });
    // Surface a failed tar as a stream error, not silence.
    let failure = "";
    child.stderr?.on("data", (chunk: Buffer) => (failure += chunk.toString("utf8")));
    child.on("close", (code) => {
      if (code !== 0) {
        stdout.destroy(new Error(`docker getArchive ${dir} failed: ${failure.trim()}`));
      }
    });
    return stdout as Readable;
  }
}

export function dockerSandboxes(options: DockerSandboxOptions = {}): SandboxProvider {
  const docker = options.docker ?? "docker";
  const image = options.image ?? SANDBOX_IMAGE;
  const egressInstance = options.egress?.instance ?? randomUUID().slice(0, 12);
  /** (workspace, agent) → its sandbox. Never shared across agents. */
  const live = new Map<string, DockerSandbox>();
  /** Acquires racing for the same key share one container. */
  const pending = new Map<string, Promise<Sandbox>>();

  const run = (args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = spawn(docker, args, { stdio: ["ignore", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      let failure = "";
      child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => (failure += chunk.toString("utf8")));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve(Buffer.concat(chunks).toString("utf8"));
        } else {
          reject(new Error(`docker ${args.join(" ")} failed: ${failure.trim()}`));
        }
      });
    });

  /** Crash recovery: sandboxes labelled by an earlier run go first. Only
   * stopped ones are reaped: a running sandbox belongs to a live provider —
   * this process's or a concurrent worker's (CI runs the daemon suites side
   * by side) — and stopping it mid-test is the D8 `cannot exec in a stopped
   * state` bounce. Stopped containers cannot serve an exec; leftovers from a
   * dead run that exited are safe to take now. */
  const clearStale = async (): Promise<void> => {
    try {
      const out = await run([
        "ps", "-a", "--filter", "label=fabric.sandbox=1", "--format", "{{.ID}} {{.State}}",
      ]);
      const stale = out
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .filter((line) => line.split(/\s+/)[1] !== "running")
        .map((line) => line.split(/\s+/)[0]);
      // Plain `rm`, never `-f`: a container recorded `created` may be running
      // by the time this lands (the ps -> rm window), and a force-remove would
      // stop it mid-exec — the CI run 291 E4/D6 `docker exec` exit 1. A rm
      // refused for a now-running container is the race landing harmlessly; the
      // next provider construction reaps it if it exited since.
      if (stale.length > 0) await run(["rm", ...stale]);
    } catch {
      // A missing daemon or binary surfaces on available()/acquire().
    }
  };

  const ready = clearStale();

  const remove = async (id: string): Promise<void> => {
    await run(["rm", "-f", id]);
  };

  return {
    async acquire(request: SandboxAcquireRequest): Promise<Sandbox> {
      const key = `${request.workspaceId}/${request.agentId}`;
      const existing = live.get(key);
      if (existing !== undefined) {
        existing.touch();
        // The gateway can die while the sandbox lives (E8): every acquire,
        // cache hit included, replaces a dead gateway before returning.
        await ensureEgressGateway({ image, docker, ...options.egress, instance: options.egress?.instance ?? egressInstance }).catch(() => {});
        return existing;
      }
      const inflight = pending.get(key);
      if (inflight !== undefined) return inflight;

      const created = (async (): Promise<Sandbox> => {
        await ready;
        try {
          await run(["image", "inspect", image]);
        } catch {
          throw new Error(
            `sandbox image ${image} not found; build it with: npm run sandbox:build -w @fabric/tools`
          );
        }

        // T18: the internal network first, then the gateway (a dead one is
        // replaced here), then the sandbox on that network — the open web
        // only through egress:3128, the broker route on egress:80.
        await ensureSandboxNetwork(docker);
        await ensureEgressGateway({ image, docker, ...options.egress, instance: options.egress?.instance ?? egressInstance });

        const argv = [
          "run", "-d", "--init", "--network", SANDBOX_NETWORK,
          "--label", "fabric.sandbox=1",
          "--label", `fabric.agent=${request.agentId}`,
          "--label", `fabric.workspace=${request.workspaceId}`,
          "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
          "--pids-limit", "512", "--memory", "4g", "--cpus", "2",
        ];
        for (const [name, value] of Object.entries(egressProxyEnv(egressInstance))) {
          argv.push("-e", `${name}=${value}`);
        }
        for (const mount of request.mounts ?? []) {
          argv.push("-v", `${mount.hostPath}:${mount.containerPath}${mount.readOnly === true ? ":ro" : ""}`);
        }
        for (const [name, value] of Object.entries(request.env ?? {})) {
          argv.push("-e", `${name}=${value}`);
        }
        argv.push("-w", "/workspace", image, "sleep", "infinity");

        const id = (await run(argv)).trim();
        const sandbox = new DockerSandbox(id, docker);
        live.set(key, sandbox);
        return sandbox;
      })();
      pending.set(key, created);
      void created.catch(() => {}).then(() => pending.delete(key));
      return created;
    },

    async reap(options?: { idleMs?: number }): Promise<void> {
      await ready;
      const idleMs = options?.idleMs ?? 300_000;
      const cutoff = Date.now() - idleMs;
      await Promise.all(
        [...live.values()]
          .filter((sandbox) => sandbox.lastUsed < cutoff)
          .map(async (sandbox) => {
            await remove(sandbox.id).catch(() => {});
            for (const [key, held] of live) if (held === sandbox) live.delete(key);
          })
      );
    },

    async stopAll(): Promise<void> {
      await ready;
      const ids = [...live.values()].map((sandbox) => sandbox.id);
      live.clear();
      await Promise.all(ids.map((id) => remove(id).catch(() => {})));
      await stopEgressGateway(egressInstance, docker).catch(() => {});
    },

    async available(): Promise<SandboxAvailability> {
      try {
        await run(["info"]);
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
