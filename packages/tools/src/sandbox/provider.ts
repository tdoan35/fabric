// The SandboxProvider port (ANY-44 D1 step 2, T8): one live sandbox per
// (workspace, agent) — isolation is per agent, and a sandbox is never handed
// to another agent. The docker backend is ./docker; T9's Sprites backend
// implements this same port. Sandbox mounts are explicit host/container pairs
// so the agent folder (/workspace) and granted projects (/projects/<name>)
// stay a caller concern, not the provider's.
import type { Readable } from "node:stream";

/** One bind mount: host path into the sandbox, read-only optionally. */
export interface SandboxMount {
  hostPath: string;
  containerPath: string;
  readOnly?: boolean;
}

export interface SandboxExecOptions {
  /** Working directory inside the sandbox; the image default is /workspace. */
  cwd?: string;
  /** Kill the command's process group inside the sandbox after this long. */
  timeoutMs?: number;
  /** Streams stdout and stderr lines, in arrival order. */
  onLine?: (line: string) => void;
  /** Piped to the command's stdin, then closed. */
  stdin?: string | Buffer | Readable;
}

export interface SandboxExecResult {
  exitCode: number | null;
  timedOut: boolean;
  tail: string[];
}

/** A live sandbox for exactly one (workspace, agent) pair. */
export interface Sandbox {
  /** The backend's id (the docker container id for dockerSandboxes). */
  readonly id: string;

  /** Runs `command` under `bash -lc` inside the sandbox. A non-zero exit is a
   * normal result; on timeout the command's process group is killed inside. */
  exec(command: string, options?: SandboxExecOptions): Promise<SandboxExecResult>;

  /** Extracts a plain (uncompressed) tar of relative paths into `dir`. */
  putArchive(dir: string, tar: Readable): Promise<void>;

  /** A tar stream of `dir`'s contents (`./`-prefixed relative paths). */
  getArchive(dir: string): Readable;
}

export interface SandboxAcquireRequest {
  workspaceId: string;
  agentId: string;
  mounts?: SandboxMount[];
  /** Environment variables set in the sandbox at creation. */
  env?: Record<string, string>;
}

export type SandboxAvailability = { ok: true } | { ok: false; reason: string };

export interface SandboxProvider {
  /** The live sandbox for this (workspace, agent); a second call returns the
   * same one and refreshes its idle clock. */
  acquire(request: SandboxAcquireRequest): Promise<Sandbox>;

  /** Removes sandboxes idle longer than `idleMs` (default 5 minutes). */
  reap(options?: { idleMs?: number }): Promise<void>;

  /** Removes every sandbox this provider started. */
  stopAll(): Promise<void>;

  /** Whether the backend is usable; the reason names what is missing. */
  available(): Promise<SandboxAvailability>;
}
