// @fabric/tools/vault (ANY-44 T4): the Vault port and its backends — the
// memory reference, the encrypted table on the runtime store, the master-key
// file, and the FABRIC_SECRET_* env fallback. Served through T1's subpath
// map; src/index.ts and package.json stay untouched.
export {
  agentsAllow,
  assertValidVaultName,
  VAULT_NAME_PATTERN,
  VaultDenied,
  VaultMissing,
  type Vault,
  type VaultAgents,
  type VaultEntry,
  type VaultSource,
} from "./vault";
export { memoryVault } from "./memory";
export { encryptedTableVault, ensureVaultSchema } from "./encrypted-table";
export { envFallbackVault } from "./env";
export { loadOrCreateMasterKey } from "./master-key";
