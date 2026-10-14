// ANY-77 P1–P2 — MCP server records and per-agent attachments on the
// runtime store, both drivers via @fabric/runtime/testing (PGlite always,
// Postgres when RUNTIME_TEST_DATABASE_URL is set — the CI leg).
import { expect, test } from "vitest";
import { describeDrivers } from "@fabric/runtime/testing";
import { ensureMcpSchema, mcpServers } from "../mcp";

const WORKSPACE = "ws-mcp";

describeDrivers("tools mcp servers (ANY-77)", (h) => {
  test("P1 add rejects bad names, non-https URLs and duplicates, naming the rule; accepts https and loopback http", async () => {
    const store = await h.openStore();
    await ensureMcpSchema(store);
    await ensureMcpSchema(store);
    const servers = mcpServers(store, WORKSPACE);

    const nameRule = /\^\[a-z\]\[a-z0-9\]\{0,19\}\$/;
    await expect(servers.add({ name: "Bad", url: "https://a.example", auth: "none" })).rejects.toThrow(nameRule);
    await expect(servers.add({ name: "a_b", url: "https://a.example", auth: "none" })).rejects.toThrow(nameRule);
    await expect(
      servers.add({ name: "a".repeat(21), url: "https://a.example", auth: "none" })
    ).rejects.toThrow(nameRule);
    await expect(
      servers.add({ name: "plain", url: "http://example.com", auth: "none" })
    ).rejects.toThrow(/https:/);

    const github = await servers.add({ name: "github", url: "https://mcp.github.example/mcp", auth: "oauth" });
    expect(github).toMatchObject({ name: "github", auth: "oauth", status: "needs_auth", lastError: null });
    const local = await servers.add({ name: "local", url: "http://127.0.0.1:4318/mcp", auth: "none" });
    expect(local).toMatchObject({ name: "local", status: "ready" });

    await expect(
      servers.add({ name: "github", url: "https://other.example/mcp", auth: "none" })
    ).rejects.toThrow(/already exists/);

    expect((await servers.list()).map((server) => server.name).sort()).toEqual(["github", "local"]);
    expect(await servers.get("github")).toMatchObject({ url: "https://mcp.github.example/mcp" });
    expect(await servers.get("nope")).toBeUndefined();

    await servers.setStatus("local", "error", "connection refused");
    expect(await servers.get("local")).toMatchObject({ status: "error", lastError: "connection refused" });
    await servers.setStatus("local", "ready");
    expect(await servers.get("local")).toMatchObject({ status: "ready", lastError: null });

    // The records are per workspace.
    expect(await mcpServers(store, "ws-other").list()).toEqual([]);
  });

  test("P2 attach defaults to allowed; attachedAgents, serversFor and detach; remove drops attachments and cache", async () => {
    const store = await h.openStore();
    await ensureMcpSchema(store);
    const servers = mcpServers(store, WORKSPACE);
    await servers.add({ name: "github", url: "https://mcp.github.example/mcp", auth: "none" });
    await servers.add({ name: "linear", url: "https://mcp.linear.example/mcp", auth: "none" });

    await servers.attach("github", "dana");
    await servers.attach("github", "scout", "approval");
    await servers.attach("linear", "dana", "approval");

    expect(await servers.attachedAgents("github")).toEqual(
      expect.arrayContaining([
        { server: "github", agentId: "dana", access: "allowed" },
        { server: "github", agentId: "scout", access: "approval" },
      ])
    );
    expect(await servers.attachedAgents("github")).toHaveLength(2);
    expect(await servers.serversFor("dana")).toEqual(
      expect.arrayContaining([
        { server: "github", agentId: "dana", access: "allowed" },
        { server: "linear", agentId: "dana", access: "approval" },
      ])
    );
    expect(await servers.serversFor("dana")).toHaveLength(2);
    expect(await servers.isAttached("github", "scout")).toBe(true);
    expect(await servers.isAttached("linear", "scout")).toBe(false);

    await servers.detach("github", "scout");
    expect(await servers.attachedAgents("github")).toEqual([
      { server: "github", agentId: "dana", access: "allowed" },
    ]);
    expect(await servers.serversFor("scout")).toEqual([]);

    await expect(servers.attach("nope", "dana")).rejects.toThrow(/nope/);

    await servers.writeCache("github", [{ name: "create_issue", inputSchema: { type: "object" } }], new Date());
    expect(await servers.readCache("github")).toMatchObject({ stale: false, tools: [{ name: "create_issue" }] });

    await servers.remove("github");
    expect(await servers.get("github")).toBeUndefined();
    expect(await servers.attachedAgents("github")).toEqual([]);
    expect(await servers.serversFor("dana")).toEqual([
      { server: "linear", agentId: "dana", access: "approval" },
    ]);
    expect(await servers.readCache("github")).toBeUndefined();
  });
});
