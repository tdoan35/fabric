// npm run export-recording -- --run <runId> --key <key> [--kind real|illustrative] [--out <path>]
// Exports a stored run (events, snapshots, artifacts, report) as a recording bundle JSON.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createDb, exportRecording, loadRootEnv } from "@fabric/db";

const flag = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const runId = flag("run");
const key = flag("key");
if (!runId || !key) throw new Error("usage: npm run export-recording -- --run <runId> --key <key> [--kind real]");

loadRootEnv();
const db = createDb();
const bundle = await exportRecording(db, runId, { key, kind: (flag("kind") ?? "real") as "real" | "illustrative" });
const out = path.resolve(flag("out") ?? `packages/fixtures/src/recordings/${key}.json`);
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(bundle, null, 2) + "\n");
await db.close();
console.log(`exported run ${runId} → ${out} (${bundle.events.length} events, kind ${bundle.kind})`);
