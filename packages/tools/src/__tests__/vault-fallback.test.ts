// ANY-69 T4 — the master-key file and the .env fallback (D4): a 32-byte key
// file with mode 0600 created on first read, strict on POSIX; envFallbackVault
// serving FABRIC_SECRET_* names to every agent when the inner vault misses.
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { envFallbackVault, loadOrCreateMasterKey, memoryVault, VaultMissing } from "../vault";

test("V10 loadOrCreateMasterKey creates a 32-byte 0600 file, re-reads the same key, and rejects 0644 mode or a 16-byte file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "vault-key-"));
  try {
    const keyPath = path.join(dir, "master.key");
    const created = await loadOrCreateMasterKey(keyPath);
    expect(created).toHaveLength(32);
    expect((await stat(keyPath)).mode & 0o777).toBe(0o600);

    const reread = await loadOrCreateMasterKey(keyPath);
    expect(Buffer.from(reread).equals(Buffer.from(created))).toBe(true);

    const loose = path.join(dir, "loose.key");
    await writeFile(loose, created);
    await chmod(loose, 0o644);
    await expect(loadOrCreateMasterKey(loose)).rejects.toThrow();

    const short = path.join(dir, "short.key");
    await writeFile(short, Buffer.alloc(16));
    await chmod(short, 0o600);
    await expect(loadOrCreateMasterKey(short)).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("V11 envFallbackVault: an inner miss falls back to FABRIC_SECRET_EXA, an inner hit wins over env, and list marks env entries", async () => {
  const inner = memoryVault();
  await inner.put("inner_key", "inner_value_1", { agents: "all" });
  await inner.put("shared", "from_inner_1", { agents: "all" });
  const env = {
    FABRIC_SECRET_EXA: "env_value_1",
    FABRIC_SECRET_SHARED: "from_env_1",
    UNRELATED_TOKEN: "not_a_fabric_secret",
  };
  const vault = envFallbackVault(inner, env);

  await expect(vault.get("exa", { agentId: "dana" })).resolves.toBe("env_value_1");
  await expect(vault.get("exa", { agentId: "researcher" })).resolves.toBe("env_value_1");
  await expect(vault.get("shared", { agentId: "dana" })).resolves.toBe("from_inner_1");
  await expect(vault.get("nope", { agentId: "dana" })).rejects.toBeInstanceOf(VaultMissing);

  const listed = await vault.list();
  const exa = listed.find((entry) => entry.name === "exa");
  expect(exa?.source).toBe("env");
  expect(exa?.agents).toBe("all");
  expect(listed.find((entry) => entry.name === "inner_key")?.source).toBe("memory");
  expect(listed.find((entry) => entry.name === "shared")?.source).toBe("memory");
});
