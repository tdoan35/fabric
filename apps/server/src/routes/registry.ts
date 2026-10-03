// DATA owns this file. GET /api/registry (active rows only, §4.2) and POST /api/projects.
import { Hono } from "hono";
import { readRegistry } from "@fabric/db";
import { slugId } from "@fabric/db";
import { sql } from "drizzle-orm";
import { hub } from "../services/hub";
import { runtime } from "../services/runtime";

export const registry = new Hono()
  .get("/registry", async (c) => c.json(await readRegistry(runtime().db)))
  .post("/projects", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; goal?: string };
    const name = body.name?.trim();
    const goal = body.goal?.trim() ?? "";
    if (!name) return c.json({ error: "name is required" }, 400);
    const { db } = runtime();
    const base = slugId(name);
    // The mock's createProject rule: the slug, or slug-(count+1) when taken.
    const counts = await db.db.execute(sql`select count(*) filter (where id = ${base}) as taken, count(*) as total, coalesce(max(ord), -1) + 1 as ord from projects`);
    const { taken, total, ord } = counts.rows[0] as { taken: string; total: string; ord: string };
    const id = Number(taken) > 0 ? `${base}-${Number(total) + 1}` : base;
    await db.db.execute(sql`insert into projects (id, ord, name, goal) values (${id}, ${Number(ord)}, ${name}, ${goal})`);
    hub.publishApp({ type: "registry.changed" });
    return c.json({ id, name, goal }, 201);
  });
