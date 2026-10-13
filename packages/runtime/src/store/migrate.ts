// Plain .sql migrations, applied in filename order, identically on both drivers.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter } from "./adapter";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

export async function migrate(adapter: Adapter): Promise<void> {
  await adapter.query(
    "create table if not exists runtime_migrations (name text primary key, applied_at timestamptz not null default now())"
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of files) {
    const applied = await adapter.query("select 1 from runtime_migrations where name = $1", [name]);
    if (applied.length > 0) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
    await adapter.exec(sql);
    await adapter.query("insert into runtime_migrations (name) values ($1)", [name]);
  }
}
