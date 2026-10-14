// shell (ANY-73, ANY-44 D11/D12): run a command directly on the host, as
// the user, unrestricted — safety comes from the approval gate, not from
// isolation. Streams stdout and stderr line by line in arrival order and
// returns the exit code plus a bounded tail; a non-zero exit is a normal
// result, not a tool error. On timeout the whole process tree dies:
// detached spawn + negative-pid kill on POSIX, taskkill /T /F on Windows.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { defineTool, type ToolScope } from "../define";
import type { DetectedShell } from "./detect";

/** The tail keeps the last N streamed lines … */
export const TAIL_LINES = 50;
/** … and each line is capped at N characters. */
export const LINE_CAP = 2_000;

export type ShellResult = {
  exitCode: number | null;
  timedOut: boolean;
  tail: string[];
};

/** cwd wins; a relative one resolves against the run directory (D11). */
const workDirFor = (cwd: string | undefined, scope: ToolScope): string => {
  const dir = cwd ?? scope.runDir;
  if (dir === undefined) {
    throw new Error("shell: no cwd given and the scope carries no runDir");
  }
  return isAbsolute(dir) ? dir : join(scope.runDir ?? ".", dir);
};

/** Emits one completed line: streamed live, kept in the bounded tail. */
const emitLine = (line: string, onLine: (line: string) => void, tail: string[]): void => {
  onLine(line);
  tail.push(line.length > LINE_CAP ? line.slice(0, LINE_CAP) : line);
  if (tail.length > TAIL_LINES) tail.shift();
};

/** A data listener that also flushes its trailing partial line. */
type LineSink = ((chunk: Buffer) => void) & { flush: () => void };

/** Splits a byte stream into lines, flushing partials at end-of-stream. */
const lineSink = (onLine: (line: string) => void, tail: string[]): LineSink => {
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

/** Kills the whole tree: the process group on POSIX, taskkill /T /F on win32. */
const killTree = (child: ChildProcess): void => {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // already gone — the close event resolves the run
  }
};

export const shellTool = ({ detect }: { detect: DetectedShell }) =>
  defineTool({
    name: "shell",
    description: `Run a command with ${detect.name} on this machine. Output streams live; the result carries the exit code, whether the run timed out, and the last lines. A non-zero exit is a normal result, not a failure.`,
    parameters: z.object({
      command: z.string().min(1).describe(`The ${detect.name} command line to run`),
      timeoutMs: z
        .number()
        .int()
        .min(1)
        .max(3_600_000)
        .default(120_000)
        .describe("Kill the whole process tree after this many milliseconds"),
      cwd: z
        .string()
        .min(1)
        .optional()
        .describe("Working directory; defaults to the run's directory"),
    }),
    effect: "rerunnable",
    gate: "mode",
    kind: "command",
    step: "host",
    async execute(args, ctx): Promise<ShellResult> {
      const workDir = workDirFor(args.cwd, ctx.scope);
      await mkdir(workDir, { recursive: true });

      const argv = detect.argv(args.command);
      return await new Promise<ShellResult>((resolve, reject) => {
        const tail: string[] = [];
        const child = spawn(argv[0], argv.slice(1), {
          cwd: workDir,
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
        });

        let timedOut = false;
        let settled = false;
        const stdout = lineSink(ctx.onLine, tail);
        const stderr = lineSink(ctx.onLine, tail);
        child.stdout?.on("data", stdout);
        child.stderr?.on("data", stderr);
        child.stdout?.on("end", stdout.flush);
        child.stderr?.on("end", stderr.flush);

        const timer = setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, args.timeoutMs);

        child.on("error", (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        });
        // close (not exit): the pipes have drained, so the tail is complete.
        child.on("close", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ exitCode: code, timedOut, tail });
        });
      });
    },
  });
