// `npm run skills:import -w @fabric/memory -- <dir> --agent <id> [--workspace <id>] [--pglite <dir>]`
// (ANY-75 M1): imports SKILL.md folders into one agent's skills. The store is
// RUNTIME_DATABASE_URL when set, otherwise the PGlite data dir given by
// --pglite — there is no guessed default. Exit 1 when any folder errored.
import { parseArgs } from "node:util";
import { openStore, type StoreConfig } from "@fabric/runtime";
import { ensureSkillsSchema, importSkills, skillsStore } from "../src/skills";

/** S5's local workspace id. */
const DEFAULT_WORKSPACE = "local";

const USAGE = `usage: npm run skills:import -w @fabric/memory -- <dir> --agent <id> [--workspace <id>] [--pglite <dir>]

  <dir>          a skill folder (has SKILL.md), or a root whose subfolders are skill folders
  --agent        the agent that owns the imported skills
  --workspace    workspace id (default: ${DEFAULT_WORKSPACE})
  --pglite       PGlite data dir; required unless RUNTIME_DATABASE_URL is set

PGlite is single-process: stop the server before importing into its data dir.`;

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  process.exit(2);
}

async function main(): Promise<number> {
  let parsed: ReturnType<typeof parseCli>;
  try {
    parsed = parseCli();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1) fail("expected exactly one <dir>");
  if (values.agent === undefined || values.agent === "") fail("--agent is required");

  const url = process.env.RUNTIME_DATABASE_URL;
  let config: StoreConfig;
  if (url !== undefined && url !== "") config = { driver: "postgres", url };
  else if (values.pglite !== undefined && values.pglite !== "") config = { driver: "pglite", dataDir: values.pglite };
  else fail("no store: set RUNTIME_DATABASE_URL or pass --pglite <dir>");

  const store = await openStore(config);
  try {
    await ensureSkillsSchema(store);
    const skills = skillsStore(store, values.workspace ?? DEFAULT_WORKSPACE);
    const results = await importSkills(skills, positionals[0], { agentId: values.agent });

    const counts = { created: 0, patched: 0, unchanged: 0, errors: 0 };
    for (const result of results) {
      if (result.status === "error") {
        counts.errors += 1;
        console.log(`error ${result.folder}: ${result.message}`);
      } else {
        counts[result.status] += 1;
        console.log(`${result.status} ${result.folder} v${result.version} (${result.skillId})`);
      }
    }
    console.log(
      `imported: created=${counts.created} patched=${counts.patched} unchanged=${counts.unchanged} errors=${counts.errors}`
    );
    return counts.errors > 0 ? 1 : 0;
  } finally {
    await store.close();
  }
}

function parseCli() {
  return parseArgs({
    allowPositionals: true,
    options: {
      agent: { type: "string" },
      workspace: { type: "string" },
      pglite: { type: "string" },
    },
  });
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  }
);
