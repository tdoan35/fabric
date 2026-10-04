// Registry policy tests (§5.3 TOOLS 2): the wrapper emits tool.call on every call, tool.denied
// for blocked and approval-only policies with the model-facing error, and lets allowed tools run.
// A fake writer captures events; no sandbox, no network (network.fetch's blocked paths don't fetch).
import { describe, expect, it } from "vitest";
import type { RunEvent, RunEventPayloads, RunEventType } from "@fabric/contracts";
import { profileById } from "@fabric/fixtures/studio";
import type { RunWriter } from "@fabric/db";
import { toolNameOf } from "../names";
import { toolsFor } from "../tools-for";

function fakeWriter() {
  const events: RunEvent[] = [];
  const writer = {
    async emit<T extends RunEventType>(runId: string, type: T, actor: string | undefined, payload: RunEventPayloads[T]) {
      const e = { runId, seq: events.length + 1, t: 0, type, actorAgentId: actor, payload } as RunEvent;
      events.push(e);
      return e;
    },
  } as unknown as RunWriter;
  return { writer, events };
}

const ctx = (writer: RunWriter) => ({ runId: "run-1", step: "Prepare", writer });

describe("toolsFor policies", () => {
  it("keys the set for providers and maps back to canonical names", () => {
    const { writer } = fakeWriter();
    const jonah = toolsFor(profileById("jonah"), ctx(writer));
    expect(Object.keys(jonah.tools).every((k) => /^[a-zA-Z0-9_-]+$/.test(k))).toBe(true);
    expect(jonah.tools).toHaveProperty("sprite_exec");
    expect(toolNameOf("sprite_exec")).toBe("sprite.exec");
    expect(jonah.sandbox).toContain("fabric-coder");
  });

  it("a blocked tool emits tool.denied and returns an error to the model", async () => {
    const { writer, events } = fakeWriter();
    const jonah = toolsFor(profileById("jonah"), ctx(writer));
    const res = await jonah.tools.network_fetch!.execute!({ url: "https://files.example.org/x" }, {} as never);
    expect(res).toMatchObject({ ok: false });
    const denied = events.find((e) => e.type === "tool.denied");
    expect(denied?.payload).toEqual({ tool: "network.fetch", target: "files.example.org", reason: "not on the egress list" });
    expect(events[0]?.type).toBe("tool.call"); // every call, before the policy check
  });

  it("an approval-only tool is denied with 'needs approval' (phase 1)", async () => {
    const { writer, events } = fakeWriter();
    const sana = toolsFor(profileById("sana"), ctx(writer));
    const res = await sana.tools.agentmail_send!.execute!({ to: "someone@example.org", subject: "s", text: "t" }, {} as never);
    expect(res).toMatchObject({ ok: false });
    expect(events.find((e) => e.type === "tool.denied")?.payload).toMatchObject({ tool: "agentmail.send", reason: "needs approval" });
  });

  it("an allowed artifacts.write saves through the writer and reports the artifact id", async () => {
    const { writer, events } = fakeWriter();
    let saved: { name: string; by: string; content: string } | undefined;
    (writer as unknown as { saveArtifact: unknown }).saveArtifact = async (_runId: string, a: { name: string; by: string; content: string }) => {
      saved = a;
      return { id: "art-run-1-1" };
    };
    const megan = toolsFor(profileById("megan"), ctx(writer));
    const res = await megan.tools.artifacts_write!.execute!({ name: "survey.md", content: "# Survey" }, {} as never);
    expect(res).toMatchObject({ ok: true, artifactId: "art-run-1-1" });
    expect(saved).toMatchObject({ name: "survey.md", by: "megan" });
    expect(events.some((e) => e.type === "tool.call")).toBe(true);
  });

  it("policies mirror the agent row (including team.assign, whose tool is TEAM's)", () => {
    const { writer } = fakeWriter();
    const elliot = toolsFor(profileById("elliot"), ctx(writer));
    expect(elliot.policies).toEqual([
      { name: "artifacts.read", policy: "allowed" },
      { name: "workspace.write", policy: "allowed" },
      { name: "team.assign", policy: "allowed" },
    ]);
    expect(elliot.tools).not.toHaveProperty("team_assign"); // built by teamAssignTool with TEAM's callback
  });
});
