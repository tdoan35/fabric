// Fabric server. Integrator owns this file; each route file has its own owner.
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { corsOrigins, env } from "./env";
import { warmEmbedder } from "@fabric/agents/memory";
import { chat } from "./routes/chat";
import { dev } from "./routes/dev";
import { memory } from "./routes/memory";
import { registry } from "./routes/registry";
import { reports } from "./routes/reports";
import { runs } from "./routes/runs";
import { schedules } from "./routes/schedules";
import { startScheduler } from "./services/scheduler";
import { stream } from "./routes/stream";
import { weave } from "./routes/weave";
import { work } from "./routes/work";

const api = new Hono()
  .get("/health", (c) => c.json({ ok: true }))
  .route("/", registry)
  .route("/", work)
  .route("/", runs)
  .route("/", schedules)
  .route("/", reports)
  .route("/", memory)
  .route("/", weave)
  .route("/", stream)
  .route("/", chat);

if (process.env.NODE_ENV !== "production") api.route("/", dev);

const app = new Hono();
app.use("*", logger());
app.use("/api/*", cors({ origin: (origin) => (corsOrigins.includes(origin) ? origin : null) }));
app.route("/api", api);

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`fabric server on http://localhost:${info.port} · CORS ${corsOrigins.join(", ")}`);
  // The embedder loads once (~1–2 s from cache); doing it at boot keeps the first turn's recall to
  // a query embed (~20–50 ms). A failure only means turns run without memory (recall catches).
  warmEmbedder()
    .then(() => console.log("[memory] embedder warm"))
    .catch((err) => console.log(`[memory] embedder failed to load (${err instanceof Error ? err.message : err}); recall is off`));
});

startScheduler();
