// Server config (WORK-PLAN §4.9). Every integration is optional so the server boots with an empty .env;
// features check their own keys. Shell variables win over the root .env (per-worktree ports).
import path from "node:path";
import { z } from "zod";

try {
  process.loadEnvFile(path.resolve(import.meta.dirname, "../../../.env"));
} catch {
  // No .env: defaults only.
}

const flag = z.enum(["on", "off"]).default("off");

export const env = z.object({
  PORT: z.coerce.number().int().default(8787),
  /** The web dev server's port, for the default CORS origins. */
  VITE_PORT: z.coerce.number().int().default(3000),
  /** Comma-separated. Defaults to the local web origin plus Electron's app://fabric. */
  CORS_ORIGINS: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  AI_GATEWAY_URL: z.string().optional(),
  AI_GATEWAY_KEY: z.string().optional(),
  LLM_FALLBACK_PROVIDER: z.string().optional(),
  LLM_FALLBACK_KEY: z.string().optional(),
  SPRITES_TOKEN: z.string().optional(),
  EXA_API_KEY: z.string().optional(),
  AGENTMAIL_API_KEY: z.string().optional(),
  EXECUTOR_URL: z.string().optional(),
  EXECUTOR_KEY: z.string().optional(),
  DANA_MODE: z.enum(["live", "fixture"]).default("live"),
  FEATURE_AGENTMAIL: flag,
  FEATURE_EXECUTOR: flag,
  DEMO_RECORDING_KEY: z.string().default("ngram-135m"),
  OWNER_EMAIL: z.string().optional(),
  SEED_PROFILE: z.enum(["demo", "lived-in"]).default("demo"),
}).parse(process.env);

export const corsOrigins = env.CORS_ORIGINS
  ? env.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
  : [`http://localhost:${env.VITE_PORT}`, `http://127.0.0.1:${env.VITE_PORT}`, "app://fabric"];
