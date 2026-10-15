// ANY-86 T10 — folder grants on the runtime store: the folder_grants table
// (package-owned DDL via ensureFoldersSchema), grant/revoke semantics and the
// mount list. Cases F5 and F6 from the card, on both store drivers.
import { expect, test } from "vitest";
import { describeDrivers } from "@fabric/runtime/testing";
import { ensureFoldersSchema, folderGrants } from "../folders";

describeDrivers("tools folder grants (ANY-86 T10)", (h) => {
  test("F5 grants: read default, re-grant changes access, revoke removes, and mountsFor puts the agent folder first then projects in name order", async () => {
    const store = await h.openStore();
    await ensureFoldersSchema(store);
    await ensureFoldersSchema(store); // idempotent, safe on every boot

    const grants = folderGrants(store, "ws-grants");

    await grants.grant("launch-plan", "researcher");
    await grants.grant("mkt-assets", "researcher", "read");
    expect(await grants.grantsFor("researcher")).toEqual([
      { project: "launch-plan", access: "read" },
      { project: "mkt-assets", access: "read" },
    ]);

    // Granting again changes the access; the row is updated, not duplicated.
    await grants.grant("launch-plan", "researcher", "write");
    expect(await grants.grantsFor("researcher")).toEqual([
      { project: "launch-plan", access: "write" },
      { project: "mkt-assets", access: "read" },
    ]);
    expect(await grants.agentsFor("launch-plan")).toEqual(["researcher"]);

    await grants.revoke("launch-plan", "researcher");
    expect(await grants.grantsFor("researcher")).toEqual([{ project: "mkt-assets", access: "read" }]);
    expect(await grants.agentsFor("launch-plan")).toEqual([]);

    // Mounts: the agent's own folder first with write, then projects in name order.
    await grants.grant("b-project", "scout", "write");
    await grants.grant("a-project", "scout", "read");
    expect(await grants.mountsFor("scout")).toEqual([
      { ref: { kind: "agent", name: "scout" }, access: "write" },
      { ref: { kind: "project", name: "a-project" }, access: "read" },
      { ref: { kind: "project", name: "b-project" }, access: "write" },
    ]);
    // An agent with no grants still mounts its own folder.
    expect(await grants.mountsFor("solo")).toEqual([
      { ref: { kind: "agent", name: "solo" }, access: "write" },
    ]);
  });

  test("F6 removeProject drops every grant for the project and leaves other projects untouched", async () => {
    const store = await h.openStore();
    await ensureFoldersSchema(store);
    const grants = folderGrants(store, "ws-grants");

    await grants.grant("proj-a", "one", "write");
    await grants.grant("proj-a", "two");
    await grants.grant("proj-b", "one");

    await grants.removeProject("proj-a");

    expect(await grants.grantsFor("one")).toEqual([{ project: "proj-b", access: "read" }]);
    expect(await grants.grantsFor("two")).toEqual([]);
    expect(await grants.agentsFor("proj-a")).toEqual([]);
    expect(await grants.agentsFor("proj-b")).toEqual(["one"]);
  });
});
