// DATA owns this file. SSE of AppEvents (WORK-PLAN §4.4).
import { Hono } from "hono";
import { notImplemented } from "./_stub";

export const stream = new Hono()
  .get("/stream", notImplemented("DATA"));
