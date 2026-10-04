// AgentMail (S5): Sana's inbox and the report email. The account allows 3 inboxes (the owner's
// ty-8132 is one) and 100 sends a day, so createInbox is idempotent on a fixed username per
// persona and only Sana gets one in phase 1 (§5.3 TOOLS 5). The address lives in the agent's
// existing AgentMail connector entry — no schema change — and reads as the registry's `inbox`
// (CARD-3). FEATURE_AGENTMAIL gates the call site (services/runtime.ts), not this module.
import { sql } from "@fabric/db";
import type { Db } from "@fabric/db";
import type { AppEvent, Report, StudioProfile } from "@fabric/contracts";
import { AgentMailClient } from "agentmail";
import { env } from "./env";

/** Phase 1 personas with inboxes: the third and last slot the account can spare. */
const INBOX_PERSONAS: Record<string, string> = { sana: "sana-fabric" };
const DOMAIN = "agentmail.to";
/** The owner's pre-existing inbox: send-only fallback when Sana's isn't there. */
export const OWNER_INBOX = `ty-8132@${DOMAIN}`;

/** The slice of the SDK these functions use, so tests can pass a fake. */
export interface AgentMailLike {
  inboxes: {
    list(req?: { limit?: number }): Promise<{ inboxes: { inboxId: string; email: string }[] }>;
    create(req: { username: string; domain: string }): Promise<{ inboxId: string; email: string }>;
    messages: {
      send(inboxId: string, req: { to: string; subject: string; text: string }): Promise<unknown>;
    };
  };
}

export function agentMailClient(): AgentMailLike {
  const key = env("AGENTMAIL_API_KEY");
  if (!key) throw new Error("AGENTMAIL_API_KEY is not set: AgentMail needs it");
  return new AgentMailClient({ apiKey: key });
}

export interface InboxUpdate {
  /** Where the address is recorded (CARD-3): the agent's AgentMail connector turns connected. */
  db?: Db;
  /** registry.changed, once the connector row carries the address. */
  publish?: (e: AppEvent) => void;
}

/**
 * Returns the persona's address, creating the inbox only when a lookup doesn't find it. Agents
 * without a phase-1 persona return "" (nothing created, nothing recorded). Never throws the
 * "already exists" case; rethrows real API errors so the caller can log and carry on.
 */
export async function createInbox(agentId: string, opts: InboxUpdate = {}, client: AgentMailLike = agentMailClient()): Promise<string> {
  const username = INBOX_PERSONAS[agentId];
  if (!username) {
    console.log(`[tools] no AgentMail persona for ${agentId}; skipping inbox`);
    return "";
  }
  const email = `${username}@${DOMAIN}`;
  let address = (await client.inboxes.list({ limit: 100 })).inboxes.find((i) => i.email === email)?.email;
  if (!address) {
    try {
      address = (await client.inboxes.create({ username, domain: DOMAIN })).email;
    } catch (err) {
      // The list can lag a create (read replicas): "already exists" means it's there — say so.
      if (!/already/i.test(String((err as { name?: string })?.name ?? (err as Error)?.message))) throw err;
      address = email;
    }
  }
  if (opts.db) await recordInbox(opts.db, agentId, address);
  opts.publish?.({ type: "registry.changed" });
  return address;
}

/** Writes the address into the agent's AgentMail connector (available → connected, CARD-3). */
async function recordInbox(db: Db, agentId: string, address: string): Promise<void> {
  const rows = await db.db.execute(sql`select workspace from agents where id = ${agentId}`);
  const workspace = (rows.rows[0] as { workspace: StudioProfile["workspace"] } | undefined)?.workspace;
  if (!workspace) throw new Error(`agent ${agentId} not found: nowhere to record the inbox`);
  let hasEntry = false;
  const connectors = workspace.connectors.map((c) => {
    if (c.name !== "AgentMail") return c;
    hasEntry = true;
    return { ...c, note: address, status: "connected" as const };
  });
  if (!hasEntry) connectors.push({ name: "AgentMail", note: address, status: "connected" });
  await db.db.execute(sql`
    update agents set workspace = jsonb_set(workspace, '{connectors}', ${JSON.stringify(connectors)}::jsonb)
    where id = ${agentId}`);
}

// ---- the report email (P1-1): finalize calls this only when FEATURE_AGENTMAIL=on ----

/** The report as plain text: every section a reader needs, nothing only the UI can show. */
export function renderReportEmail(report: Report): { subject: string; text: string } {
  const rows = report.results.length
    ? report.results.map((r) => `- ${r.config}: ppl ${r.ppl} (${r.delta})${r.valid === false ? " (invalid)" : ""}`).join("\n")
    : "- (no numeric results in this report)";
  const caveats = report.caveats.length ? report.caveats.map((c) => `- ${c}`).join("\n") : "- none";
  const provenance = report.provenance.map((p) => `- ${p.label}: ${p.value}`).join("\n");
  const artifacts = report.artifacts.length ? report.artifacts.map((a) => `- ${a.name}`).join("\n") : "- none";
  return {
    subject: `Fabric · ${report.title}`,
    text: [
      report.title,
      "",
      report.intro,
      "",
      report.summary,
      "",
      "Results",
      rows,
      "",
      "Caveats",
      caveats,
      "",
      "Provenance",
      provenance,
      "",
      "Artifacts",
      artifacts,
      "",
      `Run ${report.runId}`,
    ].join("\n"),
  };
}

/**
 * Sends the report from Sana's inbox (fallback: the owner's), to one address. Throws on failure;
 * finalize catches and the report stays in chat (ARCH §11).
 */
export async function sendReportEmail(report: Report, to: string, client: AgentMailLike = agentMailClient()): Promise<void> {
  const username = INBOX_PERSONAS.sana;
  const inboxes = (await client.inboxes.list({ limit: 100 })).inboxes;
  const from = inboxes.find((i) => i.email === `${username}@${DOMAIN}`) ?? inboxes.find((i) => i.email === OWNER_INBOX);
  if (!from) throw new Error(`no AgentMail inbox to send from (looked for ${username}@${DOMAIN} and ${OWNER_INBOX})`);
  const { subject, text } = renderReportEmail(report);
  await client.inboxes.messages.send(from.inboxId, { to, subject, text });
}
