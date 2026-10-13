// ANY-69 T4 — the Vault port, workspace-scoped (ANY-44 D4): where credentials
// live. Cases V1–V3 cover the reference implementation, memoryVault: the
// round-trip, the agent scope, and the name rule.
import { expect, test } from "vitest";
import { memoryVault, VaultDenied, VaultMissing } from "../vault";

const AGENT = { agentId: "dana" };

test("V1 memoryVault put → get round-trips; get of an unknown name throws VaultMissing", async () => {
  const vault = memoryVault();
  await vault.put("exa_key", "sekrit_value_1", { agents: "all" });
  await expect(vault.get("exa_key", AGENT)).resolves.toBe("sekrit_value_1");
  await expect(vault.get("nope", AGENT)).rejects.toBeInstanceOf(VaultMissing);
});

test("V2 agent scope: agents [\"dana\"] serves dana and denies researcher; \"all\" serves any agent", async () => {
  const vault = memoryVault();
  await vault.put("github_pat", "gh_secret_1", { agents: ["dana"] });
  await expect(vault.get("github_pat", AGENT)).resolves.toBe("gh_secret_1");
  await expect(vault.get("github_pat", { agentId: "researcher" })).rejects.toBeInstanceOf(
    VaultDenied
  );

  await vault.put("shared", "open_value", { agents: "all" });
  await expect(vault.get("shared", { agentId: "researcher" })).resolves.toBe("open_value");
});

test("V3 invalid names (GitHub, a.b, \"\") are rejected on put", async () => {
  const vault = memoryVault();
  for (const name of ["GitHub", "a.b", ""]) {
    await expect(vault.put(name, "value_1", { agents: "all" })).rejects.toThrow();
  }
});
