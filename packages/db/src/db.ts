// DB client: one pg Pool + Drizzle per process. The server uses DATABASE_URL (pooled);
// migrations and seed use DATABASE_URL_UNPOOLED / a --branch URL resolved through the neon CLI.
import path from "node:path";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export interface Db {
  pool: pg.Pool;
  db: NodePgDatabase<typeof schema>;
  close(): Promise<void>;
}

/** Loads the repo-root .env (idempotent); shell variables keep winning over file values. */
export function loadRootEnv(): void {
  try {
    process.loadEnvFile(path.resolve(import.meta.dirname, "../../../.env"));
  } catch {
    // No .env: callers must provide DATABASE_URL themselves.
  }
}

export function createDb(databaseUrl = process.env.DATABASE_URL): Db {
  if (!databaseUrl) throw new Error("DATABASE_URL is not set (seed/sim: load the root .env or pass --branch)");
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
    max: 10,
  });
  return { pool, db: drizzle(pool, { schema }), async close() { await pool.end(); } };
}
