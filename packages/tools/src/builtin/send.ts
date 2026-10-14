// send (ANY-72, ANY-44 D1 step 0, PRODUCT §8.3): external email through
// AgentMail. `once` + `always`: a human approves the send, and the provider
// call carries the idempotency key derived from the call id, so the approval
// retry cannot duplicate it. The inbox is the factory's `sendFrom`. Failures
// throw: the registry turns a throw into `{ ok: false, error }`.
import { z } from "zod";
import { defineTool } from "../define";
import type { ToolScope } from "../define";
import { defaultClients, type AgentMailLike } from "./clients";

/** The scope may carry a ready `agentmail` client (test injection); else the
 * default constructor builds one per call from the vault key. */
const mailFor = (scope: ToolScope, key: string): AgentMailLike => {
  const injected = (scope as Record<string, unknown>).agentmail as AgentMailLike | undefined;
  return injected ?? defaultClients.agentmail(key);
};

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface SendDeps {
  /** The inbox the factory sends from (e.g. `sana-fabric@agentmail.to`). */
  sendFrom: string;
}

export const sendTool = ({ sendFrom }: SendDeps) =>
  defineTool({
    name: "send",
    description:
      "Send one plain-text email from the agent's inbox. External send: always asks first, and retries reuse the same idempotency key.",
    parameters: z.object({
      to: z.string().email().describe("Recipient address"),
      subject: z.string().min(1).max(998).describe("Subject line"),
      text: z.string().min(1).describe("Plain-text body"),
    }),
    effect: "once",
    gate: "always",
    kind: "external",
    step: 0,
    async execute(args, ctx) {
      if (!EMAIL_PATTERN.test(args.to)) {
        throw new Error(`not an email address: ${args.to}`);
      }
      let key: string | undefined;
      try {
        key = await ctx.scope.secret?.("agentmail");
      } catch {
        key = undefined;
      }
      if (key === undefined) throw new Error("email sending is not configured (vault: agentmail)");

      // RUNTIME §6: the call id is the stable seed — the same call retried
      // after a crash presents the same key to the provider.
      const idempotencyKey = `fabric:${ctx.scope.callId ?? "unknown"}`;
      const mail = mailFor(ctx.scope, key);
      const { messageId } = await mail.inboxes.messages.send(
        sendFrom,
        { to: args.to, subject: args.subject, text: args.text },
        { idempotencyKey }
      );
      return { messageId, idempotencyKey };
    },
  });
