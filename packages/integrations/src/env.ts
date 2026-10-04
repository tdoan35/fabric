// Integration config: the root .env, loaded once. Keys are read by their own modules only
// (each key goes to exactly one provider); nothing here is ever printed.
import { loadRootEnv } from "@fabric/db";

let loaded = false;

function ensure(): NodeJS.ProcessEnv {
  if (!loaded) {
    loadRootEnv();
    loaded = true;
  }
  return process.env;
}

export function env(key: "SPRITES_TOKEN" | "SPRITE_CODER" | "SPRITE_VALIDATOR" | "EXA_API_KEY" | "AGENTMAIL_API_KEY" | "EXECUTOR_URL" | "EXECUTOR_KEY"): string | undefined {
  return ensure()[key];
}

/** True when the value is present and non-empty — for flags like EXECUTOR probes. */
export function envSet(key: Parameters<typeof env>[0]): boolean {
  return !!env(key)?.trim();
}
