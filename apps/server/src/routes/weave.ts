// DATA owns this file. Weave snapshot (phase 1: the seeded world plus finalize's result items).
import { Hono } from "hono";
import { readWeave } from "@fabric/db";
import { runtime } from "../services/runtime";

export const weave = new Hono().get("/weave", async (c) => c.json(await readWeave(runtime().db)));
