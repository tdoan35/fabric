import { Hono } from "hono";
import { hub } from "../services/hub";
import { runtime } from "../services/runtime";
import { startSim } from "../services/sim";
import { startDevToolsRun } from "../services/dev-tools";
import { startDevTeamRun } from "../services/dev-team";

// Mounted only when NODE_ENV !== "production" (index.ts): the dev scratch runs.
export const dev = new Hono()
  .post("/dev/sim", async (c) => {
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
  })
  /** The TOOLS dev route: a scratch run through the real tools — Exa, sprite.exec, a blocked fetch. */
  .post("/dev/tools", async (c) => {
    const { db, writer } = runtime();
    const sim = await startDevToolsRun(db, writer, {
      onRegistryChanged: () => hub.publishApp({ type: "registry.changed" }),
      onTaskCreated: (taskId, runId) => {
        hub.publishApp({ type: "task.changed", taskId });
        hub.publishApp({ type: "run.changed", runId });
      },
      onDone: (message) => console.log(message),
    });
    void sim.done.catch((err) => console.error("dev tools: background run failed", err));
    return c.json({ taskId: sim.taskId, runId: sim.runId }, 201);
  })
  /** The TEAM dev route (§5.3 TEAM 6): a scratch run through the real team workflow. */
  .post("/dev/team", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { objective?: string; toy?: boolean; forceBounce?: boolean; forceBlock?: boolean };
    const { db, writer, team } = runtime();
    const teamRuntime = team();
    if (!teamRuntime) return c.json({ error: "TEAM runtime not available" }, 503);
    const started = await startDevTeamRun(db, writer, teamRuntime, {
      objective: body.objective,
      toy: body.toy,
      forceBounce: body.forceBounce === true,
      forceBlock: body.forceBlock === true,
      onRegistryChanged: () => hub.publishApp({ type: "registry.changed" }),
      onTaskCreated: (taskId, runId) => {
        hub.publishApp({ type: "task.changed", taskId });
        hub.publishApp({ type: "run.changed", runId });
      },
      onDone: (message) => console.log(message),
    });
    return c.json({ taskId: started.taskId, runId: started.runId }, 201);
  });
