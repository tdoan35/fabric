// DANA owns this file. POST /chat streams NDJSON (WORK-PLAN §4.3); GET /sessions/:id/messages
// restores the thread on reload. The request body is validated by the contract schema; the
// x-fabric-fixture header turns on scripted Dana for the turn (RUN-12), like `fixture: true`.
import { Hono } from "hono";
import { ChatRequestSchema } from "@fabric/contracts";
import { readSessionDesktop } from "@fabric/agents/assistant";
import { sql } from "@fabric/db";
import { runtime } from "../services/runtime";

export const chat = new Hono()
  .post("/chat", async (c) => {
    const assistant = runtime().assistant();
    if (!assistant) return c.json({ error: "not implemented", owner: "DANA" } as const, 501);
    const parsed = ChatRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid chat request", owner: "DANA" } as const, 400);
    const fixtureHeader = c.req.header("x-fabric-fixture") === "1";
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const line of assistant.chat({ ...parsed.data, fixture: parsed.data.fixture || fixtureHeader })) {
            controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
          }
        } catch (err) {
          // Mid-stream failures can't change the status line anymore; log and close. The client's
          // cumulative snapshot just stops growing, and the turn isn't persisted half-way.
          console.error("[chat] turn failed:", err instanceof Error ? err.message : err);
        } finally {
          controller.close();
        }
      },
    });
    return c.body(stream, 200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache" });
  })
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
