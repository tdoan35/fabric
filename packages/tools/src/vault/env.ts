// The .env fallback (ANY-44 T4, D4) for self-hosters: envFallbackVault wraps
// any backend and serves `FABRIC_SECRET_<NAME>` variables to every agent when
// the inner backend misses. Writes and deletes always go to the inner vault —
// the environment is read-only.
import {
  VAULT_NAME_PATTERN,
  VaultMissing,
  type Vault,
  type VaultEntry,
} from "./vault";

const ENV_PREFIX = "FABRIC_SECRET_";

/** FABRIC_SECRET_EXA serves the secret named `exa`. */
function envNameOf(key: string): string | null {
  if (!key.startsWith(ENV_PREFIX)) return null;
  const name = key.slice(ENV_PREFIX.length).toLowerCase();
  return VAULT_NAME_PATTERN.test(name) ? name : null;
}

export function envFallbackVault(
  inner: Vault,
  env: Record<string, string | undefined>
): Vault {
  const envEntries = (): VaultEntry[] => {
    const entries: VaultEntry[] = [];
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) continue;
      const name = envNameOf(key);
      if (name === null) continue;
      entries.push({ name, agents: "all", updatedAt: 0, source: "env" });
    }
    return entries;
  };

  return {
    put: (name, value, options) => inner.put(name, value, options),
    delete: (name) => inner.delete(name),

    async get(name, { agentId }) {
      try {
        return await inner.get(name, { agentId });
      } catch (error) {
        if (error instanceof VaultMissing) {
          const fromEnv = env[ENV_PREFIX + name.toUpperCase()];
          if (fromEnv !== undefined) return fromEnv;
        }
        throw error;
      }
    },

    async list() {
      const listed = await inner.list();
      const innerNames = new Set(listed.map((entry) => entry.name));
      return [...listed, ...envEntries().filter((entry) => !innerNames.has(entry.name))];
    },
  };
}
