// M7 (ANY-85): the MCP management API — the workspace's servers, per-agent
// attachments, the OAuth sign-in (start plus the browser's callback) and a
// forced re-discovery — on the runtime's `mcp` handles: M4's mcpServers,
// M5's mcpOAuth and M4's discover. API only, no UI (Ty, 2026-10-13). The
// listing never carries a token or secret; the client secret passes
// straight through to M5, never echoed or logged; the callback page is
// plain HTML, no script, that escapes everything it echoes.
import { Hono } from "hono";
import { assertValidMcpServerName, assertValidMcpServerUrl, discover, mcpClient } from "@fabric/tools/mcp";
import { env } from "../env";
import { getRuntime, RUNTIME_WORKSPACE, unknownSessionAgent } from "../runtime/bootstrap";

/** Everything the callback page echoes — server names, provider errors,
 * failure messages — goes through this; the page carries no script. */
const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** The callback's whole reply: a heading and a line, both escaped. */
const page = (heading: string, detail: string): string => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(heading)}</title></head>
<body style="font-family: system-ui, sans-serif">
<h1>${escapeHtml(heading)}</h1>
<p>${escapeHtml(detail)}</p>
</body>
</html>`;

/** The JSON fields of a request body, or none when the body is not an object. */
const fieldsOf = async (request: Request): Promise<Record<string, unknown>> => {
  const body: unknown = await request.json().catch(() => null);
  return body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
};

export const mcp = new Hono()
  .get("/mcp/servers", async (c) => {
    const runtime = getRuntime();
    if (runtime === undefined) return c.json({ error: "runtime not started" }, 503);
    const listed = [];
    for (const record of await runtime.mcp.servers.list()) {
      const agents = await runtime.mcp.servers.attachedAgents(record.name);
      listed.push({
        name: record.name,
        url: record.url,
        auth: record.auth,
        status: record.status,
        lastError: record.lastError,
        agents: agents.map(({ agentId, access }) => ({ agentId, access })),
      });
    }
    return c.json(listed, 200);
  })

  .post("/mcp/servers", async (c) => {
    const runtime = getRuntime();
    if (runtime === undefined) return c.json({ error: "runtime not started" }, 503);
    const fields = await fieldsOf(c.req.raw);
    const { name, url, auth } = fields;
    if (typeof name !== "string" || typeof url !== "string" || typeof auth !== "string") {
      return c.json({ error: "invalid mcp server request" }, 400);
    }
    try {
      // M4's rules, with M4's messages.
      assertValidMcpServerName(name);
      assertValidMcpServerUrl(url);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
    if (auth !== "none" && auth !== "oauth") {
      return c.json({ error: `invalid mcp server auth ${JSON.stringify(auth)}` }, 400);
    }
    let record;
    try {
      record = await runtime.mcp.servers.add({ name, url, auth });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("already exists")) return c.json({ error: message }, 409);
      throw error;
    }
    return c.json(
      {
        name: record.name,
        url: record.url,
        auth: record.auth,
        status: record.status,
        lastError: record.lastError,
        agents: [],
      },
      201,
    );
  })

  .delete("/mcp/servers/:name", async (c) => {
    const runtime = getRuntime();
    if (runtime === undefined) return c.json({ error: "runtime not started" }, 503);
    const name = c.req.param("name");
    if ((await runtime.mcp.servers.get(name)) === undefined) {
      return c.json({ error: `unknown mcp server ${name}` }, 404);
    }
    // M5 revokes best effort and deletes the tokens; M4 then drops the
    // record, its attachments and its cache.
    await runtime.mcp.oauth.disconnect(name);
    await runtime.mcp.servers.remove(name);
    return c.body(null, 204);
  })

  .put("/mcp/servers/:name/agents/:agentId", async (c) => {
    const runtime = getRuntime();
    if (runtime === undefined) return c.json({ error: "runtime not started" }, 503);
    const { name, agentId } = c.req.param();
    if ((await runtime.mcp.servers.get(name)) === undefined) {
      return c.json({ error: `unknown mcp server ${name}` }, 404);
    }
    if (unknownSessionAgent(agentId)) return c.json({ error: `unknown agent: ${agentId}` }, 404);
    const requested = (await fieldsOf(c.req.raw)).access;
    if (requested !== undefined && requested !== "allowed" && requested !== "approval") {
      return c.json({ error: `invalid mcp access ${JSON.stringify(requested)}` }, 400);
    }
    const access = requested === undefined ? "allowed" : requested;
    // Attaching again changes the access (M4).
    await runtime.mcp.servers.attach(name, agentId, access);
    return c.json({ server: name, agentId, access }, 200);
  })

  .delete("/mcp/servers/:name/agents/:agentId", async (c) => {
    const runtime = getRuntime();
    if (runtime === undefined) return c.json({ error: "runtime not started" }, 503);
    const { name, agentId } = c.req.param();
    if ((await runtime.mcp.servers.get(name)) === undefined) {
      return c.json({ error: `unknown mcp server ${name}` }, 404);
    }
    // M5 as merged handles the rest: the last agent detaching signs the
    // server out — the vault listener wired at boot revokes and deletes.
    await runtime.mcp.servers.detach(name, agentId);
    return c.body(null, 204);
  })

  .post("/mcp/servers/:name/oauth/start", async (c) => {
    const runtime = getRuntime();
    if (runtime === undefined) return c.json({ error: "runtime not started" }, 503);
    const name = c.req.param("name");
    const record = await runtime.mcp.servers.get(name);
    if (record === undefined) return c.json({ error: `unknown mcp server ${name}` }, 404);
    if (record.auth === "none") {
      return c.json({ error: `mcp server ${name} needs no sign-in (auth none)` }, 400);
    }
    const fields = await fieldsOf(c.req.raw);
    const clientId = typeof fields.clientId === "string" ? fields.clientId : undefined;
    const clientSecret = typeof fields.clientSecret === "string" ? fields.clientSecret : undefined;
    try {
      const { authorizeUrl } = await runtime.mcp.oauth.start(name, {
        // The public origin the provider redirects back to. Read per
        // request — the vault reads its process.env fallbacks the same
        // lazy way — because the parsed env snapshots at import.
        redirectUri: `${process.env.FABRIC_PUBLIC_URL ?? `http://localhost:${env.PORT}`}/api/mcp/oauth/callback`,
        ...(clientId === undefined ? {} : { clientId }),
        // Straight to M5; never echoed, never logged.
        ...(clientSecret === undefined ? {} : { clientSecret }),
      });
      return c.json({ authorizeUrl }, 200);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  })

  // The browser lands here from the provider; Z7/Z8's page.
  .get("/mcp/oauth/callback", async (c) => {
    const runtime = getRuntime();
    if (runtime === undefined) return c.json({ error: "runtime not started" }, 503);
    const providerError = c.req.query("error");
    if (providerError !== undefined) {
      // The provider refused before issuing a code; nothing is stored.
      return c.html(page("Sign-in failed", `The authorization server refused the sign-in: ${providerError}`), 400);
    }
    const state = c.req.query("state");
    const code = c.req.query("code");
    if (state === undefined || state === "" || code === undefined || code === "") {
      return c.html(page("Sign-in failed", "The sign-in reply is missing its state or code."), 400);
    }
    // finish replies void, and its delete is what makes a state single use —
    // so the pending row's server name is read here, before finish consumes
    // the row, for the success page.
    const rows = await runtime.store.transaction((tx) =>
      tx.query(`select server from mcp_oauth_pending where workspace_id = $1 and state = $2`, [
        RUNTIME_WORKSPACE,
        state,
      ]),
    );
    const row = rows[0];
    if (row === undefined) {
      return c.html(page("Sign-in failed", "The sign-in state is unknown or already used."), 400);
    }
    const server = String(row.server);
    try {
      await runtime.mcp.oauth.finish({ state, code });
    } catch (error) {
      return c.html(page("Sign-in failed", error instanceof Error ? error.message : String(error)), 400);
    }
    return c.html(page("Signed in", `Signed in to ${server}. You can close this tab.`), 200);
  })

  .post("/mcp/servers/:name/refresh", async (c) => {
    const runtime = getRuntime();
    if (runtime === undefined) return c.json({ error: "runtime not started" }, 503);
    const name = c.req.param("name");
    const record = await runtime.mcp.servers.get(name);
    if (record === undefined) return c.json({ error: `unknown mcp server ${name}` }, 404);
    const attached = await runtime.mcp.servers.attachedAgents(name);
    if (attached.length === 0) return c.json({ error: "attach an agent first" }, 409);
    const agentId = attached[0].agentId;
    // A one-shot client for the forced listing — the runtime's cached
    // (server, agent) clients serve sessions (M6) — closed after, so the
    // MCP session does not linger.
    const client = mcpClient({
      url: record.url,
      ...(record.auth === "oauth" ? { fetch: runtime.mcp.oauth.fetchFor(name, agentId) } : {}),
    });
    try {
      const { tools, skipped } = await discover(runtime.mcp.servers, client, name, { refresh: true });
      return c.json({ tools: tools.map((tool) => tool.name), skipped }, 200);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    } finally {
      void client.close().catch(() => {
        // Best effort: the listing already answered.
      });
    }
  });
