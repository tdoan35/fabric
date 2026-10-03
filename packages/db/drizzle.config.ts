// drizzle-kit config. Migrations run against the *unpooled* URL (WORK-PLAN §4.9):
//   DATABASE_URL_UNPOOLED=$(grep ... .env) npm run migrate -w @fabric/db
// `neon link`/`--branch` write both; seed.ts resolves them through the neon CLI when needed.
import "dotenv/config";
import { defineConfig } from "drizzle-kit";

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL_UNPOOLED (or DATABASE_URL) is required for migrations");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: { url },
  verbose: true,
  strict: true,
});
