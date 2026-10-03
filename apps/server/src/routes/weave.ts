// DATA owns this file.
import { Hono } from "hono";
import { notImplemented } from "./_stub";

export const weave = new Hono()
  .get("/weave", notImplemented("DATA"));
