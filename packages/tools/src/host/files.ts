// read_file / write_file / edit_file (ANY-73, ANY-44 D11): plain host
// files, unrestricted — relative paths resolve against the run directory,
// absolute paths go anywhere. Reads carry a 256 KB cap; edit_file demands
// a unique anchor unless replaceAll opts into a scatter replace.
import { open, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { defineTool, type ToolScope } from "../define";

/** The read cap: beyond this the text is cut and `truncated` is true. */
export const READ_CAP = 256 * 1024;

/** Relative paths resolve against the run directory; absolute pass through. */
const resolvePath = (raw: string, scope: ToolScope): string => {
  if (isAbsolute(raw)) return raw;
  if (scope.runDir === undefined) {
    throw new Error("relative path but the scope carries no runDir; pass an absolute path");
  }
  return join(scope.runDir, raw);
};

export const readFileTool = () =>
  defineTool({
    name: "read_file",
    description:
      "Read a file from this machine. Returns the requested line window, the total line count and whether the 256 KB cap cut the text.",
    parameters: z.object({
      path: z.string().min(1).describe("File path; relative to the run directory"),
      offset: z.number().int().min(1).default(1).describe("First line to return, 1-based"),
      limit: z.number().int().min(1).default(2000).describe("How many lines to return"),
    }),
    effect: "read",
    gate: "none",
    kind: "read",
    step: "host",
    async execute(args, ctx) {
      const path = resolvePath(args.path, ctx.scope);
      const handle = await open(path, "r");
      try {
        const size = (await handle.stat()).size;
        const truncated = size > READ_CAP;
        const buffer = Buffer.alloc(Math.min(size, READ_CAP));
        await handle.read(buffer, 0, buffer.length, 0);
        // Lines keep their own terminators, so the returned window is a
        // verbatim slice of the file; an empty file has zero lines.
        const lines = buffer.toString("utf8").match(/[^\n]*\n|[^\n]+/g) ?? [];
        const window = lines.slice(args.offset - 1, args.offset - 1 + args.limit);
        return { path, text: window.join(""), totalLines: lines.length, truncated };
      } finally {
        await handle.close();
      }
    },
  });

export const writeFileTool = () =>
  defineTool({
    name: "write_file",
    description:
      "Write a file on this machine, creating parent directories as needed. Replaces the file wholesale, so re-running with the same content is safe.",
    parameters: z.object({
      path: z.string().min(1).describe("File path; relative to the run directory"),
      content: z.string().describe("The full file content to write"),
    }),
    effect: "idempotent",
    gate: "mode",
    kind: "edit",
    step: "host",
    async execute(args, ctx) {
      const path = resolvePath(args.path, ctx.scope);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, args.content, "utf8");
      return { path, bytes: Buffer.byteLength(args.content, "utf8") };
    },
  });

export const editFileTool = () =>
  defineTool({
    name: "edit_file",
    description:
      "Replace text in a file on this machine. The anchor must occur exactly once — pass replaceAll to replace every occurrence instead.",
    parameters: z.object({
      path: z.string().min(1).describe("File path; relative to the run directory"),
      old: z.string().min(1).describe("The text to replace"),
      new: z.string().describe("The replacement text"),
      replaceAll: z.boolean().default(false).describe("Replace every occurrence of old"),
    }),
    effect: "rerunnable",
    gate: "mode",
    kind: "edit",
    step: "host",
    async execute(args, ctx) {
      const path = resolvePath(args.path, ctx.scope);
      const original = await readFile(path, "utf8");
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
      await writeFile(path, next, "utf8");
      return { path, replacements: count };
    },
  });
