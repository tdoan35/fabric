// DATA owns this file.
import { Hono } from "hono";
import { notImplemented } from "./_stub";

export const registry = new Hono()
  .get("/registry", notImplemented("DATA"));
