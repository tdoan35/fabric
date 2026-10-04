// DANA owns this file. POST /chat streams NDJSON (WORK-PLAN §4.3).
import { Hono } from "hono";
import { notImplemented } from "./_stub";

export const chat = new Hono()
  .post("/chat", notImplemented("DANA"))
  .get("/sessions/:id/messages", notImplemented("DANA"));
