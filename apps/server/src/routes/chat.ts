// DANA owns this file. GET /sessions/:id/messages restores a legacy thread on
// reload — S12/S13 render pre-session threads read-only from it. The
// one-response chat turn (POST /chat) retired with S14; turns go through the
// session stream (RUNTIME §13).
import { Hono } from "hono";
import { readSessionDesktop } from "@fabric/agents/assistant";
import { sql } from "@fabric/db";
import { runtime } from "../services/runtime";

export const chat = new Hono()
  .get("/sessions/:id", async (c) => {
    const { db } = runtime();
    const sessionId = c.req.param("id");
    const row = (await db.db.execute(sql`select id, title, agent_id as "agentId" from sessions where id = ${sessionId}`)).rows[0];
    if (!row) return c.json({ error: "session not found" }, 404);
    return c.json({ ...row, desktop: await readSessionDesktop(db, sessionId) });
  })
  .get("/sessions/:id/messages", async (c) => {
    const assistant = runtime().assistant();
    if (!assistant) return c.json({ error: "not implemented", owner: "DANA" } as const, 501);
    return c.json(await assistant.history(c.req.param("id")));
  });
