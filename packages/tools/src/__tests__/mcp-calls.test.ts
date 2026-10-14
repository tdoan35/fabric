// ANY-77 P9–P13 — calling discovered MCP tools through the registry's
// ToolPort against a real MCP server on 127.0.0.1: joined text and
// structuredContent, isError, media placeholders and truncation, the
// attachment check, and the call timeout.
import { afterEach, expect, test } from "vitest";
import { createRegistry } from "../index";
import { mcpClient, mcpToolDefs, type McpClient } from "../mcp";
import { startTestMcpServer, type FixtureTool, type TestMcpServer } from "./fixtures/mcp/server";
import { createIssue, failing, huge, screenshot, slow } from "./fixtures/mcp/tools";

const SCOPE = { workspaceId: "ws-mcp", streamId: "run:mcp", agentId: "agent-1" };

const open: { server?: TestMcpServer; client?: McpClient } = {};
afterEach(async () => {
  await open.client?.close();
  await open.server?.close();
  open.client = undefined;
  open.server = undefined;
});

/** A port over the server's tools, the scope's agent attached unless told otherwise. */
async function portFor(
  tools: readonly FixtureTool[],
  options: { attached?: readonly string[]; timeoutMs?: number } = {}
) {
  const server = (open.server = await startTestMcpServer({ tools }));
  const client = (open.client = mcpClient({ url: server.url }));
  const attached = options.attached ?? [SCOPE.agentId];
  const { defs } = mcpToolDefs(
    { name: "github", isAttached: async (agentId) => attached.includes(agentId) },
    await client.listTools(),
    (_server, name, args) =>
      client.callTool(name, args, options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
  );
  return { server, port: createRegistry(defs).toolPort(SCOPE) };
}

test("P9 a successful call → ok with the text blocks joined by blank lines and the structuredContent", async () => {
  const { port } = await portFor([createIssue]);
  const result = await port.run("mcp_github_create_issue", { repo: "acme/web", title: "Broken build" }, {});
  expect(result).toEqual({
    ok: true,
    result: {
      text: "created Broken build\n\nin acme/web",
      structuredContent: { number: 42, repo: "acme/web" },
    },
  });
});

test("P10 isError: true → ok false carrying the server's text", async () => {
  const { port } = await portFor([failing]);
  const result = await port.run("mcp_github_failing", {}, {});
  expect(result.ok).toBe(false);
  expect(result).toMatchObject({ error: expect.stringContaining("repository not found: acme/nope") });
});

test("P11 an image block becomes a placeholder line; 150,000 characters are cut with the right remainder", async () => {
  const { port } = await portFor([screenshot, huge]);

  const shot = await port.run("mcp_github_screenshot", {}, {});
  expect(shot).toEqual({ ok: true, result: { text: "here it is\n\n[image image/png, 10 bytes]" } });

  const big = await port.run("mcp_github_huge", {}, {});
  expect(big.ok).toBe(true);
  const text = (big as { result: { text: string } }).result.text;
  expect(text.slice(0, 100_000)).toBe("x".repeat(100_000));
  expect(text.slice(100_000)).toMatch(/^\s*\[truncated: 50000 more characters\]$/);
});

test("P12 an agent that isn't attached → ok false naming the server, and nothing is sent", async () => {
  const { server, port } = await portFor([createIssue], { attached: ["someone-else"] });
  const result = await port.run("mcp_github_create_issue", { repo: "acme/web", title: "x" }, {});
  expect(result).toEqual({ ok: false, error: "mcp server github is not attached to this agent" });
  expect(server.calls("tools/call")).toBe(0);
});

test("P13 a tool that sleeps past timeoutMs: 200 → ok false saying it timed out", async () => {
  const { port } = await portFor([slow], { timeoutMs: 200 });
  const started = Date.now();
  const result = await port.run("mcp_github_slow", {}, {});
  expect(result.ok).toBe(false);
  expect(result).toMatchObject({ error: expect.stringMatching(/timed out/) });
  expect(Date.now() - started).toBeLessThan(1_500);
});
