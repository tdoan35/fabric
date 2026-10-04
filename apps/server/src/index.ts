// Fabric server (WORK-PLAN §3.1, §4.2). Integrator owns this file; each route file has its own owner.
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { corsOrigins, env } from "./env";
import { chat } from "./routes/chat";
import { registry } from "./routes/registry";
import { reports } from "./routes/reports";
import { runs } from "./routes/runs";
import { stream } from "./routes/stream";
import { weave } from "./routes/weave";
import { work } from "./routes/work";

const api = new Hono()
  .get("/health", (c) => c.json({ ok: true }))
  .route("/", registry)
  .route("/", work)
  .route("/", runs)
  .route("/", reports)
  .route("/", weave)
  .route("/", stream)
  .route("/", chat);

const app = new Hono();
app.use("*", logger());
app.use("/api/*", cors({ origin: (origin) => (corsOrigins.includes(origin) ? origin : null) }));
app.route("/api", api);

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`fabric server on http://localhost:${info.port} · CORS ${corsOrigins.join(", ")}`);
});
