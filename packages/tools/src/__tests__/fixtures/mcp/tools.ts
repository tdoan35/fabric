// Fixture MCP tools for the ANY-77 tests: raw tools/list entries (JSON
// Schema inputs, annotations) and their tools/call results, served by
// ./server.ts.
import type { FixtureTool } from "./server";

export const createIssue: FixtureTool = {
  tool: {
    name: "create_issue",
    description: "Create an issue in a repository",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["repo", "title"],
    },
  },
  handler: (args) => ({
    content: [
      { type: "text", text: `created ${String(args.title)}` },
      { type: "text", text: `in ${String(args.repo)}` },
    ],
    structuredContent: { number: 42, repo: args.repo },
  }),
};

export const getFile: FixtureTool = {
  tool: {
    name: "Get-File.Contents",
    title: "Read a file",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    annotations: { readOnlyHint: true },
  },
  handler: (args) => ({ content: [{ type: "text", text: `contents of ${String(args.path)}` }] }),
};

export const setLabel: FixtureTool = {
  tool: {
    name: "set_label",
    description: "Set a label (setting it twice is harmless)",
    inputSchema: { type: "object", properties: { label: { type: "string" } } },
    annotations: { idempotentHint: true },
  },
};

/** A schema z.fromJSONSchema refuses: the $ref points nowhere. */
export const broken: FixtureTool = {
  tool: {
    name: "broken",
    description: "Its schema references a definition that does not exist",
    inputSchema: {
      type: "object",
      properties: { x: { $ref: "#/$defs/missing" } },
    },
  },
};

export const failing: FixtureTool = {
  tool: { name: "failing", description: "Always fails", inputSchema: { type: "object" } },
  handler: () => ({
    content: [{ type: "text", text: "repository not found: acme/nope" }],
    isError: true,
  }),
};

/** Ten bytes of image data plus a caption. */
export const screenshot: FixtureTool = {
  tool: { name: "screenshot", description: "Take a screenshot", inputSchema: { type: "object" } },
  handler: () => ({
    content: [
      { type: "text", text: "here it is" },
      { type: "image", data: Buffer.alloc(10, 7).toString("base64"), mimeType: "image/png" },
    ],
  }),
};

export const huge: FixtureTool = {
  tool: { name: "huge", description: "Returns 150,000 characters", inputSchema: { type: "object" } },
  handler: () => ({ content: [{ type: "text", text: "x".repeat(150_000) }] }),
};

export const slow: FixtureTool = {
  tool: { name: "slow", description: "Sleeps for two seconds", inputSchema: { type: "object" } },
  handler: async () => {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    return { content: [{ type: "text", text: "finally" }] };
  },
};
