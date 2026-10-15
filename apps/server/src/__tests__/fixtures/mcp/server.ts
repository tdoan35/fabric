// A real MCP server for the ANY-84 (M6) tests: the SDK's low-level Server
// behind its web-standard Streamable HTTP transport, bridged onto node:http
// on 127.0.0.1, with JSON responses (no SSE streams needed here). Every
// JSON-RPC request is counted per method, so a test can prove a cached
// discover or a refused call sent nothing, and every /mcp request's
// Authorization header is recorded in order, so a bearer-adding fetch is
// observable. The three standard tools are Y1's set: `lookup`
// (readOnlyHint), `create` (no hints) and `upsert` (idempotentHint).
//
// M7 (ANY-85) extends the helper with `auth`: the server becomes a
// protected resource — every /mcp request must carry an Authorization
// header `auth.accepts` takes, or it gets a 401 Bearer challenge; the
// RFC 9728 metadata is served at the well-known path and at
// `resourceMetadataPath` (named in the challenge as resource_metadata),
// the tools package's ANY-78 fixture shape.
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  Server,
  WebStandardStreamableHTTPServerTransport,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/server";

export type FixtureTool = {
  tool: Tool;
  /** The tools/call result; defaults to echoing the arguments as text. */
  handler?: (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>;
};

/** Y1's `lookup`: readOnlyHint, so it stamps as a read. */
export const LOOKUP: FixtureTool = {
  tool: {
    name: "lookup",
    description: "Look a query up",
    inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    annotations: { readOnlyHint: true },
  },
  handler: ({ q }) => ({ content: [{ type: "text", text: `lookup: ${String(q)}` }] }),
};

/** Y1's `create`: no hints, so it stamps as once/external. */
export const CREATE: FixtureTool = {
  tool: {
    name: "create",
    description: "Create a thing",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  handler: ({ name }) => ({ content: [{ type: "text", text: `created ${String(name)}` }] }),
};

/** Y1's `upsert`: idempotentHint, so it stamps as idempotent/external. */
export const UPSERT: FixtureTool = {
  tool: {
    name: "upsert",
    description: "Insert or update a thing",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
    annotations: { idempotentHint: true },
  },
  handler: ({ key }) => ({ content: [{ type: "text", text: `upserted ${String(key)}` }] }),
};

/** M7: the fixture as a protected resource (ANY-78's shape). */
export type TestMcpAuth = {
  accepts(authorization: string | undefined): boolean;
  /** Where the 401 challenge points; omitted → a bare `Bearer` challenge. */
  resourceMetadataPath?: string;
  metadata: { authorization_servers: string[]; scopes_supported?: string[] };
};

export type TestMcpServer = {
  url: string;
  /** JSON-RPC requests received per method (id-carrying requests only). */
  readonly calls: (method: string) => number;
  /** The Authorization header of every /mcp request, in order. */
  readonly authorizations: () => (string | undefined)[];
  close(): Promise<void>;
};

export async function startTestMcpServer(
  options: { tools?: readonly FixtureTool[]; auth?: TestMcpAuth } = {},
): Promise<TestMcpServer> {
  const tools = options.tools ?? [LOOKUP, CREATE, UPSERT];
  const methods = new Map<string, number>();
  const authorizations: (string | undefined)[] = [];
  let origin = "";
  let url = "";
  // One (server, transport) pair per MCP session: a new client initializes
  // into its own session, so every stamp and every run is a fresh protocol
  // conversation over the same counted fixture.
  const sessions = new Map<string, { server: Server; transport: WebStandardStreamableHTTPServerTransport }>();
  function newSession(): { server: Server; transport: WebStandardStreamableHTTPServerTransport } {
    const server = new Server({ name: "fabric-m6-test", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler("tools/list", async () => ({ tools: tools.map((entry) => entry.tool) }));
    server.setRequestHandler("tools/call", async (request) => {
      const entry = tools.find((candidate) => candidate.tool.name === request.params.name);
      if (entry === undefined) {
        return { content: [{ type: "text", text: `no tool ${request.params.name}` }], isError: true };
      }
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      return entry.handler === undefined
        ? { content: [{ type: "text", text: JSON.stringify(args) }] }
        : entry.handler(args);
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessions.set(id, session);
      },
    });
    const session = { server, transport };
    return session;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    if (req.method === "POST" && body.length > 0) {
      const parsed: unknown = JSON.parse(body.toString("utf8"));
      for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
        const method = (message as { method?: unknown }).method;
        if (typeof method === "string" && (message as { id?: unknown }).id !== undefined) {
          methods.set(method, (methods.get(method) ?? 0) + 1);
        }
      }
    }
    const auth = options.auth;
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (auth !== undefined && pathname !== "/mcp") {
      const served = ["/.well-known/oauth-protected-resource", auth.resourceMetadataPath];
      if (req.method === "GET" && served.includes(pathname)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ resource: url, ...auth.metadata }));
      } else {
        res.writeHead(404).end();
      }
      return;
    }
    if (auth !== undefined) {
      const authorization = req.headers.authorization;
      authorizations.push(authorization);
      if (!auth.accepts(authorization)) {
        const challenge =
          auth.resourceMetadataPath === undefined
            ? "Bearer"
            : `Bearer resource_metadata="${origin}${auth.resourceMetadataPath}"`;
        res.writeHead(401, { "www-authenticate": challenge }).end();
        return;
      }
    } else {
      authorizations.push(req.headers.authorization);
    }
    const sessionId = req.headers["mcp-session-id"];
    let session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (session === undefined) {
      session = newSession();
      await session.server.connect(session.transport);
    }

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(name, value);
      else if (Array.isArray(value)) headers.set(name, value.join(", "));
    }
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers,
      body: body.length > 0 ? body : undefined,
      signal: abort.signal,
    });
    const response = await session.transport.handleRequest(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body === null) {
      res.end();
      return;
    }
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } catch {
      // The client went away mid-stream; nothing left to deliver.
    }
    res.end();
  }

  const http = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;
  url = `${origin}/mcp`;

  return {
    url,
    calls: (method) => methods.get(method) ?? 0,
    authorizations: () => [...authorizations],
    async close() {
      await Promise.all([...sessions.values()].map((open) => open.server.close()));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
