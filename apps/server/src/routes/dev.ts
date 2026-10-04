import { Hono } from "hono";
import { hub } from "../services/hub";
import { runtime } from "../services/runtime";
import { startSim } from "../services/sim";

export const dev = new Hono().post("/dev/sim", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { speed?: number; window?: number };
  if ((body.speed !== undefined && !(Number(body.speed) > 0)) || (body.window !== undefined && !(Number(body.window) > 0))) {
    return c.json({ error: "speed and window must be positive numbers" }, 400);
  }
  const { db, writer } = runtime();
  const sim = await startSim(db, writer, {
    speed: body.speed, window: body.window,
    recordingKey: process.env.DEMO_RECORDING_KEY,
    onRegistryChanged: () => hub.publishApp({ type: "registry.changed" }),
    onTaskCreated: (taskId, runId) => {
      hub.publishApp({ type: "task.changed", taskId });
      hub.publishApp({ type: "run.changed", runId });
    },
    onDone: (message) => console.log(message),
  });
  void sim.done.catch((err) => console.error("sim: background emitter failed", err));
  return c.json({ taskId: sim.taskId, runId: sim.runId }, 201);
});
