// ANY-77 P3, P14 — discovery against a real MCP server on 127.0.0.1: the
// tools/list cache (24 h, `stale`, `refresh`) and list_changed marking it
// stale. Both drivers via @fabric/runtime/testing.
import { afterEach, expect, test, vi } from "vitest";
import { describeDrivers } from "@fabric/runtime/testing";
import { discover, ensureMcpSchema, mcpClient, mcpServers, type McpClient } from "../mcp";
import { startTestMcpServer, type TestMcpServer } from "./fixtures/mcp/server";
import { createIssue, getFile, setLabel } from "./fixtures/mcp/tools";

const WORKSPACE = "ws-mcp-discover";
const HOUR = 60 * 60 * 1000;
const T0 = Date.parse("2026-10-14T00:00:00Z");

const open: { server?: TestMcpServer; client?: McpClient } = {};
afterEach(async () => {
  await open.client?.close();
  await open.server?.close();
  open.client = undefined;
  open.server = undefined;
});

describeDrivers("tools mcp discover (ANY-77)", (h) => {
  test("P3 three tools over two pages are cached; the cache answers within 24 h; refresh and a 25 h-later clock list again", async () => {
    const server = (open.server = await startTestMcpServer({
      tools: [createIssue, getFile, setLabel],
      pageSize: 2,
    }));
    const store = await h.openStore();
    await ensureMcpSchema(store);
    const servers = mcpServers(store, WORKSPACE);
    await servers.add({ name: "local", url: server.url, auth: "none" });
    const client = (open.client = mcpClient({ url: server.url }));

    const first = await discover(servers, client, "local", { now: () => T0 });
    expect(first.tools.map((tool) => tool.name).sort()).toEqual([
      "mcp_local_create_issue",
      "mcp_local_get_file_contents",
      "mcp_local_set_label",
    ]);
    expect(first.skipped).toEqual([]);
    expect(server.calls("tools/list")).toBe(2); // one listing, two pages
    const cached = await servers.readCache("local");
    expect(cached?.tools.map((tool) => tool.name)).toEqual(["create_issue", "Get-File.Contents", "set_label"]);
    expect(cached?.stale).toBe(false);

    const second = await discover(servers, client, "local", { now: () => T0 + HOUR });
    expect(second.tools).toHaveLength(3);
    expect(server.calls("tools/list")).toBe(2);

    await discover(servers, client, "local", { refresh: true, now: () => T0 + 2 * HOUR });
    expect(server.calls("tools/list")).toBe(4);

    await discover(servers, client, "local", { now: () => T0 + 2 * HOUR + 25 * HOUR });
    expect(server.calls("tools/list")).toBe(6);
  });

  test("P14 notifications/tools/list_changed marks the cache stale, and the next discover lists again", async () => {
    const server = (open.server = await startTestMcpServer({ tools: [createIssue, setLabel] }));
    const store = await h.openStore();
    await ensureMcpSchema(store);
    const servers = mcpServers(store, WORKSPACE);
    await servers.add({ name: "local", url: server.url, auth: "none" });
    const client = (open.client = mcpClient({ url: server.url }));

    await discover(servers, client, "local");
    expect(server.calls("tools/list")).toBe(1);
    expect((await servers.readCache("local"))?.stale).toBe(false);

    // Notifications ride the standalone GET stream; send once it is open.
    await vi.waitFor(() => expect(server.streams()).toBeGreaterThan(0), { timeout: 2_000 });
    await server.listChanged();
    await vi.waitFor(async () => expect((await servers.readCache("local"))?.stale).toBe(true), {
      timeout: 2_000,
    });

    await discover(servers, client, "local");
    expect(server.calls("tools/list")).toBe(2);
    expect((await servers.readCache("local"))?.stale).toBe(false);
  });
});
