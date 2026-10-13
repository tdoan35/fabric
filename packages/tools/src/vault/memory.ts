// memoryVault (ANY-44 T4): the in-memory reference backend for tests — same
// contract as the encrypted table, no persistence, no crypto.
import {
  agentsAllow,
  assertValidVaultName,
  VaultDenied,
  VaultMissing,
  type Vault,
  type VaultAgents,
  type VaultEntry,
} from "./vault";

export function memoryVault(): Vault {
  const entries = new Map<
    string,
    { value: string; agents: VaultAgents; description?: string; updatedAt: number }
  >();

  return {
    async put(name, value, { agents, description }) {
      assertValidVaultName(name);
      entries.set(name, { value, agents, description, updatedAt: Date.now() });
    },

    async get(name, { agentId }) {
      const entry = entries.get(name);
      if (entry === undefined) throw new VaultMissing(name);
      if (!agentsAllow(entry.agents, agentId)) throw new VaultDenied(name);
      return entry.value;
    },

    async list(): Promise<VaultEntry[]> {
      return [...entries]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, entry]) => ({
          name,
          agents: entry.agents,
          description: entry.description,
          updatedAt: entry.updatedAt,
          source: "memory" as const,
        }));
    },

    async delete(name) {
      entries.delete(name);
    },
  };
}
