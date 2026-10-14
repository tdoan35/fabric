// ANY-77 P4–P8, P15 — discovered MCP tools as ordinary Fabric ToolDefs:
// names, descriptions, effect/kind/gate/step from annotations, T2's gate
// decisions, JSON Schema parameters (P7 against a real server on
// 127.0.0.1), skipped schemas and the per-attachment definition access.
import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { effectiveAccess, gateDecision } from "@fabric/core/policy";
import { createRegistry, defineTool } from "../index";
import { mcpClient, mcpDefinitionAccess, mcpToolDefs, type McpCall, type McpTool } from "../mcp";
import { startTestMcpServer } from "./fixtures/mcp/server";
import { broken, createIssue, getFile, setLabel } from "./fixtures/mcp/tools";

const SCOPE = { workspaceId: "ws-mcp", streamId: "run:mcp", agentId: "agent-1" };
const source = (name: string, attached: readonly string[] = [SCOPE.agentId]) => ({
  name,
  isAttached: async (agentId: string) => attached.includes(agentId),
});
const neverCalled: McpCall = async () => {
  throw new Error("the server must not be called");
};
const tool = (name: string, extra: Partial<McpTool> = {}): McpTool => ({
  name,
  inputSchema: { type: "object" },
  ...extra,
});
const hash6 = (name: string) => createHash("sha256").update(name).digest("hex").slice(0, 6);

test("P4 names: sanitised, prefixed, cut to 64, hash-suffixed on a clash; every def passes defineTool", () => {
  const long = "Very-Long.Tool_Name".repeat(5).slice(0, 90);
  expect(long).toHaveLength(90);
  const { defs, skipped } = mcpToolDefs(
    source("github"),
    [
      tool("create_issue"),
      tool("Get-File.Contents"),
      tool(long),
      tool("get file"),
      tool("get-file"),
      tool("a".repeat(90)),
      tool("A".repeat(90)),
    ],
    neverCalled
  );
  expect(skipped).toEqual([]);
  const names = defs.map((def) => def.name);
  expect(names[0]).toBe("mcp_github_create_issue");
  expect(names[1]).toBe("mcp_github_get_file_contents");
  expect(names[2]).toHaveLength(64);
  expect(names[2]!.startsWith("mcp_github_very_long_tool_namevery_long_tool_name")).toBe(true);
  expect(names[3]).toBe("mcp_github_get_file");
  expect(names[4]).toBe(`mcp_github_get_file_${hash6("get-file")}`);
  expect(names[5]).toBe(`mcp_github_${"a".repeat(64 - "mcp_github_".length)}`);
  expect(names[6]).toHaveLength(64);
  expect(names[6]!.endsWith(`_${hash6("A".repeat(90))}`)).toBe(true);

  for (const def of defs) {
    expect(() => defineTool({ ...def })).not.toThrow();
    expect(def.name.length).toBeLessThanOrEqual(64);
  }
  expect(() => createRegistry(defs)).not.toThrow();

  // Descriptions: "[server] " plus the description, else the title, cut to 1,024.
  const described = mcpToolDefs(
    source("github"),
    [
      tool("one", { description: "Does one thing", title: "One" }),
      tool("two", { title: "Two things" }),
      tool("three", { description: "d".repeat(2_000) }),
    ],
    neverCalled
  ).defs;
  expect(described[0]!.description).toBe("[github] Does one thing");
  expect(described[1]!.description).toBe("[github] Two things");
  expect(described[2]!.description).toHaveLength(1_024);
  expect(described[2]!.description.startsWith("[github] ddd")).toBe(true);
});

test("P5 annotations: readOnlyHint → read/read, idempotentHint → idempotent/external, none → once/external; gate mode, step 0", () => {
  const { defs } = mcpToolDefs(
    source("github"),
    [
      tool("reader", { annotations: { readOnlyHint: true } }),
      tool("setter", { annotations: { idempotentHint: true } }),
      tool("sender"),
      tool("both", { annotations: { readOnlyHint: true, idempotentHint: true } }),
      tool("explicit_write", { annotations: { readOnlyHint: false, idempotentHint: false } }),
    ],
    neverCalled
  );
  const shape = defs.map(({ name, effect, kind, gate, step }) => ({ name, effect, kind, gate, step }));
  expect(shape).toEqual([
    { name: "mcp_github_reader", effect: "read", kind: "read", gate: "mode", step: 0 },
    { name: "mcp_github_setter", effect: "idempotent", kind: "external", gate: "mode", step: 0 },
    { name: "mcp_github_sender", effect: "once", kind: "external", gate: "mode", step: 0 },
    { name: "mcp_github_both", effect: "read", kind: "read", gate: "mode", step: 0 },
    { name: "mcp_github_explicit_write", effect: "once", kind: "external", gate: "mode", step: 0 },
  ]);
});

