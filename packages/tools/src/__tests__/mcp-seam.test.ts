// ANY-77 P16 — the seam with the runtime: a registry port over discovered
// MCP tools, passed as `tools` to handleToolExecJob on the PGlite driver.
// The `tool.call` payload carries no effect, so the handler falls back to
// describe's; the attachment check runs inside the handler's transaction
// (R13 nests it as a savepoint), and tool.completed carries the server's
// result.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import {
  append,
  handleToolExecJob,
  MemoryQueue,
  openStore,
  type EventInput,
} from "@fabric/runtime";
import { createRegistry } from "../index";
import { discover, ensureMcpSchema, mcpClient, mcpServers } from "../mcp";
import { startTestMcpServer } from "./fixtures/mcp/server";
import { createIssue } from "./fixtures/mcp/tools";

const WORKSPACE = "ws-mcp-seam";
const SCOPE = { workspaceId: WORKSPACE, streamId: "run:mcp", agentId: "agent-1" };
const TOOL = "mcp_local_create_issue";

test("P16 an MCP tool behind handleToolExecJob (PGlite): describe supplies the effect and tool.completed carries the server's result", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "tools-mcp-seam-"));
  const store = await openStore({ driver: "pglite", dataDir: dir });
  const server = await startTestMcpServer({ tools: [createIssue] });
  const client = mcpClient({ url: server.url });
  try {
    await ensureMcpSchema(store);
    const servers = mcpServers(store, WORKSPACE);
    await servers.add({ name: "local", url: server.url, auth: "none" });
    await servers.attach("local", SCOPE.agentId);

    const { tools: defs } = await discover(servers, client, "local");
    const tools = createRegistry(defs).toolPort(SCOPE);
    expect(tools.describe(TOOL)?.effect).toBe("once");

    const runCreated: EventInput = {
      type: "run.created",
      actor: "api",
      payload: {
        definition: { systemPrompt: "SYS", tools: [TOOL] },
        engineVersion: "v1",
        brief: "",
        grants: [TOOL],
        budgets: {},
        parent: null,
      },
    };
    const toolCalled: EventInput = {
      type: "tool.call",
      actor: "decide",
      payload: {
        tool: TOOL,
        summary: "file the issue",
        callId: "c1",
        args: { repo: "acme/web", title: "Broken build" },
      },
    };
    await store.transaction((tx) =>
      append(tx, WORKSPACE, [{ streamId: SCOPE.streamId, events: [runCreated, toolCalled] }])
    );

    const queue = new MemoryQueue();
    await store.transaction((tx) =>
      queue.enqueue(tx, {
        type: "tool.exec",
        key: `${SCOPE.streamId}:c1`,
        streamId: SCOPE.streamId,
        workspaceId: WORKSPACE,
      })
    );
    const lease = await queue.claim("worker-1", ["tool.exec"], 0);
    expect(lease).not.toBeNull();
    await handleToolExecJob(lease!, { store, queue, tools, now: () => 0 });

    const events = await store.readStream(SCOPE.streamId, { workspaceId: WORKSPACE });
    const completed = events.filter((event) => event.type === "tool.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]!.payload).toMatchObject({
      callId: "c1",
      ok: true,
      result: {
        text: "created Broken build\n\nin acme/web",
        structuredContent: { number: 42, repo: "acme/web" },
      },
    });
    expect(server.calls("tools/call")).toBe(1);
  } finally {
    await client.close();
    await server.close();
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
