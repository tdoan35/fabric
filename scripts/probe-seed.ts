// Throwaway seed sanity probe (DATA): counts + parity spot-checks. `npx tsx scripts/probe-seed.ts`
import { createDb, getRunRow, loadRootEnv, listProjects, listRuns, listStoredEvents, listTasks, mergedEvents, readRegistry, readRun, readTask, readWeave } from "@fabric/db";

loadRootEnv();
const db = createDb();
const reg = await readRegistry(db);
console.log("agents", reg.agents.length, "community", reg.communityAgents.length, "teams", reg.teams.length, "communityTeams", reg.communityTeams.length);
console.log("orgs", reg.organizations.map((o) => `${o.id}[${o.slots.map((s) => s.key).join(",")}]`).join(" "));
console.log("personaPool", reg.personaPool.map((p) => p.id).join(",") || "(none)");
console.log("sessions", reg.sessions.length, "projects", reg.projects.map((p) => p.id).join(","));
const tasks = await listTasks(db);
console.log("tasks", tasks.map((t) => `${t.id}:${t.runIds.length}`).join(" "));
const runs = await listRuns(db);
console.log("runs", runs.map((r) => `${r.id}/${r.status}/${Math.round(r.durationS)}s/seg${r.segments.length}`).join(" "));
const events = await listStoredEvents(db, "run-ngram-1");
console.log("run-ngram-1 stored events", events.length, "first", events[0].type, "last", events[events.length - 1].type);
const run135 = await readRun(db, "run-ngram-1");
console.log("run135 recorded", run135?.recorded, "recording", JSON.stringify(run135?.recording), "reportId", run135?.reportId);
const weave = await readWeave(db);
console.log("weave items", weave.items.length, "pulse", weave.pulse.length, "presence", weave.presence.length, "calendar", weave.calendar.length);
console.log("projects", (await listProjects(db)).length);
const ngram360 = runs.find((r) => r.id === "run-ngram360-1");
console.log("run360 etaS", ngram360?.etaS, "segments", ngram360?.segments.length, "durationS", ngram360?.durationS);
console.log("nand-probe runIds", (await readTask(db, "nand-probe"))?.runIds.join(","));
const row = await getRunRow(db, "run-ngram-1");
const merged = row ? await mergedEvents(db, row) : [];
console.log("merged == stored for unspliced:", merged.length === events.length);
await db.close();
