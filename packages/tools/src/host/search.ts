// search_files (ANY-73, ANY-44 D11): regex search across the tree, with
// ripgrep's --json output when rg is on PATH and a JS walker otherwise.
// Both backends yield the same { path, line, text } shape, runDir-relative
// paths, and a 200-match cap. The parser is exported and tested against a
// recorded rg run, so no test needs rg installed.
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { z } from "zod";
import { defineTool, type ToolScope } from "../define";
import type { WhichFn } from "./detect";

/** Both backends stop here; more matches flip `truncated`. */
export const MATCH_CAP = 200;

export type SearchMatch = { path: string; line: number; text: string };

const trimEol = (line: string): string => line.replace(/\r?\n$/, "");

/** rg's --json stream is subprocess output: parsed with a schema, never a
 * cast. Non-match events (begin/end/summary) and torn lines fail the parse
 * and are skipped — they are not search results. */
const RgMatchEvent = z.object({
  type: z.literal("match"),
  data: z.object({
    path: z.object({ text: z.string() }),
    lines: z.object({ text: z.string() }),
    line_number: z.number(),
  }),
});

/** Parses rg's NDJSON event stream; begin/end/summary events are skipped. */
export function parseRgJson(ndjson: string): SearchMatch[] {
  const matches: SearchMatch[] = [];
  for (const raw of ndjson.split("\n")) {
    const record = raw.trim();
    if (record === "") continue;
    let event: unknown;
    try {
      event = JSON.parse(record);
    } catch {
      continue; // a torn trailing line is not a search failure
    }
    const parsed = RgMatchEvent.safeParse(event);
    if (!parsed.success) continue;
    matches.push({
      // rg prefixes paths with "./" when told to search "."; the walker
      // reports bare root-relative paths, so strip it to match.
      path: parsed.data.data.path.text.replace(/^\.\//, ""),
      line: parsed.data.data.line_number,
      text: trimEol(parsed.data.data.lines.text),
    });
  }
  return matches.sort(byPath);
}

/** Deterministic order across both backends: path, then line number. */
const byPath = (a: SearchMatch, b: SearchMatch): number =>
  a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1;

/** Directories the walker skips, matching rg's defaults closely enough. */
const SKIP_DIRS: readonly string[] = [".git", "node_modules"];

/** Depth-first walk in sorted order; symlinked entries are not followed. */
async function* walkFiles(root: string): AsyncGenerator<string> {
  const entries = [...(await readdir(root, { withFileTypes: true }))].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  );
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.includes(entry.name)) yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/** Glob → anchored RegExp; like rg, a pattern with no `/` matches basenames. */
export function globMatcher(glob: string): (relativePath: string) => boolean {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        source += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[\\^$.+(){}[\]|]/g, "\\$&");
    }
  }
  const pattern = new RegExp(`^${source}$`);
  return glob.includes("/")
    ? (relativePath) => pattern.test(relativePath)
    : (relativePath) => pattern.test(basename(relativePath));
}

/** The JS fallback: same shape and caps as the rg leg. */
async function walkSearch(
  root: string,
  regex: RegExp,
  glob: string | undefined,
  push: (match: SearchMatch) => boolean
): Promise<void> {
  const accepts = glob === undefined ? undefined : globMatcher(glob);
  for await (const file of walkFiles(root)) {
    const relative = file.slice(root.length + 1);
    if (accepts !== undefined && !accepts(relative)) continue;
    const lines = (await readFile(file, "utf8")).split("\n");
    for (let index = 0; index < lines.length; index++) {
      const text = lines[index];
      if (text === "" && index === lines.length - 1) break; // trailing newline
      if (regex.test(text) && !push({ path: relative, line: index + 1, text })) {
        return;
      }
    }
  }
}

/** Runs rg and resolves its raw --json stdout; exit 1 (no matches) is fine. */
function runRg(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("rg", ["--json", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let failure = "";
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => (failure += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== null && code > 1) {
        reject(new Error(`rg exited ${code}: ${failure.trim()}`));
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

const resolveRoot = (raw: string | undefined, scope: ToolScope): string => {
  const dir = raw ?? scope.runDir;
  if (dir === undefined) {
    throw new Error("search_files: no path given and the scope carries no runDir");
  }
  return isAbsolute(dir) ? dir : join(scope.runDir ?? ".", dir);
};

export const searchFilesTool = ({ which }: { which: WhichFn }) =>
  defineTool({
    name: "search_files",
    description:
      "Search files on this machine with a regular expression, from the run directory by default. Skips .git and node_modules; returns up to 200 matches with file, line and text.",
    parameters: z.object({
      pattern: z.string().min(1).describe("Regular expression to match on each line"),
      path: z.string().min(1).optional().describe("Search root; defaults to the run directory"),
      glob: z.string().min(1).optional().describe("Only files matching this glob, e.g. *.ts"),
    }),
    effect: "read",
    gate: "none",
    kind: "read",
    step: "host",
    async execute(args, ctx) {
      const root = resolveRoot(args.path, ctx.scope);
      const collected: SearchMatch[] = [];
      /** Returns false once the cap is over — the callers stop walking. */
      const push = (match: SearchMatch): boolean => {
        collected.push(match);
        return collected.length <= MATCH_CAP;
      };

      if (which("rg")) {
        // cwd is the resolved root, so rg prints root-relative paths —
        // the same frame the walker reports in.
        // rg skips node_modules only when a .gitignore says so; exclude it
        // outright, as the walker does (.git is hidden, so rg skips it).
        const rgArgs = ["-e", args.pattern, "--glob", "!node_modules", "."];
        if (args.glob !== undefined) rgArgs.push("--glob", args.glob);
        for (const match of parseRgJson(await runRg(root, rgArgs))) {
          if (!push(match)) break;
        }
      } else {
        await walkSearch(root, new RegExp(args.pattern), args.glob, push);
      }

      const truncated = collected.length > MATCH_CAP;
      return { matches: collected.slice(0, MATCH_CAP), truncated };
    },
  });
