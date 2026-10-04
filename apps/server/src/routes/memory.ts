// MEM owns this file. Keep/Forget on a memory row: Keep pins it (recall boost, top of the tab),
// Forget soft-deletes (forgotten_at set; recall and every list stop serving it).
import { Hono } from "hono";
import { z } from "zod";
import { decideMemory } from "@fabric/db";
import { runtime } from "../services/runtime";

const DecisionSchema = z.object({ decision: z.enum(["kept", "forgotten"]) });

export const memory = new Hono().post("/memories/:id/decision", async (c) => {
  const parsed = DecisionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid decision body", owner: "MEM" } as const, 400);
  const row = await decideMemory(runtime().db, c.req.param("id"), parsed.data.decision);
  if (!row) return c.json({ error: "no such memory", owner: "MEM" } as const, 404);
  return c.json({ ok: true, id: row.id, decision: parsed.data.decision });
});
