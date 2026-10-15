// ANY-83 M3 — the listed cases N3, N4, N7, N8 and N9, verbatim from the card.
// The server half: the stamp renders the agent's skills index onto the system
// prompt (dana's role caps at 15 lines), incognito keeps index and tools, the
// import route validates its input and reports per-folder results, and a late
// import shows up through skills_list while the stamped run.created never
// moves. Embedded PGlite, temp dirs, no workers, no network.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, afterEach, test } from "vitest";
import { Hono } from "hono";
import { importSkills, SKILL_INDEX_HEADER } from "@fabric/memory/skills";
import type { SpecialistAgent } from "@fabric/agents/session";
import {
  getRuntime,
  sessionTurnDefinition,
  setRuntime,
  setSessionAgents,
  setSessionSkills,
  setSessionToolRegistry,
  startRuntime,
  workerPorts,
  type FabricRuntime,
} from "../runtime/bootstrap";
import { InProcessLiveBus } from "../runtime/live-bus";
import { sessions } from "../routes/sessions";
import { skills } from "../routes/skills";

const WORKSPACE = "local";
const FIXTURES = fileURLToPath(new URL("./fixtures/skills", import.meta.url));

const RESEARCHER: SpecialistAgent = {
  id: "researcher",
  name: "Renna",
  role: "Research",
  instructions: "# SOUL.md\n\nYou are the studio's researcher.",
};

const app = (): Hono => new Hono().route("/api", sessions).route("/api", skills);

