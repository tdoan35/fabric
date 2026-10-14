// Discovered MCP tools as ordinary Fabric ToolDefs (ANY-77, ANY-44 D6), so
// T2's policy and T3's approval gates apply unchanged. Annotations pick the
// effect and kind; the gate is `mode` and the step 0 for all. A schema that
// doesn't convert is skipped, never offered looser. Execute re-checks the
// agent's attachment first (defence in depth: policy decides what is
// offered), then calls the server under the tool's original MCP name.
import { z } from "zod";
import { defineTool, type ToolDef } from "../define";
import type { McpCallResult, McpContentBlock, McpTool } from "./client";
import { mcpToolName, serverOfToolName } from "./names";
import type { McpAccess, McpAttachment } from "./servers";

/** The server a set of tools belongs to, and its attachment check. */
export type McpToolSource = {
  name: string;
  isAttached(agentId: string): Promise<boolean>;
};

/** Sends one tools/call to `server` under the tool's original MCP name. */
export type McpCall = (
  server: string,
  tool: string,
  args: Record<string, unknown>
) => Promise<McpCallResult>;

export type McpSkipped = { name: string; reason: string };

/** What a successful MCP call returns to the run. */
export type McpToolResult = { text: string; structuredContent?: Record<string, unknown> };

export const MCP_DESCRIPTION_MAX = 1_024;
export const MCP_RESULT_MAX_CHARS = 100_000;

/** The Fabric definitions for one server's tools/list result. */
export function mcpToolDefs(
  server: McpToolSource,
  tools: readonly McpTool[],
  call: McpCall
): { defs: ToolDef[]; skipped: McpSkipped[] } {
  const defs: ToolDef[] = [];
  const skipped: McpSkipped[] = [];
  const taken = new Set<string>();

  for (const tool of tools) {
    let parameters: z.ZodType;
    try {
      parameters = z.fromJSONSchema(tool.inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
      // The registry declares tools to the model with z.toJSONSchema; a
      // schema that can't make the round trip is skipped here, not there.
      z.toJSONSchema(parameters);
    } catch (error) {
      skipped.push({ name: tool.name, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }

    const name = mcpToolName(server.name, tool.name, taken);
    if (name === undefined) {
      skipped.push({ name: tool.name, reason: "its Fabric name clashes with another tool on this server" });
      continue;
    }
    taken.add(name);

    const readOnly = tool.annotations?.readOnlyHint === true;
    const original = tool.name;
    defs.push(
      defineTool({
        name,
        description: `[${server.name}] ${tool.description || tool.title || tool.annotations?.title || ""}`.slice(
          0,
          MCP_DESCRIPTION_MAX
        ),
        parameters,
        effect: readOnly ? "read" : tool.annotations?.idempotentHint === true ? "idempotent" : "once",
        gate: "mode",
        kind: readOnly ? "read" : "external",
        step: 0,
        async execute(args, { scope }): Promise<McpToolResult> {
          if (!(await server.isAttached(scope.agentId))) {
            throw new Error(`mcp server ${server.name} is not attached to this agent`);
          }
          const result = await call(server.name, original, args as Record<string, unknown>);
          const text = truncated(renderContent(result.content ?? []));
          if (result.isError === true) {
            throw new Error(text === "" ? `mcp tool ${original} failed` : text);
          }
          return result.structuredContent === undefined
            ? { text }
            : { text, structuredContent: result.structuredContent };
        },
      })
    );
  }
  return { defs, skipped };
}

function byteLength(base64: string | undefined): number {
  return base64 === undefined ? 0 : Buffer.from(base64, "base64").length;
}

/** Text blocks as-is; media isn't passed to the model in v1, so it becomes a
 * placeholder line. Blocks are joined with blank lines. */
function renderContent(content: readonly McpContentBlock[]): string {
  return content
    .map((block) => {
      switch (block.type) {
        case "text":
          return block.text ?? "";
        case "image":
        case "audio":
          return `[${block.type} ${block.mimeType ?? "unknown"}, ${byteLength(block.data)} bytes]`;
        case "resource_link":
          return `[resource ${block.uri ?? ""}]`;
        case "resource":
          return block.resource?.text ?? `[resource ${block.resource?.uri ?? ""}, ${byteLength(block.resource?.blob)} bytes]`;
        default:
          return `[${block.type}]`;
      }
    })
    .join("\n\n");
}

function truncated(text: string): string {
  if (text.length <= MCP_RESULT_MAX_CHARS) return text;
  const more = text.length - MCP_RESULT_MAX_CHARS;
  return `${text.slice(0, MCP_RESULT_MAX_CHARS)}\n[truncated: ${more} more characters]`;
}

/** The definition layer for T2's `effectiveAccess`: each MCP tool gets its
 * server's attachment access; tools of servers the agent isn't attached to
 * (and non-MCP names) are left out. */
export function mcpDefinitionAccess(
  attachments: readonly Pick<McpAttachment, "server" | "access">[],
  toolNames: readonly string[]
): Record<string, McpAccess> {
  const byServer = new Map(attachments.map((attachment) => [attachment.server, attachment.access]));
  const access: Record<string, McpAccess> = {};
  for (const name of toolNames) {
    const server = serverOfToolName(name);
    const level = server === undefined ? undefined : byServer.get(server);
    if (level !== undefined) access[name] = level;
  }
  return access;
}
