// Generates packages/fixtures/src/recordings/ngram-135m.json from the mock 135M loop (D9).
// Throwaway: rerun only if fixtures/src/run.ts changes.
//   npx tsx scripts/make-fixture-recording.ts
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseRunEventPayload } from "@fabric/contracts";
import type { Report } from "@fabric/contracts";
import { report as reportFixture, run, runEvents, snapshots } from "@fabric/fixtures/run";

const artifactContent: Record<string, string> = {
  "plan.md": "# Plan — n-gram fusion on a 135M model\n\n(illustrative bundle; the mock loop's plan artifact)\n",
  "literature-survey.md": "# Literature survey\n\nRead 9 papers; Engram reports gains only above 1B parameters.\n(illustrative bundle)\n",
  "code-bundle.zip": "(illustrative bundle: binary placeholder for the mock loop's code bundle)\n",
  "eval-log.jsonl": '{"split":"heldout-v1","config":"fused λ=0.30","ppl":30.9}\n{"config":"baseline","ppl":34.2}\n',
};
const contentTypeFor = (name: string) =>
  name.endsWith(".zip") ? "application/zip" : name.endsWith(".md") ? "text/markdown" : "text/plain";

const { id: _reportId, runId: _reportRunId, ...reportBody } = reportFixture;
const report: Omit<Report, "id" | "runId"> & { idHint: string } = { ...reportBody, idHint: _reportId, kind: "illustrative" };

const bundle = {
  key: "ngram-135m",
  kind: "illustrative",
  exportedAt: new Date().toISOString(),
  run: {
    idHint: run.id,
    objective: run.objective,
    status: run.status,
    startedAt: run.startedAt,
    durationS: run.durationS,
    costUsd: run.costUsd,
    budget: run.budget,
    reworkBudget: run.reworkBudget,
    assistantTokens: run.assistantTokens,
    brief: run.brief,
    outcome: run.outcome,
  },
  events: runEvents.map(({ runId, seq, ...event }) => event),
  snapshots: snapshots.map(({ id, runId, ...snapshot }) => ({ ...snapshot, idHint: id })),
  artifacts: runEvents
    .filter((e) => e.type === "artifact.created")
    .map((e) => {
      const { name } = parseRunEventPayload("artifact.created", e.payload);
      return { name, by: e.actorAgentId ?? "", contentType: contentTypeFor(name), content: artifactContent[name] ?? `(illustrative bundle: ${name})\n` };
    }),
  report,
};

const out = path.resolve("packages/fixtures/src/recordings/ngram-135m.json");
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(bundle, null, 2) + "\n");
console.log(`snapshots carry idHints: ${bundle.snapshots[0].idHint}`);
