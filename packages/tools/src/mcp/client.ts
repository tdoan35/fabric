// The MCP client (ANY-77, ANY-44 D6): remote servers over Streamable HTTP
// only, through the v2 SDK (@modelcontextprotocol/client), with the plain
// initialize handshake (the SDK's default `legacy` negotiation). Stdio
// servers come later, inside a sandbox; the legacy HTTP+SSE transport is out
// of scope. The connection opens lazily on first use, so a cached discover
// sends nothing. `headers` is the hook M5's OAuth plugs into: it runs before
// every HTTP request, the GET stream included.
import {
  Client,
  SdkError,
  SdkErrorCode,
  StreamableHTTPClientTransport,
  type FetchLike,
} from "@modelcontextprotocol/client";

/** One tools/list entry as the server sent it; cached verbatim. */
export type McpTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    idempotentHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
  };
  [key: string]: unknown;
};

export type McpContentBlock = {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  resource?: { uri?: string; text?: string; blob?: string; mimeType?: string };
  [key: string]: unknown;
};

/** A tools/call result as the server sent it. */
export type McpCallResult = {
  content: McpContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export type McpClient = {
  /** Every page of tools/list, following nextCursor to the last. */
  listTools(): Promise<McpTool[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: { timeoutMs?: number }
  ): Promise<McpCallResult>;
  /** Fires on notifications/tools/list_changed; returns an unsubscribe. */
  onToolsChanged(cb: () => void): () => void;
  close(): Promise<void>;
};

export const MCP_CALL_TIMEOUT_MS = 60_000;

export function mcpClient(options: {
  url: string;
  headers?: () => Promise<Record<string, string>>;
  fetch?: FetchLike;
}): McpClient {
  const baseFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const headers = options.headers;
  const withHeaders: FetchLike =
    headers === undefined
      ? baseFetch
      : async (url, init) => {
          const merged = new Headers(init?.headers);
          for (const [name, value] of Object.entries(await headers())) merged.set(name, value);
          return baseFetch(url, { ...init, headers: merged });
        };

  const listeners = new Set<() => void>();
  const client = new Client({ name: "fabric", version: "0.1.0" });
  client.setNotificationHandler("notifications/tools/list_changed", () => {
    for (const listener of listeners) listener();
  });

  let connecting: Promise<void> | undefined;
  const connected = (): Promise<void> => {
    connecting ??= client
      .connect(new StreamableHTTPClientTransport(new URL(options.url), { fetch: withHeaders }))
      .catch((error: unknown) => {
        connecting = undefined;
        throw error;
      });
    return connecting;
  };

  return {
    async listTools() {
      await connected();
      // The SDK's no-cursor call walks every page; "refresh" skips its
      // response cache (ours is mcp_tool_cache) but keeps the index callTool reads.
      const result = await client.listTools(undefined, { cacheMode: "refresh" });
      return result.tools as McpTool[];
    },

    async callTool(name, args, { timeoutMs = MCP_CALL_TIMEOUT_MS } = {}) {
      await connected();
      try {
        const result = await client.callTool({ name, arguments: args }, { timeout: timeoutMs });
        return result as McpCallResult;
      } catch (error) {
        if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
          throw new Error(`mcp tool ${name} timed out after ${timeoutMs} ms`);
        }
        throw error;
      }
    },

    onToolsChanged(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    async close() {
      listeners.clear();
      if (connecting !== undefined) await client.close();
    },
  };
}
