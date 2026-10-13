// The encrypted-table backend (ANY-44 T4, D4) on the runtime's RuntimeStore:
// secrets at rest in `vault_secrets`, AES-256-GCM with a fresh 12-byte nonce
// per write, the key HKDF-SHA256-derived from the master key with info
// `fabric-vault-v1`, and the AAD binding each row to `<workspaceId>:<name>`
// so a moved row fails to decrypt. The table is the vault's own DDL — the
// runtime's migrations are untouched. Values never appear in SQL other than
// as ciphertext, in errors, or in list().
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { RuntimeStore } from "@fabric/runtime";
import {
  agentsAllow,
  assertValidVaultName,
  VaultDenied,
  VaultMissing,
  type Vault,
  type VaultAgents,
  type VaultEntry,
} from "./vault";

const HKDF_INFO = Buffer.from("fabric-vault-v1", "utf8");
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** The vault's own schema, idempotent; safe to call on every boot. */
export async function ensureVaultSchema(store: RuntimeStore): Promise<void> {
  await store.transaction((tx) =>
    tx.query(`create table if not exists vault_secrets (
      workspace_id text not null,
      name text not null,
      nonce bytea not null,
      ciphertext bytea not null,
      agents text not null,
      description text,
      updated_at timestamptz not null,
      primary key (workspace_id, name)
    )`)
  );
}

function derivedKey(masterKey: Uint8Array): Buffer {
  return Buffer.from(hkdfSync("sha256", masterKey, Buffer.alloc(0), HKDF_INFO, KEY_BYTES));
}

function encrypt(
  masterKey: Uint8Array,
  workspaceId: string,
  name: string,
  value: string
): { nonce: Buffer; ciphertext: Buffer } {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", derivedKey(masterKey), nonce);
  cipher.setAAD(Buffer.from(`${workspaceId}:${name}`, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return { nonce, ciphertext };
}

/** Throws on a wrong key, tampered bytes or a moved row (GCM auth failure) —
 * never returns plaintext or garbage. */
function decrypt(
  masterKey: Uint8Array,
  workspaceId: string,
  name: string,
  nonce: Uint8Array,
  sealed: Uint8Array
): string {
  if (sealed.length < TAG_BYTES) {
    throw new Error(`ciphertext for ${workspaceId}:${name} is too short to authenticate`);
  }
  const body = sealed.subarray(0, sealed.length - TAG_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", derivedKey(masterKey), nonce);
  decipher.setAAD(Buffer.from(`${workspaceId}:${name}`, "utf8"));
  decipher.setAuthTag(Buffer.from(tag));
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

// -- driver row narrowing -----------------------------------------------------
// pg and PGlite hand back `unknown` columns; these check what they read.

function byteaOf(value: unknown, column: string): Buffer {
  if (!(value instanceof Uint8Array)) {
    throw new Error(`vault_secrets.${column}: expected bytea, got ${typeof value}`);
  }
  return Buffer.from(value);
}

function textOf(value: unknown, column: string): string {
  if (typeof value !== "string") {
    throw new Error(`vault_secrets.${column}: expected text, got ${typeof value}`);
  }
  return value;
}

function epochOf(value: unknown): number {
  if (!(value instanceof Date)) {
    throw new Error(`vault_secrets.updated_at: expected timestamptz, got ${typeof value}`);
  }
  return value.getTime();
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function agentsOf(value: unknown): VaultAgents {
  const parsed: unknown = JSON.parse(textOf(value, "agents"));
  if (parsed === "all" || isStringArray(parsed)) return parsed;
  throw new Error("vault_secrets.agents: bad agents JSON");
}

/** A vault over `vault_secrets`, scoped to one workspace. Call
 * `ensureVaultSchema` first; the vault never runs DDL per operation. */
export function encryptedTableVault(
  store: RuntimeStore,
  workspaceId: string,
  masterKey: Uint8Array
): Vault {
  return {
    async put(name, value, { agents, description }) {
      assertValidVaultName(name);
      const { nonce, ciphertext } = encrypt(masterKey, workspaceId, name, value);
      await store.transaction((tx) =>
        tx.query(
          `insert into vault_secrets (workspace_id, name, nonce, ciphertext, agents, description, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7)
           on conflict (workspace_id, name) do update set
             nonce = excluded.nonce,
             ciphertext = excluded.ciphertext,
             agents = excluded.agents,
             description = excluded.description,
             updated_at = excluded.updated_at`,
          [workspaceId, name, nonce, ciphertext, JSON.stringify(agents), description ?? null, new Date()]
        )
      );
    },

    async get(name, { agentId }) {
      return store.transaction(async (tx) => {
        const rows = await tx.query(
          `select agents, nonce, ciphertext from vault_secrets
           where workspace_id = $1 and name = $2`,
          [workspaceId, name]
        );
        const row = rows[0];
        if (row === undefined) throw new VaultMissing(name);
        const agents = agentsOf(row.agents);
        if (!agentsAllow(agents, agentId)) throw new VaultDenied(name);
        return decrypt(
          masterKey,
          workspaceId,
          name,
          byteaOf(row.nonce, "nonce"),
          byteaOf(row.ciphertext, "ciphertext")
        );
      });
    },

    async list(): Promise<VaultEntry[]> {
      const rows = await store.transaction((tx) =>
        tx.query(
          `select name, agents, description, updated_at from vault_secrets
           where workspace_id = $1 order by name`,
          [workspaceId]
        )
      );
      return rows.map((row) => ({
        name: textOf(row.name, "name"),
        agents: agentsOf(row.agents),
        description: typeof row.description === "string" ? row.description : undefined,
        updatedAt: epochOf(row.updated_at),
        source: "table" as const,
      }));
    },

    async delete(name) {
      await store.transaction((tx) =>
        tx.query(`delete from vault_secrets where workspace_id = $1 and name = $2`, [
          workspaceId,
          name,
        ])
      );
    },
  };
}
