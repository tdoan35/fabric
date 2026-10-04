// DATA owns this file. Work read models: projects and tasks (§4.2). Loop endpoints live in runs.ts.
import { Hono } from "hono";
import { listProjects, listTasks, readTask } from "@fabric/db";
import { runtime } from "../services/runtime";

export const work = new Hono()
  .get("/projects", async (c) => c.json(await listProjects(runtime().db)))
  .get("/tasks", async (c) => c.json(await listTasks(runtime().db)))
  .get("/tasks/:id", async (c) => {
    const task = await readTask(runtime().db, c.req.param("id"));
    return task ? c.json(task) : c.json({ error: "task not found" }, 404);
  });
