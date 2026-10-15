// The sandboxed tools (ANY-44 D1 step 2, T8): the host tools' names, schemas,
// caps, effects, gates and kinds, but running inside the agent's sandbox at
// step 2. Every call acquires the agent's sandbox through `mountsFor`; the
// file tools run inside the container through `exec` with stdin/stdout — never
// through host paths, so a symlink inside the sandbox cannot reach the host.
import { isAbsolute } from "node:path";
import { posix } from "node:path";
import { z } from "zod";
import { defineTool, type ToolDef, type ToolScope } from "../define";
import { READ_CAP } from "../host/files";
import { MATCH_CAP, parseRgJson } from "../host/search";
import type { Sandbox, SandboxMount, SandboxProvider } from "./provider";

/** The agent folder's mount point inside the sandbox; relative paths land here. */
const WORKSPACE_ROOT = "/workspace";

/** Single-quotes for the inner bash; the value is data, never re-read as syntax. */
const shquote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** Relative paths resolve against /workspace; absolute paths pass through. */
export const resolveInSandbox = (raw: string): string =>
  isAbsolute(raw) ? raw : posix.join(WORKSPACE_ROOT, raw);

/** The read-only mount covering `path`, deepest first; the file tools refuse
 * writes there with the read-only error before touching the container. */
const coveringMount = (path: string, mounts: SandboxMount[]): SandboxMount | undefined =>
  mounts
    .filter((mount) => path === mount.containerPath || path.startsWith(`${mount.containerPath}/`))
    .sort((a, b) => b.containerPath.length - a.containerPath.length)[0];

const assertWritable = (path: string, mounts: SandboxMount[], tool: string): void => {
  const mount = coveringMount(path, mounts);
  if (mount?.readOnly === true) {
    throw new Error(`${tool}: ${path} is on a read-only mount`);
  }
};

export type SandboxMountsFor = (agentId: string) => Promise<SandboxMount[]>;

/** Reads a file from inside the sandbox, byte-exact, through exec stdout. */
const readViaExec = async (sandbox: Sandbox, path: string): Promise<Buffer> => {
  const chunks: string[] = [];
  const result = await sandbox.exec(`base64 -w0 -- ${shquote(path)}`, {
    onLine: (line) => chunks.push(line),
  });
  if (result.exitCode !== 0) {
    throw new Error(`read_file: cannot read ${path}: ${result.tail.join(" ").trim()}`);
  }
  return Buffer.from(chunks.join(""), "base64");
};

const writeViaExec = async (sandbox: Sandbox, path: string, content: string): Promise<void> => {
  await sandbox.exec(`mkdir -p -- ${shquote(posix.dirname(path))} && cat > ${shquote(path)}`, {
    stdin: content,
  });
};

/** The sandboxed tools. `mountsFor` resolves the agent's mounts; the same
 * shapes as the host tools in ../host, at execution step 2. */
