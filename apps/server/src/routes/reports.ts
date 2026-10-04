// DATA owns this file. Reports and artifact downloads (§4.2).
import { Hono } from "hono";
import { readArtifact, readReport, getRunRow } from "@fabric/db";
import { sql } from "drizzle-orm";
import { runtime } from "../services/runtime";

export const reports = new Hono()
  .get("/reports/:id", async (c) => {
    const db = runtime().db;
    const report = await readReport(db, c.req.param("id"));
    if (!report) return c.json({ error: "report not found" }, 404);
    const run = await getRunRow(db, report.runId);
    const artifactRunId = run?.spliced_from_run_id ?? report.runId;
    const rows = await db.db.execute(sql`select id, name from artifacts where run_id = ${artifactRunId}`);
    const ids = new Map((rows.rows as { id: string; name: string }[]).map((a) => [a.name, a.id]));
    return c.json({
      ...report,
      artifacts: report.artifacts.map((a) => ({ ...a, id: a.id ?? ids.get(a.name) })),
      setup: report.setup ?? (run?.spliced_from_run_id ? [
        { label: "Model", value: "135M open model" },
        { label: "Method", value: "Inference-time n-gram lookup" },
        { label: "Corpus", value: "Cached corpus" },
        { label: "Split", value: "Held-out; overlap removed after review" },
      ] : undefined),
    });
  })
  .get("/artifacts/:id", async (c) => {
    const artifact = await readArtifact(runtime().db, c.req.param("id"));
    if (!artifact) return c.json({ error: "artifact not found" }, 404);
    return c.body(new Uint8Array(artifact.body), 200, {
      "content-type": artifact.contentType,
      "content-disposition": `inline; filename="${artifact.name.replace(/"/g, "")}"`,
    });
  });
