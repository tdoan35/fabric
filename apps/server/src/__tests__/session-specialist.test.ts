// ANY-59 S9 — the server half of the specialist session: the bootstrap stamps
// the specialist definition for any known non-Dana agent and the create route
// rejects an unknown agentId with 404 before any stream exists. Real route, real
// runtime store (embedded PGlite), no workers, no app database — the registry
// snapshot enters through the bootstrap's own seam.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { openStore, type RuntimeStore } from "@fabric/runtime";
import { expect, afterEach, test } from "vitest";
import { setSessionAgents } from "../runtime/bootstrap";
import { sessionTurnDefinition } from "../runtime/bootstrap";
import { type SpecialistAgent } from "@fabric/agents/session";
import { getRuntime, setRuntime, startRuntime, type FabricRuntime } from "../runtime/bootstrap";
import { sessions } from "../routes/sessions";

const WORKSPACE = "local";

/** The registry stub: two known agents; anything else is unknown. */
const RESEARCHER: SpecialistAgent = {
  id: "researcher",
  name: "Renna",
  role: "Research",
  instructions: "# SOUL.md\n\nYou are the studio's researcher. Answer with sources.",
  model: "Opus 5.5",
};

const WRITER: SpecialistAgent = {
  id: "writer",
  name: "Quill",
  role: "Copywriting",
  model: "Haiku 4.5",
};

setSessionAgents([RESEARCHER, WRITER]);

const app = (): Hono => new Hono().route("/api", sessions);

const postSession = async (body: unknown): Promise<Response> =>
  app().request("/api/sessions", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

const sessionStreams = async (store: RuntimeStore): Promise<string[]> => {
  const rows = await store.transaction(async (tx) =>
    tx.query("select id from streams where id like 'session:%' order by id"),
  );
  return (rows as { id: string }[]).map((row) => row.id);
};

let dataDir: string | undefined;
let rt: FabricRuntime | undefined;

afterEach(async () => {
  setRuntime(undefined);
  if (rt) await rt.stop();
  rt = undefined;
  if (dataDir !== undefined) {
    await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  }
});

const boot = async (): Promise<FabricRuntime> => {
  dataDir = await mkdtemp(path.join(tmpdir(), "fabric-s9-server-"));
  rt = await startRuntime({ RUNTIME_PGLITE_DIR: dataDir, MODEL_PORT: "test" }, { worker: false });
  return rt;
};

test("G5 POST /api/sessions with an unknown agentId 404s and creates no stream", async () => {
  const runtime = await boot();
  expect(await sessionStreams(runtime.store)).toEqual([]);

  const before = await sessionStreams(runtime.store);
  const response = await postSession({ agentId: "ghost" });
  expect(response.status).toBe(404);

  const after = await sessionStreams(runtime.store);
  expect(after).toEqual(before);
  expect(after).toEqual([]);
});

test("G5b a known specialist stamps the specialist definition; dana keeps hers", async () => {
  const runtime = await boot();

  const created = await postSession({ agentId: "researcher" });
  expect(created.status).toBe(200);
  const { sessionId } = (await created.json()) as { sessionId: string };

  const events = (await runtime.store.readStream(`session:${sessionId}`, {
    workspaceId: WORKSPACE,
  })) as unknown as { type: string; payload: Record<string, unknown> }[];
  const created$ = events.find((event) => event.type === "session.created");
  expect(created$?.payload).toMatchObject({ agentId: "researcher" });
  const run = events.find((event) => event.type === "run.created");
  expect(run).toBeDefined();
  const definition = (run!.payload.definition ?? {}) as Record<string, unknown>;
  expect(definition.userChosenAgent).toBe("researcher");
  expect(definition.system).toBe(RESEARCHER.instructions);
  expect(definition.tools).toEqual(["ask_user"]);

  // dana's stamp is untouched by the specialist path
  const dana = await sessionTurnDefinition("dana") as Record<string, unknown>;
  expect((dana.tools as string[]).includes("record_disposition")).toBe(true);
});
