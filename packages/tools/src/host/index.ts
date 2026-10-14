// @fabric/tools/host (ANY-73, ANY-44 D11/D12): the host execution tools —
// shell with detected bash/zsh/fish/PowerShell, and the file tools. On a
// server you run they execute directly on the host, as the user,
// unrestricted: safety comes from the approval mode and gates (T3), not
// from isolation. T14 wires the set into tool.exec.
//
// Injection mirrors the builtin set: platform/env/which default to the
// real process values, so tests (and only tests) can fake a machine.
import type { ToolDef } from "../define";
import { detectShell, whichOnPath } from "./detect";
import type { DetectedShell, ShellEnv, WhichFn } from "./detect";
import { shellTool } from "./shell";
import { editFileTool, readFileTool, writeFileTool } from "./files";
import { searchFilesTool } from "./search";

export { detectShell, whichOnPath } from "./detect";
export type { DetectedShell, ShellEnv, WhichFn } from "./detect";
export { LINE_CAP, TAIL_LINES } from "./shell";
export { READ_CAP } from "./files";
export { globMatcher, MATCH_CAP, parseRgJson } from "./search";
export type { SearchMatch } from "./search";

/** What hostTools may override; every field defaults to the real machine. */
export interface HostOptions {
  platform?: string;
  env?: ShellEnv;
  which?: WhichFn;
}

/** The host tool set, in registry order. */
export function hostTools(options: HostOptions = {}): ToolDef[] {
  const detect: DetectedShell = detectShell({
    platform: options.platform ?? process.platform,
    env: options.env ?? process.env,
    which: options.which ?? whichOnPath,
  });
  return [
    shellTool({ detect }),
    readFileTool(),
    writeFileTool(),
    editFileTool(),
    searchFilesTool({ which: options.which ?? whichOnPath }),
  ];
}
