/**
 * Weave live-payload smoke (MOB-B): the server's GET /api/weave through the list's pure logic —
 * contracts validation, kind grouping/order, action href classification, time formatting.
 * Needs the server on :8787. Run from apps/mobile with any tsx, e.g. the root install:
 *   ../../node_modules/.bin/tsx scripts/weave-smoke.mts
 * The read-model WeaveSnapshotSchema is deliberately loose (it strips rich fields), so the
 * fields asserted here get their own schema — no unchecked casts on network data.
 */
import { z } from "zod";
import { WeaveSnapshotSchema } from "@fabric/contracts";
import { groupByKind, hrefTarget, KIND_META } from "../components/weave/group";
import { age, waited } from "../components/weave/format";

const base = (process.env.EXPO_PUBLIC_API_URL || "http://localhost:8787").replace(/\/$/, "");
const snapshot: unknown = await (await fetch(`${base}/api/weave`)).json();

const contract = WeaveSnapshotSchema.safeParse(snapshot);
console.log("WeaveSnapshotSchema:", contract.success ? "ok" : `MISMATCH ${JSON.stringify(contract.error!.issues.slice(0, 3))}`);
if (!contract.success) process.exit(1);

const itemSchema = z.object({
  id: z.string(),
  kind: z.enum(["approval", "question", "escalation", "proposal", "finding", "result"]),
  agentId: z.string(),
  title: z.string(),
  why: z.string(),
  at: z.string(),
  unread: z.boolean().optional(),
  reportId: z.string().optional(),
  blocking: z.object({ step: z.string(), agentId: z.string(), since: z.string() }).optional(),
  actions: z
    .array(
      z.object({
        id: z.string(),
        href: z.string().optional(),
        effect: z.object({ outcome: z.string() }).optional(),
      }),
    )
    .min(1),
});
const { items } = z.object({ items: z.array(itemSchema) }).parse(snapshot);

for (const item of items) {
  age(item.at); // throws on a bad stamp
  if (item.blocking) waited(item.blocking.since);
}

const groups = groupByKind(items);
console.log("groups:", groups.map((g) => `${g.kind}(${g.data.length})`).join(" "));
const kinds = new Set(groups.map((g) => g.kind));
const expected = ["approval", "question", "escalation", "proposal", "finding", "result"] as const;
if (!expected.every((k) => kinds.has(k))) {
  console.log("MISSING kinds:", expected.filter((k) => !kinds.has(k)));
  process.exit(1);
}

const approvals = groups.find((g) => g.kind === "approval")!.data.map((i) => i.id);
if (approvals.join(",") !== "fetch-shard,email-priya") {
  console.log("approval order not newest-first:", approvals.join(","));
  process.exit(1);
}

const reports: string[] = [];
const desktop: string[] = [];
for (const item of items) {
  for (const action of item.actions) {
    if (!action.href) {
      if (!action.effect?.outcome) {
        console.log(`resolving action without effect.outcome: ${item.id}/${action.id}`);
        process.exit(1);
      }
      continue;
    }
    const target = hrefTarget(action.href);
    if (target.type === "report") reports.push(`${item.id}→/report/${target.reportId}`);
    else desktop.push(`${item.id}:${action.href}`);
  }
}
console.log("report hrefs:", reports.join(" "));
console.log("desktop hrefs:", desktop.join(" "));
if (!reports.includes("report-135m→/report/report-ngram-1")) {
  console.log("the demo-beat result item does not classify as a report link");
  process.exit(1);
}

const result = items.find((i) => i.kind === "result")!;
if (!result.reportId || !result.unread) {
  console.log("result item missing reportId/unread:", result.id);
  process.exit(1);
}
console.log("result beat:", KIND_META.result.label, "·", result.title);
console.log("SMOKE OK —", items.length, "items, all 6 kinds");
