// @fabric/tools/sandbox (ANY-44 T8): the SandboxProvider port, the docker
// backend and the step-2 sandboxed tools. Served through T1's subpath map;
// src/index.ts stays untouched, exactly like ../folders.
export type {
  Sandbox,
  SandboxAcquireRequest,
  SandboxAvailability,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxMount,
  SandboxProvider,
} from "./provider";
export { dockerSandboxes, type DockerSandboxOptions } from "./docker";
export { SANDBOX_IMAGE } from "./image";
export { sandboxTools, type SandboxMountsFor } from "./tools";
