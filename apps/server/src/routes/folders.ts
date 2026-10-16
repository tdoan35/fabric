// The folder and execution routes (ANY-91 T19, API only): the shared project
// folders and their grants (T10's stores), the per-agent workspace reset (D2)
// and the execution switch's status. Everything reads the boot's execution —
// `getRuntime().execution` — so the routes exist in every mode; on host there
// is simply no provider behind them.
import { readdir } from "node:fs/promises";
import path from "node:path";
import { Hono, type Context } from "hono";
import { FOLDER_NAME_PATTERN, type FolderAccess } from "@fabric/tools/folders";
import { getRuntime, unknownSessionAgent } from "../runtime/bootstrap";

const PROJECT_NAME = new RegExp(FOLDER_NAME_PATTERN);

/** The boot's execution, or undefined before `startRuntime`. */
const execution = () => getRuntime()?.execution;

const notStarted = (c: Context) => c.json({ error: "runtime not started" }, 503);

export const folders = new Hono()
  // The projects and, per project, the agents granted them with their access.
  .get("/folders/projects", async (c) => {
    const ex = execution();
    if (ex === undefined) return notStarted(c);
    const entries = await readdir(path.join(ex.folders.root, "projects"), { withFileTypes: true }).catch(
      () => [],
    );
    const projects = [];
    for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
      const agents = [];
      for (const agentId of await ex.grants.agentsFor(entry.name)) {
        const grant = (await ex.grants.grantsFor(agentId)).find((candidate) => candidate.project === entry.name);
        if (grant !== undefined) agents.push({ agentId, access: grant.access });
      }
      projects.push({ name: entry.name, agents });
    }
    return c.json(projects);
  })

  .post("/folders/projects", async (c) => {
    const ex = execution();
    if (ex === undefined) return notStarted(c);
    const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
    const name = body?.name;
    if (typeof name !== "string" || !PROJECT_NAME.test(name)) {
      return c.json({ error: "invalid project name: must match ^[a-z][a-z0-9-]{0,39}$" }, 400);
    }
    if (await ex.folders.exists({ kind: "project", name })) {
      return c.json({ error: `project exists: ${name}` }, 409);
    }
    await ex.folders.path({ kind: "project", name });
    return c.json({ name, agents: [] }, 201);
  })

  // Drops the grants and the directory.
  .delete("/folders/projects/:name", async (c) => {
    const ex = execution();
    if (ex === undefined) return notStarted(c);
    const name = c.req.param("name");
    if (!PROJECT_NAME.test(name)) return c.json({ error: "invalid project name" }, 400);
    await ex.grants.removeProject(name);
    await ex.folders.remove({ kind: "project", name });
    return c.body(null, 204);
  })

  .put("/folders/projects/:name/agents/:agentId", async (c) => {
    const ex = execution();
    if (ex === undefined) return notStarted(c);
    const name = c.req.param("name");
    const agentId = c.req.param("agentId");
    if (!PROJECT_NAME.test(name)) return c.json({ error: "invalid project name" }, 400);
    const body = (await c.req.json().catch(() => null)) as { access?: unknown } | null;
    if (body?.access !== "read" && body?.access !== "write") {
      return c.json({ error: `invalid access ${JSON.stringify(body?.access)}: read | write` }, 400);
    }
    if (!(await ex.folders.exists({ kind: "project", name }))) {
      return c.json({ error: `unknown project: ${name}` }, 404);
    }
    // a loaded snapshot makes the id space closed
    if (unknownSessionAgent(agentId)) return c.json({ error: `unknown agent: ${agentId}` }, 404);
    const access = body.access as FolderAccess;
    await ex.grants.grant(name, agentId, access);
    return c.json({ project: name, agentId, access }, 200);
  })

  .delete("/folders/projects/:name/agents/:agentId", async (c) => {
    const ex = execution();
    if (ex === undefined) return notStarted(c);
    const name = c.req.param("name");
    if (!PROJECT_NAME.test(name)) return c.json({ error: "invalid project name" }, 400);
    await ex.grants.revoke(name, c.req.param("agentId"));
    return c.body(null, 204);
  })

  // Reset workspace (D2): the agent's sandbox stops, `agents/<id>` empties.
  .delete("/agents/:id/workspace", async (c) => {
    const ex = execution();
    if (ex === undefined) return notStarted(c);
    const id = c.req.param("id");
    if (unknownSessionAgent(id)) return c.json({ error: `unknown agent: ${id}` }, 404);
    await ex.resetAgent(id);
    return c.body(null, 204);
  })

  .get("/execution", async (c) => {
    const ex = execution();
    if (ex === undefined) return notStarted(c);
    return c.json({ mode: ex.mode, available: await ex.available(), sandboxes: ex.sandboxes() });
  });
