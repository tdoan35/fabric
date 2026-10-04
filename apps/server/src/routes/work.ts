// DATA owns this file.
import { Hono } from "hono";
import { notImplemented } from "./_stub";

export const work = new Hono()
  .get("/projects", notImplemented("DATA"))
  .get("/tasks", notImplemented("DATA"))
  .get("/tasks/:id", notImplemented("DATA"));
