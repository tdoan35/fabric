// ANY-69 T4 — the encrypted-table backend on the runtime store, both drivers
// via @fabric/runtime/testing (PGlite always, Postgres when
// RUNTIME_TEST_DATABASE_URL is set — the CI leg). AES-256-GCM with a random
// nonce per write, HKDF-SHA256 key with info fabric-vault-v1, and AAD
// binding each row to <workspaceId>:<name>. Row columns are read through
// runtime narrowing helpers — DB drivers hand back unknown.
import { expect, test } from "vitest";
import { describeDrivers } from "@fabric/runtime/testing";
import {
  encryptedTableVault,
  ensureVaultSchema,
  VaultDenied,
  VaultMissing,
} from "../vault";

const WORKSPACE = "ws-vault";
const OTHER_WORKSPACE = "ws-vault-other";
const AGENT = { agentId: "dana" };
const KEY_A = Buffer.from("a".repeat(32), "utf8");
const KEY_B = Buffer.from("b".repeat(32), "utf8");

/** bytea columns: Buffer on pg, Uint8Array on PGlite — both pass this check. */
function bytesOf(value: unknown, column: string): Buffer {
  if (!(value instanceof Uint8Array)) {
    throw new Error(`vault_secrets.${column} is not bytea: ${typeof value}`);
  }
  return Buffer.from(value);
}

