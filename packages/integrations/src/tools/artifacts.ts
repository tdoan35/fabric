// artifacts.read / artifacts.write (§5.3 TOOLS 6): the run's artifacts, stored through
// RunWriter.saveArtifact (small files live in the DB; saveArtifact also emits artifact.created).
import { z } from "zod";
import { sql } from "@fabric/db";
import type { Db } from "@fabric/db";
import type { ToolPolicy } from "@fabric/contracts";
import { makeTool } from "../tool-context";
import type { ToolCtx } from "../tool-context";

export function artifactsWriteTool(policy: ToolPolicy, ctx: ToolCtx) {
  return makeTool(
    {
      name: "artifacts.write",
      description: "Save one file as a run artifact (small files: text or base64). Returns its artifact id.",
      inputSchema: z.object({
        name: z.string().min(1).describe("Artifact name, e.g. literature-survey.md"),
        content: z.string().describe("The artifact's full text contents"),
      }),
      policy,
      summary: (i) => `save ${i.name} (${i.content.length} chars)`,
      target: (i) => i.name,
      run: async (i) => {
        const { id } = await ctx.writer.saveArtifact(ctx.runId, { name: i.name, by: ctx.actor, content: i.content });
        return { artifactId: id };
      },
    },
    ctx,
  );
}

export function artifactsReadTool(policy: ToolPolicy, ctx: ToolCtx, db?: Db) {
  return makeTool(
    {
      name: "artifacts.read",
      description: "List the run's artifacts, or read one by name. With content: false you get just the names.",
      inputSchema: z.object({
        name: z.string().optional().describe("The artifact to read; omit to list them all"),
        content: z.boolean().optional().describe("Include the contents; default true"),
      }),
      policy,
      summary: (i) => (i.name ? `read ${i.name}` : "list artifacts"),
      target: (i) => i.name ?? "",
      run: async (i) => {
        if (!db) throw new Error("artifacts.read needs a db in the tools context");
        if (!i.name) {
          const rows = await db.db.execute(sql`select name from artifacts where run_id = ${ctx.runId} order by ord`);
          return { names: (rows.rows as { name: string }[]).map((r) => r.name) };
        }
        const rows = await db.db.execute(sql`
          select name, content_type, content from artifacts where run_id = ${ctx.runId} and name = ${i.name}
          order by ord desc limit 1`);
        const row = (rows.rows as { name: string; content_type: string; content: string }[])[0];
        if (!row) throw new Error(`no artifact named ${i.name} in this run`);
        const text = row.content_type === "text/plain" ? row.content : undefined;
        return i.content === false ? { name: row.name } : { name: row.name, contentType: row.content_type, ...(text !== undefined ? { text } : {}) };
      },
    },
    ctx,
  );
}
