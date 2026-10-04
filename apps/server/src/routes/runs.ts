// DATA owns this file.
import { Hono } from "hono";
import { notImplemented } from "./_stub";

export const runs = new Hono()
  .get("/runs", notImplemented("DATA"))
  .get("/runs/:id", notImplemented("DATA"))
  .get("/runs/:id/events", notImplemented("DATA"))
  /** SSE tail: ?after=<seq> */
  .get("/runs/:id/stream", notImplemented("DATA"))
  .get("/runs/:id/snapshots", notImplemented("DATA"))
  .post("/runs/:id/splice", notImplemented("DATA"))
  .post("/runs/:id/finalize-splice", notImplemented("DATA"));