function textOf(value: unknown, column: string): string {
  if (typeof value !== "string") {
    throw new Error(`vault_secrets.${column} is not text: ${typeof value}`);
  }
  return value;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function dateOf(value: unknown): Date {
  if (!(value instanceof Date)) {
    throw new Error(`vault_secrets.updated_at is not a timestamp: ${typeof value}`);
  }
  return value;
}

describeDrivers("tools vault encrypted table (ANY-69 T4)", (h) => {
  test("V4 the table vault round-trips on both drivers, and ensureVaultSchema twice is harmless", async () => {
    const store = await h.openStore();
    await ensureVaultSchema(store);
    await ensureVaultSchema(store);

    const vault = encryptedTableVault(store, WORKSPACE, KEY_A);
    await vault.put("exa_key", "table_secret_1", { agents: "all" });
    await expect(vault.get("exa_key", AGENT)).resolves.toBe("table_secret_1");
  });

  test("V5 at rest: no plaintext bytes in ciphertext, and two puts of one value differ in nonce and ciphertext", async () => {
    const store = await h.openStore();
    await ensureVaultSchema(store);
    const vault = encryptedTableVault(store, WORKSPACE, KEY_A);
    await vault.put("exa_key", "reused_value_9", { agents: "all" });
    await vault.put("other_key", "reused_value_9", { agents: "all" });

    const rows = await store.transaction((tx) =>
      tx.query(
        "select name, nonce, ciphertext from vault_secrets where workspace_id = $1 order by name",
        [WORKSPACE]
      )
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const ciphertext = bytesOf(row.ciphertext, "ciphertext");
      expect(ciphertext.includes(Buffer.from("reused_value_9"))).toBe(false);
    }
    const [first, second] = rows;
    expect(bytesOf(first.nonce, "nonce").equals(bytesOf(second.nonce, "nonce"))).toBe(false);
    expect(bytesOf(first.ciphertext, "ciphertext").equals(bytesOf(second.ciphertext, "ciphertext"))).toBe(
      false
    );
  });

  test("V6 a wrong master key makes get throw, never return plaintext or garbage", async () => {
    const store = await h.openStore();
    await ensureVaultSchema(store);
    await encryptedTableVault(store, WORKSPACE, KEY_A).put("exa_key", "secret_x_1", {
      agents: "all",
    });

    const wrongKey = encryptedTableVault(store, WORKSPACE, KEY_B);
    await expect(wrongKey.get("exa_key", AGENT)).rejects.toThrow();
  });

  test("V7 tamper: flipping one ciphertext byte makes get throw (GCM auth failure)", async () => {
    const store = await h.openStore();
    await ensureVaultSchema(store);
    const vault = encryptedTableVault(store, WORKSPACE, KEY_A);
    await vault.put("exa_key", "tamper_me_1", { agents: "all" });

    await store.transaction(async (tx) => {
      const rows = await tx.query(
        "select ciphertext from vault_secrets where workspace_id = $1 and name = $2",
        [WORKSPACE, "exa_key"]
      );
      const tampered = bytesOf(rows[0]?.ciphertext, "ciphertext");
      tampered[0] = tampered[0]! ^ 0xff;
      await tx.query(
        "update vault_secrets set ciphertext = $3 where workspace_id = $1 and name = $2",
        [WORKSPACE, "exa_key", tampered]
      );
    });

    await expect(vault.get("exa_key", AGENT)).rejects.toThrow();
  });

  test("V8 AAD binding: a row copied to another name or another workspace fails to decrypt", async () => {
    const store = await h.openStore();
    await ensureVaultSchema(store);
    const vault = encryptedTableVault(store, WORKSPACE, KEY_A);
    await vault.put("src_name", "bound_value_1", { agents: "all" });

    const rows = await store.transaction((tx) =>
      tx.query(
        "select nonce, ciphertext, agents, description, updated_at from vault_secrets where workspace_id = $1 and name = $2",
        [WORKSPACE, "src_name"]
      )
    );
    const source = rows[0];
    if (source === undefined) throw new Error("expected the seeded src_name row");
    const copiedRow = [
      WORKSPACE,
      "dst_name",
      bytesOf(source.nonce, "nonce"),
      bytesOf(source.ciphertext, "ciphertext"),
      textOf(source.agents, "agents"),
      textOrNull(source.description),
      dateOf(source.updated_at),
    ];
    const copiedOther = [
      OTHER_WORKSPACE,
      "src_name",
      bytesOf(source.nonce, "nonce"),
      bytesOf(source.ciphertext, "ciphertext"),
      textOf(source.agents, "agents"),
      textOrNull(source.description),
      dateOf(source.updated_at),
    ];

    await store.transaction(async (tx) => {
      await tx.query(
        "insert into vault_secrets (workspace_id, name, nonce, ciphertext, agents, description, updated_at) values ($1, $2, $3, $4, $5, $6, $7)",
        copiedRow
      );
      await tx.query(
        "insert into vault_secrets (workspace_id, name, nonce, ciphertext, agents, description, updated_at) values ($1, $2, $3, $4, $5, $6, $7)",
        copiedOther
      );
    });

    await expect(vault.get("dst_name", AGENT)).rejects.toThrow();
    const otherVault = encryptedTableVault(store, OTHER_WORKSPACE, KEY_A);
    await expect(otherVault.get("src_name", AGENT)).rejects.toThrow();
  });

  test("V9 list returns names, agents and descriptions and never values — list JSON and error messages stay clean", async () => {
    const store = await h.openStore();
    await ensureVaultSchema(store);
    const vault = encryptedTableVault(store, WORKSPACE, KEY_A);
    await vault.put("alpha", "alpha_secret_value", {
      agents: ["dana"],
      description: "the alpha key",
    });
    await vault.put("beta", "beta_secret_value", { agents: "all" });

    const listed = await vault.list();
    const json = JSON.stringify(listed);
    expect(json).not.toContain("alpha_secret_value");
    expect(json).not.toContain("beta_secret_value");

    const alpha = listed.find((entry) => entry.name === "alpha");
    expect(alpha?.agents).toEqual(["dana"]);
    expect(alpha?.description).toBe("the alpha key");
    expect(typeof alpha?.updatedAt).toBe("number");
    expect(alpha?.source).toBe("table");
    expect(listed.map((entry) => entry.name)).toEqual(["alpha", "beta"]);

    const missing = await vault.get("nope", AGENT).catch((error: unknown) => error);
    const denied = await vault.get("alpha", { agentId: "intruder" }).catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(VaultMissing);
    expect(denied).toBeInstanceOf(VaultDenied);
    expect(JSON.stringify([missing, denied])).not.toContain("alpha_secret_value");
    expect(JSON.stringify([missing, denied])).not.toContain("beta_secret_value");
  });

  test("V12 delete removes the entry: get then throws VaultMissing and list no longer shows it", async () => {
    const store = await h.openStore();
    await ensureVaultSchema(store);
    const vault = encryptedTableVault(store, WORKSPACE, KEY_A);
    await vault.put("doomed", "doomed_value_1", { agents: "all" });

    await vault.delete("doomed");
    await expect(vault.get("doomed", AGENT)).rejects.toBeInstanceOf(VaultMissing);
    expect((await vault.list()).map((entry) => entry.name)).not.toContain("doomed");
  });
});
