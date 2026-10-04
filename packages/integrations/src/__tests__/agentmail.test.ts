// AgentMail unit tests with a mocked client (S5): idempotent createInbox (the account allows 3),
// the persona guard, the connector recording, and the report email's shape and from-fallback.
// No network: the fake client below is the whole API surface these functions use.
import { describe, expect, it, vi } from "vitest";
import type { Report } from "@fabric/contracts";
import { OWNER_INBOX, renderReportEmail, sendReportEmail } from "../agentmail";
import { createInbox } from "../agentmail";
import type { AgentMailLike } from "../agentmail";

const SANA = { inboxId: "in-sana", email: "sana-fabric@agentmail.to" };
const OWNER = { inboxId: "in-owner", email: OWNER_INBOX };

function fakeClient(inboxes: { inboxId: string; email: string }[], onCreate?: (username: string) => void): AgentMailLike {
  return {
    inboxes: {
      list: vi.fn(async () => ({ inboxes })),
      create: vi.fn(async (req: { username: string }) => {
        onCreate?.(req.username);
        const inbox = { inboxId: `in-${req.username}`, email: `${req.username}@agentmail.to` };
        inboxes.push(inbox);
        return inbox;
      }),
      messages: { send: vi.fn(async () => ({})) },
    },
  };
}

describe("createInbox (S5, mocked)", () => {
  it("creates Sana's inbox once and finds it on the second call", async () => {
    const created: string[] = [];
    const client = fakeClient([OWNER], (u) => created.push(u));
    const first = await createInbox("sana", {}, client);
    const second = await createInbox("sana", {}, client);
    expect(first).toBe("sana-fabric@agentmail.to");
    expect(second).toBe(first);
    expect(created).toEqual(["sana-fabric"]); // idempotent: the lookup found it the second time
    expect(client.inboxes.list).toHaveBeenCalledTimes(2);
  });

  it("creates nothing for agents without a phase-1 persona", async () => {
    const client = fakeClient([OWNER]);
    await expect(createInbox("elliot", {}, client)).resolves.toBe("");
    expect(client.inboxes.create).not.toHaveBeenCalled();
  });
});

describe("sendReportEmail (mocked)", () => {
  const report: Report = {
    id: "report-r1", runId: "r1", title: "n-gram fusion on a 135M model",
    intro: "Intro line.", summary: "The fused model wins.",
    results: [
      { config: "baseline", ppl: 34.2, delta: "—", valid: true },
      { config: "fused λ=0.30", ppl: 19.8, delta: "-42%", valid: true },
    ],
    caveats: ["Overlap was fixed after rework."],
    provenance: [{ label: "Loop", value: "Loop 1" }],
    madeBy: ["jonah", "sana"], artifacts: [{ name: "code-bundle.zip", from: "jonah" }],
    emailed: false, kind: "real",
  };

  it("sends from Sana's inbox with the report rendered as text", async () => {
    const client = fakeClient([OWNER, SANA]);
    await sendReportEmail(report, "owner@example.com", client);
    expect(client.inboxes.messages.send).toHaveBeenCalledWith(
      SANA.inboxId,
      expect.objectContaining({ to: "owner@example.com", subject: expect.stringContaining("n-gram fusion") }),
    );
    const text = vi.mocked(client.inboxes.messages.send).mock.calls[0][1].text;
    expect(text).toContain("fused λ=0.30: ppl 19.8 (-42%)");
    expect(text).toContain("Overlap was fixed after rework.");
    expect(text).toContain("code-bundle.zip");
  });

  it("falls back to the owner's inbox when Sana's doesn't exist", async () => {
    const client = fakeClient([OWNER]);
    await sendReportEmail(report, "owner@example.com", client);
    expect(client.inboxes.messages.send).toHaveBeenCalledWith(OWNER.inboxId, expect.anything());
  });

  it("throws when no inbox exists at all (finalize logs and keeps the report in chat)", async () => {
    const client = fakeClient([]);
    await expect(sendReportEmail(report, "owner@example.com", client)).rejects.toThrow(/no AgentMail inbox/);
  });
});

describe("renderReportEmail", () => {
  it("covers every section, also for an empty report", () => {
    const { subject, text } = renderReportEmail({
      id: "r", runId: "run", title: "T", intro: "I", summary: "S", results: [], caveats: [],
      provenance: [], madeBy: [], artifacts: [], emailed: false, kind: "illustrative",
    });
    expect(subject).toBe("Fabric · T");
    expect(text).toContain("no numeric results");
    expect(text).toContain("Run run");
  });
});
