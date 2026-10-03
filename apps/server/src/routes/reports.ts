// DATA owns this file. Reports and artifact downloads (§4.2). The report row already carries
// setup rows and artifact ids (stamped at import / finalize), so GET serves it as-is.
import { Hono } from "hono";
import { readArtifact, readReport } from "@fabric/db";
import { runtime } from "../services/runtime";

export const reports = new Hono()
  .get("/reports/:id", async (c) => {
    const report = await readReport(runtime().db, c.req.param("id"));
    if (!report) return c.json({ error: "report not found" }, 404);
    return c.json(report);
  })
  .get("/artifacts/:id", async (c) => {
    const artifact = await readArtifact(runtime().db, c.req.param("id"));
    if (!artifact) return c.json({ error: "artifact not found" }, 404);
    return c.body(new Uint8Array(artifact.body), 200, {
      "content-type": artifact.contentType,
      "content-disposition": `inline; filename="${artifact.name.replace(/"/g, "")}"`,
    });
  });