export const sandboxTools = (
  provider: SandboxProvider,
  mountsFor: SandboxMountsFor
): ToolDef[] => {
  const sandboxFor = async (
    scope: ToolScope
  ): Promise<{ sandbox: Sandbox; mounts: SandboxMount[] }> => {
    const mounts = await mountsFor(scope.agentId);
    const sandbox = await provider.acquire({
      workspaceId: scope.workspaceId,
      agentId: scope.agentId,
      mounts,
    });
    return { sandbox, mounts };
  };

  const shellTool = () =>
    defineTool({
      name: "shell",
      description:
        "Run a command with bash in this agent's sandbox: a container with the agent's folder at /workspace and granted project folders at /projects/<name>; nothing else on the machine is reachable. Output streams live; the result carries the exit code, whether the run timed out, and the last lines. A non-zero exit is a normal result, not a failure.",
      parameters: z.object({
        command: z.string().min(1).describe("The bash command line to run"),
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
      step: 2,
      async execute(args, ctx) {
        const { sandbox } = await sandboxFor(ctx.scope);
        const cwd =
          args.cwd === undefined
            ? WORKSPACE_ROOT
            : resolveInSandbox(args.cwd);
        return await sandbox.exec(args.command, {
          cwd,
          timeoutMs: args.timeoutMs,
          onLine: ctx.onLine,
        });
      },
    });

  const readFileTool = () =>
    defineTool({
      name: "read_file",
      description:
        "Read a file in the sandbox. Returns the requested line window, the total line count and whether the 256 KB cap cut the text.",
      parameters: z.object({
        path: z.string().min(1).describe("File path; relative to the run directory"),
        offset: z.number().int().min(1).default(1).describe("First line to return, 1-based"),
        limit: z.number().int().min(1).default(2000).describe("How many lines to return"),
      }),
      effect: "read",
      gate: "none",
      kind: "read",
      step: 2,
      async execute(args, ctx) {
        const { sandbox } = await sandboxFor(ctx.scope);
        const path = resolveInSandbox(args.path);
        const data = await readViaExec(sandbox, path);
        // As on the host: the cap cuts the bytes, the window slices the lines.
        const truncated = data.length > READ_CAP;
        const text = data.subarray(0, Math.min(data.length, READ_CAP)).toString("utf8");
        const lines = text.match(/[^\n]*\n|[^\n]+/g) ?? [];
        const window = lines.slice(args.offset - 1, args.offset - 1 + args.limit);
        return { path, text: window.join(""), totalLines: lines.length, truncated };
      },
    });

  const writeFileTool = () =>
    defineTool({
      name: "write_file",
      description:
        "Write a file in the sandbox, creating parent directories as needed. Replaces the file wholesale, so re-running with the same content is safe.",
      parameters: z.object({
        path: z.string().min(1).describe("File path; relative to the run directory"),
        content: z.string().describe("The full file content to write"),
      }),
      effect: "idempotent",
      gate: "mode",
      kind: "edit",
      step: 2,
      async execute(args, ctx) {
        const { sandbox, mounts } = await sandboxFor(ctx.scope);
        const path = resolveInSandbox(args.path);
        assertWritable(path, mounts, "write_file");
        await writeViaExec(sandbox, path, args.content);
        return { path, bytes: Buffer.byteLength(args.content, "utf8") };
      },
    });

  const editFileTool = () =>
    defineTool({
      name: "edit_file",
      description:
        "Replace text in a file in the sandbox. The anchor must occur exactly once — pass replaceAll to replace every occurrence instead.",
      parameters: z.object({
        path: z.string().min(1).describe("File path; relative to the run directory"),
        old: z.string().min(1).describe("The text to replace"),
        new: z.string().describe("The replacement text"),
        replaceAll: z.boolean().default(false).describe("Replace every occurrence of old"),
      }),
      effect: "rerunnable",
      gate: "mode",
      kind: "edit",
      step: 2,
      async execute(args, ctx) {
        const { sandbox, mounts } = await sandboxFor(ctx.scope);
        const path = resolveInSandbox(args.path);
        const original = (await readViaExec(sandbox, path)).toString("utf8");
        const count = original.split(args.old).length - 1;
        if (count === 0) {
          throw new Error(`edit_file: no match for old in ${path}`);
        }
        if (count > 1 && !args.replaceAll) {
          throw new Error(`edit_file: ${count} matches; pass replaceAll or more context`);
        }
        const next = args.replaceAll
          ? original.split(args.old).join(args.new)
          : original.replace(args.old, () => args.new);
        assertWritable(path, mounts, "edit_file");
        await writeViaExec(sandbox, path, next);
        return { path, replacements: count };
      },
    });

  const searchFilesTool = () =>
    defineTool({
      name: "search_files",
      description:
        "Search files in the sandbox with a regular expression, from /workspace by default, using ripgrep inside the container. Skips node_modules; returns up to 200 matches with file, line and text.",
      parameters: z.object({
        pattern: z.string().min(1).describe("Regular expression to match on each line"),
        path: z.string().min(1).optional().describe("Search root; defaults to the run directory"),
        glob: z.string().min(1).optional().describe("Only files matching this glob, e.g. *.ts"),
      }),
      effect: "read",
      gate: "none",
      kind: "read",
      step: 2,
      async execute(args, ctx) {
        const { sandbox } = await sandboxFor(ctx.scope);
        const root = args.path === undefined ? WORKSPACE_ROOT : resolveInSandbox(args.path);
        const argv = ["rg", "--json", "-e", shquote(args.pattern), "--glob", "'!node_modules'"];
        if (args.glob !== undefined) argv.push("--glob", shquote(args.glob));
        argv.push(".");

        const lines: string[] = [];
        const result = await sandbox.exec(argv.join(" "), {
          cwd: root,
          onLine: (line) => lines.push(line),
        });
        if (result.exitCode !== null && result.exitCode > 1) {
          throw new Error(`search_files: rg exited ${result.exitCode}: ${result.tail.join(" ").trim()}`);
        }

        // Same cap discipline as the host tool: collect one past, slice, flag.
        const collected: Array<{ path: string; line: number; text: string }> = [];
        const push = (match: { path: string; line: number; text: string }): boolean => {
          collected.push(match);
          return collected.length <= MATCH_CAP;
        };
        for (const match of parseRgJson(lines.join("\n"))) {
          if (!push(match)) break;
        }
        const truncated = collected.length > MATCH_CAP;
        return { matches: collected.slice(0, MATCH_CAP), truncated };
      },
    });

  return [shellTool(), readFileTool(), writeFileTool(), editFileTool(), searchFilesTool()];
};