const post = (pathName: string, body: unknown): Promise<Response> =>
  app().request(pathName, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

const importBody = (dir: string, agentId: string): Promise<Response> => post("/api/skills/import", { dir, agentId });

interface StoredEventLike {
  type: string;
  payload: Record<string, unknown>;
}

let dataDir: string | undefined;
let rt: FabricRuntime | undefined;

afterEach(async () => {
  setRuntime(undefined);
  setSessionToolRegistry(undefined);
  setSessionSkills(undefined);
  if (rt) await rt.stop();
  rt = undefined;
  if (dataDir !== undefined) {
    await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  }
});

const boot = async (): Promise<FabricRuntime> => {
  dataDir = await mkdtemp(path.join(tmpdir(), "fabric-m3-server-"));
  rt = await startRuntime(
    {
      RUNTIME_PGLITE_DIR: dataDir,
      MODEL_PORT: "test",
      FABRIC_MASTER_KEY_FILE: path.join(dataDir, "master.key"),
      FABRIC_WORK_DIR: path.join(dataDir, "work"),
    },
    { worker: false },
  );
  return rt;
};

const stamp = async (agentId: string, incognito = false): Promise<Record<string, unknown>> =>
  (await sessionTurnDefinition(agentId, { incognito })) as Record<string, unknown>;

// -- N3 ------------------------------------------------------------------------

test("N3 Stamp: the researcher's system carries the header and both index lines in name order; dana's caps at 15 lines with the +1 tail", async () => {
  setSessionAgents([RESEARCHER]);
  const runtime = await boot();
  await importSkills(runtime.skills, FIXTURES, { agentId: "researcher" });

  const researcher = await stamp("researcher");
  const system = String(researcher.system ?? "");
  expect(system).toContain(SKILL_INDEX_HEADER);
  const litLine = system.indexOf("- lit-review — ");
  const releaseLine = system.indexOf("- release-notes — ");
  expect(litLine).toBeGreaterThan(-1);
  expect(releaseLine).toBeGreaterThan(litLine);

  // dana: 16 imported skills, her role caps the index at 15 lines + the tail
  const many = await mkdtemp(path.join(tmpdir(), "fabric-m3-dana-"));
  try {
    for (let n = 1; n <= 16; n += 1) {
      const name = `skill-${String(n).padStart(2, "0")}`;
      await mkdir(path.join(many, name), { recursive: true });
      await writeFile(
        path.join(many, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: Skill number ${n} for the dana cap.\n---\n\n# ${name}\n\nBody ${n}.`,
      );
    }
    await importSkills(runtime.skills, many, { agentId: "dana" });

    const dana = await stamp("dana");
    const danaSystem = String(dana.system ?? "");
    expect(danaSystem).toContain(SKILL_INDEX_HEADER);
    // the index is the stamp's tail: count its lines from the header on
    const indexText = danaSystem.slice(danaSystem.indexOf(SKILL_INDEX_HEADER));
    expect(indexText.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(15);
    expect(indexText).toContain("+1 more: call skills_list");
  } finally {
    await rm(many, { recursive: true, force: true });
  }
});

// -- N4 ------------------------------------------------------------------------

test("N4 an incognito session for researcher still has the index and both tools", async () => {
  setSessionAgents([RESEARCHER]);
  const runtime = await boot();
  await importSkills(runtime.skills, FIXTURES, { agentId: "researcher" });

  const def = await stamp("researcher", true);
  expect(String(def.system ?? "")).toContain(SKILL_INDEX_HEADER);
  const tools = def.tools as string[];
  expect(tools).toContain("skills_list");
  expect(tools).toContain("skills_read");
});

// -- N7 ------------------------------------------------------------------------

test("N7 POST /skills/import with the fixture root creates both skills; again is unchanged; GET /agents/:id/skills lists them", async () => {
  setSessionAgents([RESEARCHER]);
  await boot();

  const first = await importBody(FIXTURES, "researcher");
  expect(first.status).toBe(200);
  const firstBody = (await first.json()) as {
    results: { folder: string; status: string }[];
    counts: { created: number; patched: number; unchanged: number; errors: number };
  };
  expect(firstBody.counts).toEqual({ created: 2, patched: 0, unchanged: 0, errors: 0 });
  expect(firstBody.results.map(({ folder, status }) => [folder, status])).toEqual([
    ["lit-review", "created"],
    ["release-notes", "created"],
  ]);

  const second = await importBody(FIXTURES, "researcher");
  expect(second.status).toBe(200);
  const secondBody = (await second.json()) as { counts: { unchanged: number } };
  expect(secondBody.counts.unchanged).toBe(2);

  const list = await app().request("/api/agents/researcher/skills");
  expect(list.status).toBe(200);
  const rows = (await list.json()) as { name: string; description: string; version: number }[];
  expect(rows.map(({ name }) => name)).toEqual(["lit-review", "release-notes"]);
  expect(rows[0]).toMatchObject({ name: "lit-review", version: 1 });
  expect(rows.every(({ description, version }) => typeof description === "string" && version === 1)).toBe(true);
});

// -- N8 ------------------------------------------------------------------------

test("N8 dir relative → 400; dir missing → 400; an unknown agent → 404; nothing is written in any of the three", async () => {
  setSessionAgents([RESEARCHER]);
  await boot();
  const relative = await importBody("fixtures/skills", "researcher");
  expect(relative.status).toBe(400);

  const missing = await importBody(path.join(tmpdir(), "fabric-m3-no-such-dir"), "researcher");
  expect(missing.status).toBe(400);

  const unknown = await importBody(FIXTURES, "ghost");
  expect(unknown.status).toBe(404);

  const list = await app().request("/api/agents/researcher/skills");
  expect(list.status).toBe(200);
  expect(await list.json()).toEqual([]);
});

// -- N9 ------------------------------------------------------------------------

test("N9 a skill imported after the session is created: skills_list serves it in that session, and the run.created definition is unchanged", async () => {
  setSessionAgents([RESEARCHER]);
  const runtime = await boot();

  const created = await post("/api/sessions", { agentId: "researcher" });
  expect(created.status).toBe(200);
  const { sessionId } = (await created.json()) as { sessionId: string };
  const streamId = `session:${sessionId}`;

  const eventsBefore = (await runtime.store.readStream(streamId, { workspaceId: WORKSPACE })) as unknown as StoredEventLike[];
  const runBefore = eventsBefore.find((event) => event.type === "run.created")?.payload.definition;

  const imported = await importBody(FIXTURES, "researcher");
  expect(imported.status).toBe(200);

  // the stamped definition never moves: byte-stable for the provider cache
  const eventsAfter = (await runtime.store.readStream(streamId, { workspaceId: WORKSPACE })) as unknown as StoredEventLike[];
  const runAfter = eventsAfter.find((event) => event.type === "run.created")?.payload.definition;
  expect(runAfter).toEqual(runBefore);

  // but the session's skills_list reads the live store: the late import is there
  const ports = workerPorts({ MODEL_PORT: "test" }, new InProcessLiveBus(), undefined, runtime.store, runtime.vault);
  const result = await ports.tools.run("skills_list", {}, { workspaceId: WORKSPACE, streamId, agentId: "researcher" });
  expect(result.ok).toBe(true);
  const value: unknown = result.result;
  const listed =
    typeof value === "object" && value !== null && "skills" in value && Array.isArray(value.skills)
      ? (value.skills as { name: string }[])
      : [];
  expect(listed.map(({ name }) => name)).toEqual(["lit-review", "release-notes"]);
});
