// agentmail.send: the tool side of S5. Phase 1 policy is "approval", so the wrapper denies it
// with "needs approval" (a Weave ask in phase 2); the run path exists for when that lands.
import { z } from "zod";
import type { ToolPolicy } from "@fabric/contracts";
import { agentMailClient, createInbox } from "../agentmail";
import { makeTool } from "../tool-context";
import type { ToolCtx } from "../tool-context";

export function agentMailSendTool(policy: ToolPolicy, ctx: ToolCtx) {
  return makeTool(
    {
      name: "agentmail.send",
      description: "Send an email from your inbox.",
      inputSchema: z.object({
        to: z.string().email().describe("The recipient's address"),
        subject: z.string().min(1),
        text: z.string().min(1).describe("The email body, plain text"),
      }),
      policy,
      summary: (i) => `email to ${i.to}: ${i.subject.slice(0, 60)}`,
      target: (i) => i.to,
      run: async (i) => {
        const client = agentMailClient();
        // The agent's own inbox (idempotent; phase 1 personas: Sana only).
        const address = await createInbox(ctx.actor, {}, client);
        if (!address) throw new Error(`no AgentMail inbox for ${ctx.actor}`);
        const inbox = (await client.inboxes.list({ limit: 100 })).inboxes.find((x) => x.email === address);
        if (!inbox) throw new Error(`AgentMail inbox ${address} vanished`);
        await client.inboxes.messages.send(inbox.inboxId, { to: i.to, subject: i.subject, text: i.text });
        return { sent: true, from: address, to: i.to };
      },
    },
    ctx,
  );
}
