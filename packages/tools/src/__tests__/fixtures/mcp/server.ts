// A real MCP server for the ANY-77 tests: the SDK's low-level Server behind
// its web-standard Streamable HTTP transport, bridged onto node:http on
// 127.0.0.1. Raw tools/list and tools/call handlers give the tests full
// control over JSON Schemas, annotations, pagination and results. Every HTTP
// request and every JSON-RPC method is counted, so a test can prove that a
// cached discover or a refused call sent nothing.
//
// With `auth` (ANY-78) the server is a protected resource: every /mcp
// request must carry an Authorization header `auth.accepts` takes, or it
// gets a 401 Bearer challenge; the RFC 9728 metadata is served at the
// well-known path and, when given, at `resourceMetadataPath` (named in the
// challenge as resource_metadata).
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

export type TestMcpServer = {
  url: string;
  /** HTTP requests received, of any kind. */
  readonly requests: () => number;
  /** JSON-RPC requests received per method (`tools/list` counts each page). */
  readonly calls: (method: string) => number;
  /** Standalone GET streams opened (where list_changed is delivered). */
  readonly streams: () => number;
  /** Request paths, in order, the well-known ones included. */
  readonly paths: () => string[];
  /** The Authorization header of every /mcp request, in order. */
  readonly authorizations: () => (string | undefined)[];
  /** Sends notifications/tools/list_changed on every open session. */
  listChanged(): Promise<void>;
  close(): Promise<void>;
};

export type TestMcpAuth = {
  accepts(authorization: string | undefined): boolean;
  /** Where the 401 challenge points; omitted → a bare `Bearer` challenge. */
  resourceMetadataPath?: string;
  metadata: { authorization_servers: string[]; scopes_supported?: string[] };
};

type Session = { server: Server; transport: WebStandardStreamableHTTPServerTransport };

export async function startTestMcpServer(options: {
  tools: readonly FixtureTool[];
  /** Tools per tools/list page; the cursor is the next index. */
  pageSize?: number;
  auth?: TestMcpAuth;
}): Promise<TestMcpServer> {
  const pageSize = options.pageSize ?? options.tools.length;
  const sessions = new Map<string, Session>();
  let requests = 0;
  let streams = 0;
  const paths: string[] = [];
  const authorizations: (string | undefined)[] = [];
  const methods = new Map<string, number>();

  function newSession(): Session {
    const server = new Server(
      { name: "fabric-test", version: "1.0.0" },
      { capabilities: { tools: { listChanged: true } } }
    );
    server.setRequestHandler("tools/list", async (request) => {
      const start = Number(request.params?.cursor ?? 0);
      const page = options.tools.slice(start, start + pageSize).map((entry) => entry.tool);
      const next = start + pageSize;
      return next < options.tools.length
        ? { tools: page, nextCursor: String(next) }
        : { tools: page };
    });
    server.setRequestHandler("tools/call", async (request) => {
      const entry = options.tools.find((candidate) => candidate.tool.name === request.params.name);
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
      onsessioninitialized: (id) => {
        sessions.set(id, session);
      },
    });
    const session = { server, transport };
    return session;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    requests += 1;
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    paths.push(pathname);
    const auth = options.auth;
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
    }
    if (req.method === "GET") streams += 1;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    if (req.method === "POST" && body.length > 0) {
      const parsed: unknown = JSON.parse(body.toString("utf8"));
      for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
        const method = (message as { method?: unknown; id?: unknown }).method;
        if (typeof method === "string" && (message as { id?: unknown }).id !== undefined) {
          methods.set(method, (methods.get(method) ?? 0) + 1);
        }
      }
    }

    const sessionId = req.headers["mcp-session-id"];
    let session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (session === undefined) {
      if (typeof sessionId === "string") {
        res.writeHead(404).end();
        return;
      }
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

  let origin = "";
  let url = "";
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
    requests: () => requests,
    calls: (method) => methods.get(method) ?? 0,
    streams: () => streams,
    paths: () => [...paths],
    authorizations: () => [...authorizations],
    async listChanged() {
      await Promise.all([...sessions.values()].map((s) => s.server.sendToolListChanged()));
    },
    async close() {
      await Promise.all([...sessions.values()].map((s) => s.server.close()));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
