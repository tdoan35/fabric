// POST /api/dev/tools (non-production): a sim-style scratch run that exercises the REAL tools —
// Megan's exa.search and Jonah's sprite.exec + a blocked network.fetch — through toolsFor with a
// real RunWriter, so the loop view streams exactly what a live start will (§5.3 TOOLS, DEV ROUTE).
import type { Db, RunWriter } from "@fabric/db";
import type { StudioProfile } from "@fabric/contracts";
import { myProfiles } from "@fabric/fixtures/studio";
import { studioTeams } from "@fabric/fixtures/teams";
import { RunClosedError, provisionTeam, readRegistry, sql } from "@fabric/db";
import { toolsFor } from "@fabric/integrations";

export interface DevToolsOptions {
  onRegistryChanged?: () => void;
  onTaskCreated?: (taskId: string, runId: string) => void;
  onDone?: (message: string) => void;
  /** The exa query; the mock's first live-start line. */
  query?: string;
}

const brief = {
  tokens: 60,
  objective: "Tools check: live search and sandboxed exec, streaming into the loop view.",
  constraints: ["Sandbox egress limited to the package index and the model host"],
  criteria: [],
  preferences: [],
  stayed: ["Your chat with Dana", "Dana's memory of you", "Your other threads and projects"],
};

/** Same world as the dev sim: the research team exists before the run references it. */
async function ensureTeam(db: Db): Promise<void> {
  const exists = await db.db.execute(sql`select 1 from teams where id = 'research'`);
  if (exists.rows.length) return;
  const team = studioTeams.find((t) => t.id === "research")!;
  const profiles = new Map(myProfiles.filter((p) => team.members.some((m) => m.agentId === p.agent.id)).map((p) => [p.agent.id, p]));
  await provisionTeam(db, {
    team,
    templates: Object.fromEntries(team.members.map((m) => [m.agentId, profiles.get(m.agentId)]).filter(([, p]) => p)),
    origin: "Created by dev tools check",
  });
}

export async function startDevToolsRun(db: Db, writer: RunWriter, options: DevToolsOptions = {}) {
  await ensureTeam(db);
  options.onRegistryChanged?.();
  const registry = await readRegistry(db);
  const jonah = registry.agents.find((a) => a.agent.id === "jonah");
  const megan = registry.agents.find((a) => a.agent.id === "megan");
  if (!jonah || !megan) throw new Error("dev tools run needs jonah and megan (seed the demo profile first)");

  const task = await writer.createTask({ projectId: "engram", teamId: "research", title: "Tools check · live search + sandbox" });
  const run = await writer.startRun(task.id, brief, { costUsd: 1, timeS: 600, rework: 1 });
  options.onTaskCreated?.(task.id, run.id);

  const done = (async () => {
    const startedWall = Date.now();
    try {
      await writer.emit(run.id, "step.started", "megan", { label: "Survey", stage: "Prepare", kind: "work" });
      await writer.emit(run.id, "step.started", "jonah", { label: "Setup", stage: "Prepare", kind: "work" });
      await Promise.all([meganLane(megan, run.id, writer, options.query), jonahLane(jonah, run.id, writer)]);
      await writer.emit(run.id, "step.finished", "megan", { label: "Survey", stage: "Prepare", kind: "work" });
      await writer.emit(run.id, "step.finished", "jonah", { label: "Setup", stage: "Prepare", kind: "work" });
      await writer.end(run.id, "stopped", "Dev tools check finished.");
    } catch (err) {
      if (err instanceof RunClosedError) return options.onDone?.("dev tools: run closed (spliced), stopping");
      throw err;
    }
    options.onDone?.(`dev tools: lanes done in ${((Date.now() - startedWall) / 1000).toFixed(1)}s; run ${run.id} stopped`);
  })();
  return { taskId: task.id, runId: run.id, done };
}

async function meganLane(megan: StudioProfile, runId: string, writer: RunWriter, query = "engram conditional memory n-gram lookup") {
  const { tools } = toolsFor(megan, { runId, step: "Prepare", writer });
  await tools.exa_search?.execute?.({ query, fast: true }, {} as never);
}

async function jonahLane(jonah: StudioProfile, runId: string, writer: RunWriter) {
  const { tools } = toolsFor(jonah, { runId, step: "Prepare", writer });
  await tools.sprite_exec?.execute?.({ command: "python3 --version && uv --version" }, {} as never);
  await tools.sprite_exec?.execute?.({ command: "for i in 1 2 3; do echo \"check $i/3\"; sleep 0.4; done" }, {} as never);
  await tools.workspace_write?.execute?.({ path: "tools-check.md", content: "# Tools check\n\nWritten by workspace.write.\n" }, {} as never);
  // The Tools-tab beat: a fetch the policy blocks (Jonah's row says network.fetch: blocked).
  await tools.network_fetch?.execute?.({ url: "https://files.example.org/pkg.tar.gz" }, {} as never);
}