test("P6 T2's gateDecision: read-only runs under auto_edits, once asks under auto_edits and runs under full_auto, approval always asks", () => {
  const { defs } = mcpToolDefs(
    source("github"),
    [tool("reader", { annotations: { readOnlyHint: true } }), tool("sender")],
    neverCalled
  );
  const [reader, sender] = defs as [(typeof defs)[number], (typeof defs)[number]];
  const decide = (def: typeof reader, access: "allowed" | "approval", mode: "ask" | "auto_edits" | "full_auto") =>
    gateDecision({ access, gate: def.gate, kind: def.kind, mode }).action;

  expect(decide(reader, "allowed", "auto_edits")).toBe("run");
  expect(decide(sender, "allowed", "auto_edits")).toBe("ask");
  expect(decide(sender, "allowed", "full_auto")).toBe("run");
  expect(decide(sender, "approval", "full_auto")).toBe("ask");
  expect(decide(reader, "approval", "full_auto")).toBe("ask");
  expect(decide(reader, "allowed", "ask")).toBe("ask");
});

test("P7 modelTools carries the server's properties and required list; invalid args never reach the server", async () => {
  const server = await startTestMcpServer({ tools: [createIssue, getFile] });
  const client = mcpClient({ url: server.url });
  try {
    const listed = await client.listTools();
    const { defs } = mcpToolDefs(source("github"), listed, (_server, name, args) => client.callTool(name, args));
    const registry = createRegistry(defs);

    const [declared] = registry.modelTools(["mcp_github_create_issue"]);
    const parameters = declared!.parameters as { properties?: Record<string, unknown>; required?: string[] };
    expect(Object.keys(parameters.properties ?? {}).sort()).toEqual(["body", "repo", "title"]);
    expect([...(parameters.required ?? [])].sort()).toEqual(["repo", "title"]);

    const port = registry.toolPort(SCOPE);
    const result = await port.run("mcp_github_create_issue", { repo: 7 }, {});
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: expect.stringMatching(/^invalid arguments/) });
    expect(server.calls("tools/call")).toBe(0);
  } finally {
    await client.close();
    await server.close();
  }
});

test("P8 a schema that doesn't convert is skipped with a reason; the other tools are still defined", () => {
  const { defs, skipped } = mcpToolDefs(
    source("github"),
    [createIssue.tool as McpTool, broken.tool as McpTool, setLabel.tool as McpTool],
    neverCalled
  );
  expect(defs.map((def) => def.name)).toEqual(["mcp_github_create_issue", "mcp_github_set_label"]);
  expect(skipped).toHaveLength(1);
  expect(skipped[0]!.name).toBe("broken");
  expect(skipped[0]!.reason).toMatch(/missing/);
});

test("P15 mcpDefinitionAccess gives each tool its attachment's access through T2's effectiveAccess", () => {
  const github = mcpToolDefs(source("github"), [tool("create_issue"), tool("list_issues")], neverCalled).defs;
  const linear = mcpToolDefs(source("linear"), [tool("save_issue")], neverCalled).defs;
  const notion = mcpToolDefs(source("notion"), [tool("search")], neverCalled).defs;
  const names = [...github, ...linear, ...notion].map((def) => def.name);

  const definition = mcpDefinitionAccess(
    [
      { server: "github", access: "allowed" },
      { server: "linear", access: "approval" },
    ],
    names
  );
  expect(definition).toEqual({
    mcp_github_create_issue: "allowed",
    mcp_github_list_issues: "allowed",
    mcp_linear_save_issue: "approval",
  });
  expect(effectiveAccess({ definition })).toEqual({
    mcp_github_create_issue: "allowed",
    mcp_github_list_issues: "allowed",
    mcp_linear_save_issue: "approval",
  });
  expect(
    effectiveAccess({ definition, workspace: { mcp_github_list_issues: "approval" } })
  ).toMatchObject({ mcp_github_create_issue: "allowed", mcp_github_list_issues: "approval" });
});
