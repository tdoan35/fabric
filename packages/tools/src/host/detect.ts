// detectShell (ANY-73, ANY-44 D11): pure shell detection. Every input is
// injected — platform, env and a `which` predicate — so Windows detection
// is testable on a POSIX box and tests never depend on the host's shells.
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { basename, delimiter as pathDelimiter } from "node:path";

/** Executable lookup, injectable: `true` when `bin` runs from PATH. */
export type WhichFn = (bin: string) => boolean;

export type ShellEnv = Record<string, string | undefined>;

/** The detected shell: its name, and the argv that runs a command in it. */
export type DetectedShell = {
  readonly name: string;
  readonly argv: (command: string) => string[];
};

/** The POSIX shells whose syntax differs enough to name in the description. */
const POSIX_SHELLS: readonly string[] = ["bash", "zsh", "fish"];

export function detectShell(input: {
  platform: string;
  env: ShellEnv;
  which: WhichFn;
}): DetectedShell {
  const { platform, env, which } = input;

  if (platform === "win32") {
    const name = which("pwsh") ? "pwsh" : "powershell";
    return {
      name,
      argv: (command) => [name, "-NoProfile", "-NonInteractive", "-Command", command],
    };
  }

  const fromEnv = env.SHELL === undefined ? undefined : basename(env.SHELL);
  const name =
    fromEnv !== undefined && POSIX_SHELLS.includes(fromEnv)
      ? fromEnv
      : which("bash")
        ? "bash"
        : "sh";
  return { name, argv: (command) => [name, "-c", command] };
}

/** The real `which` hostTools defaults to: an X_OK probe down PATH. Windows
 * gets the PATHEXT extensions Node's spawn does not infer for bare names. */
export const whichOnPath = (bin: string): boolean => {
  const extensions =
    process.platform === "win32" ? ["", ".exe", ".cmd", ".bat", ".com"] : [""];
  for (const dir of (process.env.PATH ?? "").split(pathDelimiter)) {
    if (dir === "") continue;
    for (const extension of extensions) {
      try {
        accessSync(join(dir, bin + extension), constants.X_OK);
        return true;
      } catch {
        // keep probing
      }
    }
  }
  return false;
};
