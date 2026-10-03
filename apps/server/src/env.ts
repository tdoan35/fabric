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
  /** Pooled. `neon link` / `neon checkout` write these three for the linked branch. */
  DATABASE_URL: z.string().optional(),
  /** Direct (unpooled): use for migrations. */
  DATABASE_URL_UNPOOLED: z.string().optional(),
  NEON_BRANCH: z.string().optional(),
  /** Neon's own names, so Mastra `neon/<model>` and @neon/ai-sdk-provider read them with no config. Paid plan only. */
  NEON_AI_GATEWAY_BASE_URL: z.string().optional(),
  NEON_AI_GATEWAY_TOKEN: z.string().optional(),
  /** Which model provider every agent uses (WORK-PLAN §4.9): spark for dev, neon at the venue, openrouter as backup. */
  LLM_PROVIDER: z.enum(["spark", "openrouter", "neon"]).default("spark"),
  /** OpenAI-compatible vLLM lane on the DGX Spark, reached over the tailnet. The server doesn't enforce the key. */
  SPARK_BASE_URL: z.string().optional(),
  SPARK_API_KEY: z.string().optional(),
  SPARK_MODEL: z.string().default("qwen3.8-flash-next"),
  /** The name Mastra's openrouter/<model> and @openrouter/ai-sdk-provider read by default. */
  OPENROUTER_API_KEY: z.string().optional(),
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
