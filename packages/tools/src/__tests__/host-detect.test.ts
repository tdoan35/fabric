// ANY-73 X1, X12 — detectShell is pure: platform, env and which are all
// injected, so Windows detection is tested on a POSIX CI box without
// spawning a shell. X12 checks the shell tool's description names the
// detected shell so the model writes the right syntax.
import { expect, test } from "vitest";
import { detectShell, hostTools } from "../host";

const posix = (
  env: Record<string, string | undefined>,
  which: (bin: string) => boolean = () => false
) => detectShell({ platform: "linux", env, which });

test("X1 detectShell table: SHELL basename, then bash on PATH, then sh; win32 prefers pwsh", () => {
  const zsh = posix({ SHELL: "/bin/zsh" });
  expect(zsh.name).toBe("zsh");
  expect(zsh.argv("echo hi")).toEqual(["zsh", "-c", "echo hi"]);

  const fish = posix({ SHELL: "/usr/bin/fish" });
  expect(fish.name).toBe("fish");
  expect(fish.argv("echo hi")).toEqual(["fish", "-c", "echo hi"]);

  const bash = posix({}, (bin) => bin === "bash");
  expect(bash.name).toBe("bash");

  // A SHELL outside the supported set falls through to the PATH lookup.
  const fallback = posix({ SHELL: "/bin/tcsh" }, (bin) => bin === "bash");
  expect(fallback.name).toBe("bash");

  const neither = posix({});
  expect(neither.name).toBe("sh");
  expect(neither.argv("echo hi")).toEqual(["sh", "-c", "echo hi"]);

  const pwsh = detectShell({ platform: "win32", env: {}, which: (bin) => bin === "pwsh" });
  expect(pwsh.name).toBe("pwsh");
  expect(pwsh.argv("Get-Date")).toEqual([
    "pwsh",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Get-Date",
  ]);

  const powershell = detectShell({ platform: "win32", env: {}, which: () => false });
  expect(powershell.name).toBe("powershell");
  expect(powershell.argv("Get-Date")).toEqual([
    "powershell",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Get-Date",
  ]);
});

test("X12 the shell tool's description names the detected shell (zsh vs bash via injected env)", () => {
  const zshShell = hostTools({
    platform: "linux",
    env: { SHELL: "/bin/zsh" },
    which: () => false,
  }).find((tool) => tool.name === "shell");
  expect(zshShell?.description).toContain("zsh");

  const bashShell = hostTools({
    platform: "linux",
    env: {},
    which: (bin) => bin === "bash",
  }).find((tool) => tool.name === "shell");
  expect(bashShell?.description).toContain("bash");
});
