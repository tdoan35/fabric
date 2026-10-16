// ANY-90 T12 — B9, the daemon-backed case: a profile saved from a real T8
// sandbox (dockerSandboxes) comes back with its changes in a fresh sandbox.
// Skip rule as in sandbox-docker.test.ts: skipped with a printed reason only
// when `docker info` fails and CI is unset; in CI a missing daemon fails.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";
import { openStore } from "@fabric/runtime";
import { localFolders } from "../folders";
import { loadOrCreateMasterKey } from "../vault";
import { dockerSandboxes } from "../sandbox";
import { browserProfiles, ensureBrowserProfilesSchema } from "../browser-profiles";


const run = promisify(execFile);

const daemonOk = await run("docker", ["info", "--format", "ok"]).then(
  () => true,
  (error: unknown) => {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    console.log(`[browser-profiles] docker daemon unreachable (${reason})`);
    return false;
  }
);

const withoutDaemon = !daemonOk && process.env.CI === undefined;
if (withoutDaemon) {
  console.log(
    "[browser-profiles] skipping B9: `docker info` failed and CI is unset; run it on a machine with the daemon"
  );
}

const docker = test.skipIf(withoutDaemon);
const PROFILE_DIR = "/home/fabric/.config/chromium";

docker("B9 docker: a change saved from one sandbox reaches a fresh sandbox", { timeout: 180_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bprofile-b9-db-"));
  const root = await mkdtemp(path.join(tmpdir(), "bprofile-b9-"));
  const store = await openStore({ driver: "pglite", dataDir });
  const provider = dockerSandboxes();

  try {
    await ensureBrowserProfilesSchema(store);
    const masterKeyPath = path.join(root, "master.key");
    const profiles = browserProfiles({
      store,
      workspaceId: "ws-b9",
      folders: localFolders(root),
      masterKey: await loadOrCreateMasterKey(masterKeyPath),
    });

    const { lease } = await profiles.checkout("owner", { holder: "b9" });
    const first = await provider.acquire({ workspaceId: "ws-b9", agentId: "browser-a" });

    await profiles.loadInto(lease, first, PROFILE_DIR);
    await first.exec(`printf b9-marker-7311 > ${PROFILE_DIR}/marker.txt`);
    await profiles.saveFrom(lease, first, PROFILE_DIR);

    // A fresh sandbox (different agent, so a different container) sees the change.
    const second = await provider.acquire({ workspaceId: "ws-b9", agentId: "browser-b" });
    await profiles.loadInto(lease, second, PROFILE_DIR);
    const readBack = await second.exec(`cat ${PROFILE_DIR}/marker.txt`);
    expect(readBack.exitCode).toBe(0);
    expect(readBack.tail.join("\n")).toContain("b9-marker-7311");
  } finally {
    await provider.stopAll();
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
