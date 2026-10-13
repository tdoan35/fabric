// The Vault port (ANY-44 T4, decision D4): where credentials live, scoped to
// one workspace. One interface, several backends — the memory reference, the
// encrypted table on the runtime store, the OS keychain later (ANY-46) and
// the env fallback that wraps any of them. Values never leave `get`: errors
// carry the name only, and `list()` returns metadata, never secrets.
export const VAULT_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/** Who may read an entry: a list of agent ids, or every agent. */
export type VaultAgents = readonly string[] | "all";

/** Where an entry lives — which backend answered `list`. */
export type VaultSource = "memory" | "table" | "env";

export type VaultEntry = {
  name: string;
  agents: VaultAgents;
  description?: string;
  /** Epoch milliseconds of the last write; 0 for stateless sources. */
  updatedAt: number;
  source: VaultSource;
};

/** The entry is absent from this backend. Carries the name, never a value. */
export class VaultMissing extends Error {
  constructor(name: string) {
    super(`secret not found: ${name}`);
    this.name = "VaultMissing";
  }
}

/** The agent is not on the entry's agent list. Carries the name, never a value. */
export class VaultDenied extends Error {
  constructor(name: string) {
    super(`secret denied: ${name}`);
    this.name = "VaultDenied";
  }
}

export interface Vault {
  put(
    name: string,
    value: string,
    options: { agents: VaultAgents; description?: string }
  ): Promise<void>;
  /** The secret value; `VaultMissing` when absent, `VaultDenied` when the
   * agent isn't on the entry's list. */
  get(name: string, options: { agentId: string }): Promise<string>;
  /** Entry metadata in name order — never values. */
  list(): Promise<VaultEntry[]>;
  delete(name: string): Promise<void>;
}

/** Provider-safe secret names, same rule as tool names (T1). */
export function assertValidVaultName(name: string): void {
  if (!VAULT_NAME_PATTERN.test(name)) {
    throw new Error(
      `invalid secret name ${JSON.stringify(name)}: must match ^[a-z][a-z0-9_]*$`
    );
  }
}

/** `"all"` serves everyone; a list serves exactly its members. */
export function agentsAllow(agents: VaultAgents, agentId: string): boolean {
  return agents === "all" || agents.includes(agentId);
}
