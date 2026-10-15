// M3 (ANY-83): the skills API — folder import and the per-agent listing, on
// the runtime's skills store. The import reads the server's own filesystem
// (the D11 own-machine trust), API only, no UI: `dir` must be absolute and
// existing, `agentId` must be a known agent under a loaded snapshot, and one
// bad folder never fails the request — it is reported in `results`.
import { stat } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { importSkills, type SkillImportResult } from "@fabric/memory/skills";
import { getRuntime, unknownSessionAgent } from "../runtime/bootstrap";

/** The request body: `{ dir, agentId }`, both strings. */
const importRequest = async (request: Request): Promise<{ dir: string; agentId: string } | undefined> => {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null) return undefined;
  const { dir, agentId } = body as Record<string, unknown>;
  if (typeof dir !== "string" || dir === "") return undefined;
  if (typeof agentId !== "string" || agentId === "") return undefined;
  return { dir, agentId };
};

export const skills = new Hono()
  .post("/skills/import", async (c) => {
    const runtime = getRuntime();
    if (runtime === undefined) return c.json({ error: "runtime not started" }, 503);

    const request = await importRequest(c.req.raw);
    if (request === undefined) return c.json({ error: "invalid import request" }, 400);
    const { dir, agentId } = request;

    if (!path.isAbsolute(dir)) return c.json({ error: "dir must be an absolute path" }, 400);
    const dirStat = await stat(dir).catch(() => undefined);
    if (dirStat?.isDirectory() !== true) return c.json({ error: `dir is not an existing directory: ${dir}` }, 400);
    if (unknownSessionAgent(agentId)) return c.json({ error: `unknown agent: ${agentId}` }, 404);

    // The walk itself failing (a dir that exists but can't be read) is an
    // input error like the two above, not a 500; a folder that merely errors
    // is caught per-folder inside importSkills and reported in `results`.
    let results: SkillImportResult[];
    try {
      results = await importSkills(runtime.skills, dir, { agentId });
    } catch (error) {
      return c.json({ error: `dir could not be read: ${error instanceof Error ? error.message : String(error)}` }, 400);
    }
    const counts = { created: 0, patched: 0, unchanged: 0, errors: 0 };
    for (const result of results) counts[result.status === "error" ? "errors" : result.status] += 1;
    return c.json({ results, counts }, 200);
  })

  .get("/agents/:id/skills", async (c) => {
    const runtime = getRuntime();
    if (runtime === undefined) return c.json({ error: "runtime not started" }, 503);
    const rows = await runtime.skills.list(c.req.param("id"));
    return c.json(rows.map(({ name, description, version }) => ({ name, description, version })), 200);
  });
