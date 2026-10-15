// ANY-81 T14 — the listed cases J8..J9, verbatim from the card. The session
// ToolPort with the registry seam: a registry call's scope is exactly the io
// plus the runDir the caller's scope fn built, the pre-existing session tools
// are untouched, a missing agentId is a result — and vault denial is an error
// that carries the name, never the secret.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { openStore } from "@fabric/runtime";
import { expect, test } from "vitest";
import { createRegistry, defineTool, type ToolScope } from "@fabric/tools";
import { builtinTools } from "@fabric/tools/builtin";
import { memoryVault } from "@fabric/tools/vault";
import { sessionTools } from "../../assistant/session";

const WORKSPACE = "ws-t14";
const STREAM = "session:t14";

const registryIo = {
  onLine: () => {},
  callId: "c9",
  streamId: STREAM,
  workspaceId: WORKSPACE,
  agentId: "researcher",
};

// -- helpers -------------------------------------------------------------------

/** The proposal-store double: idempotent per (session, callId), the same
 * contract the db-backed store carries. */
function fakeProposalStore() {
  let next = 1;
  return {
    async record() {
      return { proposalId: `prop-${next++}`, created: true };
    },
    async world() {
      return { agents: [{ id: "elliot", name: "Elliot", role: "lead" }], pool: [] };
    },
  };
}

// -- J8 ------------------------------------------------------------------------

test("J8 a registry call's execute sees the io identity and the caller's runDir; the session tools are untouched; no agentId is a result", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "fabric-t14-port-"));
  const store = await openStore({ driver: "pglite", dataDir });
  try {
    const seen: Record<string, unknown>[] = [];
    const spy = defineTool({
      name: "scope_spy",
      description: "records the caller's scope",
      parameters: z.object({}),
      effect: "read",
      gate: "none",
      kind: "read",
      step: 0,
      execute(_args, ctx) {
        seen.push({ ...ctx.scope } as Record<string, unknown>);
        return { seen: true };
      },
    });
    const runDir = path.join(dataDir, "agents", "researcher");
    const port = sessionTools({
      recall: async (query: string) => [{ key: "k", value: query, source: "test" }],
      proposals: {
        store: fakeProposalStore(),
        loop: { store, workspace: WORKSPACE },
      },
      registry: {
        tools: createRegistry([spy]),
        scope: async (io) =>
          ({
            workspaceId: io.workspaceId,
            streamId: io.streamId,
            agentId: io.agentId,
            callId: io.callId,
            runDir,
            secret: async () => {
              throw new Error("no secret");
            },
          }) as ToolScope,
      },
    });

    // the registry path: io in, scope out, runDir from the caller's closure
    const ok = await port.run("scope_spy", {}, { ...registryIo });
    expect(ok).toEqual({ ok: true, result: { seen: true } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      workspaceId: WORKSPACE,
      streamId: STREAM,
      agentId: "researcher",
      callId: "c9",
      runDir,
    });

    // the pre-existing session tools, exactly as on main
    const recalled = await port.run("recall", { query: "weather" }, { callId: "r1", streamId: STREAM });
    expect(recalled.ok).toBe(true);
    const proposed = await port.run(
      "propose_team",
      { name: "Dig Team", purpose: "dig", roster: ["elliot"] },
      { callId: "p1", streamId: STREAM },
    );
    expect(proposed.ok).toBe(true);

    // a registry call without the session's agent
    const noAgent = await port.run("scope_spy", {}, {
      onLine: () => {},
      callId: "c10",
      streamId: STREAM,
      workspaceId: WORKSPACE,
    });
    expect(noAgent).toEqual({ ok: false, error: "session tools need the session's agent" });

    // the descriptors: the session's first, the registry's behind them
    expect(port.describe("recall")).toMatchObject({ name: "recall", effect: "read" });
    expect(port.describe("scope_spy")).toMatchObject({ name: "scope_spy", effect: "read" });
    expect(port.describe("not_a_tool")).toBeUndefined();
  } finally {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

// -- J9 ------------------------------------------------------------------------

test("J9 web_search reads exa from the vault through the scope; denial is a named error without the secret", async () => {
  const vault = memoryVault();
  const SECRET = "exa-secret-value-42";
  await vault.put("exa", SECRET, { agents: ["researcher"] });

  const searches: { query: string }[] = [];
  const fakeExa = {
    search: async (query: string, _options: unknown) => {
      searches.push({ query });
      return { results: [{ title: "Hit", url: "https://exa.test/x", highlights: ["snip"] }] };
    },
  };

  const registry = createRegistry(builtinTools({ sendFrom: "sana@agentmail.to" }));
  const port = sessionTools({
    recall: async () => [],
    registry: {
      tools: registry,
      // the production shape: the agent comes from the io, the vault behind an arrow
      scope: async (io) =>
        ({
          workspaceId: io.workspaceId,
          streamId: io.streamId,
          agentId: io.agentId,
          secret: (name: string) => vault.get(name, { agentId: io.agentId }),
          exa: fakeExa,
        }) as unknown as ToolScope,
    },
  });

  const run = (agentId: string) =>
    port.run("web_search", { query: "fabric agent" }, { ...registryIo, agentId });

  const researcher = await run("researcher");
    expect(researcher.ok).toBe(true);
  expect((researcher.result as { title: string }[])[0]).toMatchObject({ title: "Hit" });
  expect(searches).toHaveLength(1);

  const writer = await run("writer");
  expect(writer.ok).toBe(false);
  expect(writer.error).toBe("secret denied: exa");
  expect(writer.error).not.toContain(SECRET);
});
