// npx tsx scripts/export-errand.ts --run <id> --out .cache/dana/errand.json [--speed 2]
// Private portable browser evidence only: no memory snapshots, input facts, DOM or model prompts.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createDb, loadRootEnv } from "@fabric/db";
import { exportErrandRecording } from "../packages/agents/src/assistant/errand-replay";

const flags: Record<string, string> = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i];
  const value = process.argv[i + 1];
  if (!name || !["--run", "--out", "--speed"].includes(name) || !value || value.startsWith("--") || flags[name] !== undefined) {
    throw new Error("usage: npx tsx scripts/export-errand.ts --run <id> --out <path> [--speed <positive number>]");
  }
  flags[name] = value;
}
if (!flags["--run"] || !flags["--out"]) throw new Error("Both --run <id> and --out <path> are required");
const speed = flags["--speed"] === undefined ? undefined : Number(flags["--speed"]);
if (speed !== undefined && (!Number.isFinite(speed) || speed <= 0 || speed > 1000)) throw new Error("--speed must be greater than zero and at most 1000");

loadRootEnv();
const db = createDb();
try {
  const recording = await exportErrandRecording(db, flags["--run"], speed);
  const out = path.resolve(flags["--out"]);
  await mkdir(path.dirname(out), { recursive: true });
  // Screenshots can contain website PII; the default .cache destination is gitignored.
  await writeFile(out, JSON.stringify(recording, null, 2) + "\n", { mode: 0o600 });
  console.log(`exported actual errand ${recording.sourceRunId} → ${out} (${recording.events.length} events, ${recording.screenshots.length} PNGs, status ${recording.result.status}); replay is rehearsal, not a new booking`);
} finally {
  await db.close();
}
