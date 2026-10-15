// Server config. Every integration is optional so the server boots with an empty .env;
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
  /** Which model provider every agent uses: spark for dev, neon at the venue, openrouter as backup. */
  LLM_PROVIDER: z.enum(["spark", "openrouter", "neon"]).default("spark"),
  /** OpenAI-compatible vLLM lane on the DGX Spark, reached over the tailnet. The server doesn't enforce the key. */
  SPARK_BASE_URL: z.string().optional(),
  SPARK_API_KEY: z.string().optional(),
  SPARK_MODEL: z.string().default("qwen3.8-flash-next"),
  /** The name Mastra's openrouter/<model> and @openrouter/ai-sdk-provider read by default. */
  OPENROUTER_API_KEY: z.string().optional(),
  SPRITES_TOKEN: z.string().optional(),
  /** Pre-created Sprites (8 CPU, 8 GiB, no GPU): Jonah's sandbox and Sana's separate one (ARCH §9). */
  SPRITE_CODER: z.string().default("fabric-coder"),
  SPRITE_VALIDATOR: z.string().default("fabric-validator"),
  EXA_API_KEY: z.string().optional(),
  AGENTMAIL_API_KEY: z.string().optional(),
  EXECUTOR_URL: z.string().optional(),
  EXECUTOR_KEY: z.string().optional(),
  FEATURE_AGENTMAIL: flag,
  FEATURE_EXECUTOR: flag,
  DEMO_RECORDING_KEY: z.string().default("ngram-135m"),
  OWNER_EMAIL: z.string().optional(),
  SEED_PROFILE: z.enum(["demo", "lived-in"]).default("demo"),
  /** SCH: the 30s routines tick. Tests set off; the server defaults to on. */
  SCHEDULER: z.enum(["on", "off"]).default("on"),
  // -- S5 runtime (durable sessions) ----------------------------------------
  /** Direct (unpooled) Postgres for the event log and queue. Unset = PGlite. */
  RUNTIME_DATABASE_URL: z.string().optional(),
  /** PGlite data dir when RUNTIME_DATABASE_URL is unset. */
  RUNTIME_PGLITE_DIR: z.string().optional(),
  /** Worker job concurrency; the queue's per-workspace cap. */
  RUNTIME_CONCURRENCY: z.coerce.number().int().min(1).default(4),
  /** `ai` (the real port) | `test` (the echo double; refused when NODE_ENV=production). */
  MODEL_PORT: z.enum(["ai", "test"]).default("ai"),
  // -- T14 session tools (per-agent tools, vault, work dirs) -----------------
  /** Root of the per-agent work dirs: `agents/<id>` is created under it on
   * first tool call. Defaults to `.data/work`. */
  FABRIC_WORK_DIR: z.string().optional(),
  /** The vault's master key file; created 0600 on first boot. Defaults to
   * `.data/master.key`. */
  FABRIC_MASTER_KEY_FILE: z.string().optional(),
  /** The inbox identity `send` sends from; unset leaves `send` out of the
   * registry (the step-0 set then is empty and only the host tools load). */
  FABRIC_SEND_FROM: z.string().optional(),
  /** M7: the public origin MCP OAuth providers redirect back to
   * (`<origin>/api/mcp/oauth/callback`); unset =
   * http://localhost:<PORT>. Validated as a URL so a bad value fails at
   * boot; the mcp route reads the process env per request — the vault
   * reads its env fallbacks the same lazy way, because this object
   * snapshots at import — and drops any trailing slash. */
  FABRIC_PUBLIC_URL: z.string().url().optional(),
}).parse(process.env);

export const corsOrigins = env.CORS_ORIGINS
  ? env.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
  : [`http://localhost:${env.VITE_PORT}`, `http://127.0.0.1:${env.VITE_PORT}`, "app://fabric"];
