// Throwaway: inspect/clean stray rows on the .env branch. `npx tsx scripts/db-admin.ts [--clean]`
import { sql } from "drizzle-orm";
import { createDb, loadRootEnv } from "@fabric/db";

const clean = process.argv.includes("--clean");
loadRootEnv();
const db = createDb();
const strays = await db.db.execute(sql`
  select 'task' as kind, id, title from tasks where id not in ('ngram-135m', 'ngram-360m', 'nand-probe', 'product-bet')
  union all
  select 'run', id, coalesce(task_id, '') from runs where id not in ('run-ngram-1', 'run-ngram360-1', 'run-nand-1', 'run-nand-2') and task_id is not null
  union all
  select 'weave', id, kind from weave_items where id like 'result-%'`);
console.log("strays:", JSON.stringify(strays.rows));
if (clean) {
  for (const r of strays.rows as { kind: string; id: string }[]) {
    if (r.kind === "task") {
      await db.db.execute(sql`delete from run_events where run_id in (select id from runs where task_id = ${r.id})`);
      await db.db.execute(sql`delete from context_snapshots where run_id in (select id from runs where task_id = ${r.id})`);
      await db.db.execute(sql`delete from artifacts where run_id in (select id from runs where task_id = ${r.id})`);
      await db.db.execute(sql`delete from runs where task_id = ${r.id}`);
      await db.db.execute(sql`delete from tasks where id = ${r.id}`);
    } else if (r.kind === "run") {
      await db.db.execute(sql`delete from run_events where run_id = ${r.id}`);
      await db.db.execute(sql`delete from runs where id = ${r.id}`);
    } else {
      await db.db.execute(sql`delete from weave_items where id = ${r.id}`);
    }
  }
  console.log("cleaned");
}
await db.close();
