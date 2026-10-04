// DATA owns this file.
import { Hono } from "hono";
import { notImplemented } from "./_stub";

export const reports = new Hono()
  .get("/reports/:id", notImplemented("DATA"))
  .get("/artifacts/:id", notImplemented("DATA"));
