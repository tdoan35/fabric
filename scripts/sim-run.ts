// npm run sim -- [--speed 1] [--window 60] [--session <id>|none] [--runfile <path>]
import { writeFile } from "node:fs/promises";
import { createDb, createRunWriterWith, loadRootEnv } from "@fabric/db";
import { startSim } from "../apps/server/src/services/sim";

const flag = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
loadRootEnv();
const db = createDb();
try {
  const sim = await startSim(db, createRunWriterWith(db), {
    speed: Number(flag("speed") ?? 1),
    window: Number(flag("window") ?? 60),
    session: flag("session"),
    recordingKey: process.env.DEMO_RECORDING_KEY,
    onDone: (message) => console.log(message),
  });
  console.log(`sim: task ${sim.taskId} · run ${sim.runId} · speed ${sim.speed}× · window ${sim.window}s`);
  if (flag("runfile")) await writeFile(flag("runfile")!, JSON.stringify({ taskId: sim.taskId, runId: sim.runId }, null, 2));
  await sim.done;
} finally {
  await db.close();
}
