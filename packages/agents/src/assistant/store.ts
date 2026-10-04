// Persistence for Dana's thread (DANA 2–3): sessions, chat_messages, dispositions and proposals.
// Rows are DANA's to write; DATA owns the tables. Raw SQL in the style of services/{sim,finalize}.ts,
// through @fabric/db's pooled client. Derived ids are stamped under advisory locks, like writer.ts.
import { sql } from "drizzle-orm";
import type {
  ChatPart, Disposition, DispositionArgs, PersonaPoolEntry, Proposal, Session, StudioProfile,
  StudioTeam, ThreadMessage,
} from "@fabric/contracts";
import { slugId } from "@fabric/db";
import type { Db } from "@fabric/db";
import { transitionOnReproposal } from "./transitions";

export interface SessionRow {
  id: string;
  projectId: string | null;
}

/** A proposals row, as the assistant reads it back. */
export interface StoredProposal {
  id: string;
  kind: "team" | "specialist";
  payload: Proposal;
  status: "pending" | "approved" | "declined" | "superseded";
  sessionId: string | null;
  toolCallId: string | null;
}

/** `12m`-style relative labels, like the seeded sessions carry. */
export function relativeLabel(from: Date, now = new Date()): string {
  const s = Math.max(0, (now.getTime() - from.getTime()) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= 48) return line;
  const cut = line.slice(0, 48);
  const space = cut.lastIndexOf(" ");
  return `${(space > 24 ? cut.slice(0, space) : cut).trim()}…`;
}

// ---- sessions ----

export async function getSession(db: Db, id: string): Promise<SessionRow | undefined> {
  const rows = await db.db.execute(sql`select id, project_id from sessions where id = ${id}`);
  return (rows.rows as unknown as SessionRow[])[0];
}

/** Creates the sessions row for an unknown id; the sidebar picks it up on registry.changed. */
export async function ensureSession(db: Db, id: string, firstMessage?: string): Promise<boolean> {
  const there = await getSession(db, id);
  if (there) return false;
  await db.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('sessions', 0))`);
    const next = await tx.execute(sql`select coalesce(max(ord), -1) + 1 as ord from sessions`);
    const ord = Number((next.rows[0] as { ord: string | number }).ord);
    await tx.execute(sql`
      insert into sessions (id, ord, title, href, project_id, status, agent_id, messages, updated)
      values (${id}, ${ord}, ${titleFrom(firstMessage ?? "New thread")}, '/', null, null, 'dana', 0, 'now')
      on conflict do nothing`);
  });
  return true;
}

/** Message count and the tail state after a turn: `input` while a proposal waits, else `unread`. */
export async function touchSession(db: Db, id: string, status: "input" | "unread"): Promise<void> {
  const count = await db.db.execute(sql`select count(*) as n from chat_messages where session_id = ${id}`);
  const n = Number((count.rows[0] as { n: string }).n);
  await db.db.execute(sql`
    update sessions set messages = ${n}, newReplies = greatest(coalesce(new_replies, 0) + 1, 1), status = ${status},
      updated = ${relativeLabel(new Date())}
    where id = ${id}`);
}

// ---- messages ----

export async function listMessages(db: Db, sessionId: string): Promise<ThreadMessage[]> {
  const rows = await db.db.execute(sql`
    select id, role, content, extract(epoch from created_at) * 1000 as ms
    from chat_messages where session_id = ${sessionId} order by created_at asc, id asc`);
  return (rows.rows as { id: string; role: string; content: ChatPart[]; ms: string }[]).map((r) => ({
    id: r.id,
    role: r.role === "user" ? "user" : "assistant",
    content: r.content,
    createdAt: new Date(Number(r.ms)).toISOString(),
  }));
}

export async function insertMessage(db: Db, sessionId: string, role: "user" | "assistant", content: ChatPart[]): Promise<string> {
  return db.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('chat_messages', 0))`);
    const next = await tx.execute(sql`select count(*) + 1 as n from chat_messages`);
    const id = `msg-${Number((next.rows[0] as { n: string }).n)}`;
    await tx.execute(sql`
      insert into chat_messages (id, session_id, role, content) values (${id}, ${sessionId}, ${role}, ${JSON.stringify(content)}::jsonb)`);
    return id;
  });
}

/** Writes a {decision} result onto a stored human tool call, so history shows the decided card. */
export async function setToolResult(db: Db, messageId: string, toolCallId: string, result: unknown): Promise<void> {
  const rows = await db.db.execute(sql`select content from chat_messages where id = ${messageId}`);
  const content = (rows.rows[0] as { content: ChatPart[] } | undefined)?.content;
  if (!content) return;
  let changed = false;
  const next = content.map((p) => {
    if (p.type === "tool-call" && p.toolCallId === toolCallId && p.result === undefined) {
      changed = true;
      return { ...p, result };
    }
    return p;
  });
  if (changed) {
    await db.db.execute(sql`update chat_messages set content = ${JSON.stringify(next)}::jsonb where id = ${messageId}`);
  }
}

// ---- dispositions ----

/** Stores every disposition with its considered[] (CHAT-13). Returns the tool's result. */
export async function recordDisposition(db: Db, sessionId: string, args: DispositionArgs): Promise<{ recorded: true }> {
  await db.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('dispositions', 0))`);
    const next = await tx.execute(sql`select count(*) + 1 as n from dispositions where session_id = ${sessionId}`);
    const turn = Number((next.rows[0] as { n: string }).n);
    await tx.execute(sql`
      insert into dispositions (id, session_id, turn, disposition, considered, reason)
      values (${"disp-" + sessionId + "-" + turn}, ${sessionId}, ${turn}, ${args.disposition},
              ${JSON.stringify(args.considered ?? [])}::jsonb, ${args.reason})`);
  });
  return { recorded: true };
}

// ---- proposals ----

/**
 * Stores a proposals row (pending). A re-proposal supersedes the session's pending row of the same
 * kind: the old row becomes `superseded` and the payload carries `supersedes` = its toolCallId.
 * Returns the enriched payload (proposalId, supersedes) exactly as it was stored and streamed.
 */
export async function storeProposal(
  db: Db,
  input: { sessionId: string; toolCallId: string; kind: "team" | "specialist"; payload: Proposal },
): Promise<{ proposalId: string; supersedes?: string; payload: Proposal }> {
  return db.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('proposals', 0))`);
    // CARD-4: the pending rows this one replaces (the newest gives `supersedes`).
    const pending = await tx.execute(sql`
      select id, kind, status, tool_call_id from proposals
      where session_id = ${input.sessionId} and kind = ${input.kind} and status = 'pending'
      order by created_at asc`);
    const transition = transitionOnReproposal(
      (pending.rows as { id: string; kind: string; status: string; tool_call_id: string | null }[]).map((r) => ({
        id: r.id, kind: r.kind as "team" | "specialist", status: r.status as "pending", toolCallId: r.tool_call_id,
      })),
      input.kind,
    );
    const supersedes = transition.supersedes;
    for (const id of transition.supersededIds) await tx.execute(sql`update proposals set status = 'superseded' where id = ${id}`);
    const next = await tx.execute(sql`select count(*) + 1 as n from proposals`);
    const proposalId = `prop-${Number((next.rows[0] as { n: string }).n)}`;
    const payload = { ...input.payload, proposalId, ...(supersedes ? { supersedes } : {}) } as Proposal;
    await tx.execute(sql`
      insert into proposals (id, kind, payload, status, session_id, tool_call_id)
      values (${proposalId}, ${input.kind}, ${JSON.stringify(payload)}::jsonb, 'pending', ${input.sessionId}, ${input.toolCallId})`);
    return { proposalId, ...(supersedes ? { supersedes } : {}), payload };
  });
}

export async function listProposals(db: Db, sessionId?: string): Promise<StoredProposal[]> {
  const rows = sessionId
    ? await db.db.execute(sql`select id, kind, payload, status, session_id, tool_call_id from proposals where session_id = ${sessionId} order by created_at asc`)
    : await db.db.execute(sql`select id, kind, payload, status, session_id, tool_call_id from proposals order by created_at asc`);
  return (rows.rows as { id: string; kind: string; payload: Proposal; status: string; session_id: string | null; tool_call_id: string | null }[]).map((r) => ({
    id: r.id,
    kind: r.kind === "team" ? "team" : "specialist",
    payload: r.payload,
    status: r.status as StoredProposal["status"],
    sessionId: r.session_id,
    toolCallId: r.tool_call_id,
  }));
}

export async function setProposalStatus(db: Db, id: string, status: StoredProposal["status"]): Promise<void> {
  await db.db.execute(sql`update proposals set status = ${status} where id = ${id}`);
}

/** The pending proposal behind a stored human tool call, if any. */
export function pendingFor(proposals: StoredProposal[], toolCallId: string): StoredProposal | undefined {
  return proposals.find((p) => p.toolCallId === toolCallId && p.status === "pending");
}

// ---- registry reads the assistant needs ----

export async function getProfile(db: Db, id: string): Promise<StudioProfile | undefined> {
  const rows = await db.db.execute(sql`select * from agents where id = ${id}`);
  return agentRowToProfile((rows.rows as Record<string, unknown>[])[0]);
}

export async function listProfiles(db: Db): Promise<StudioProfile[]> {
  const rows = await db.db.execute(sql`select * from agents where community = false order by ord asc`);
  return (rows.rows as Record<string, unknown>[]).map(agentRowToProfile).filter((p): p is StudioProfile => !!p);
}

export async function getTeamByName(db: Db, name: string): Promise<(StudioTeam & { memberProfiles: StudioProfile[] }) | undefined> {
  const teamRows = await db.db.execute(sql`
    select t.*, (select jsonb_agg(jsonb_build_object('agentId', m.agent_id, 'duty', m.duty, 'lead', m.lead) order by m.ord)
                 from team_members m where m.team_id = t.id) as members
    from teams t where lower(t.name) = lower(${name}) limit 1`);
  const row = (teamRows.rows as (Record<string, unknown> & { members: { agentId: string; duty: string; lead: boolean }[] | null })[])[0];
  if (!row) return undefined;
  const members = row.members ?? [];
  const profiles = await listProfiles(db);
  const byId = new Map(profiles.map((p) => [p.agent.id, p]));
  return {
    id: row.id as string,
    name: row.name as string,
    tagline: row.tagline as string,
    purpose: row.purpose as string,
    status: row.status as StudioTeam["status"],
    origin: row.origin as string,
    members: members.map((m) => ({ agentId: m.agentId, duty: m.duty, lead: m.lead || undefined })),
    workflow: row.workflow as StudioTeam["workflow"],
    reworkBudget: Number(row.rework_budget),
    criteria: row.criteria as string[],
    memberProfiles: members.map((m) => byId.get(m.agentId)).filter((p): p is StudioProfile => !!p),
  };
}

export async function listPersonaPool(db: Db): Promise<PersonaPoolEntry[]> {
  const rows = await db.db.execute(sql`select id, name, role, avatar from persona_pool order by ord asc`);
  return rows.rows as unknown as PersonaPoolEntry[];
}

function agentRowToProfile(r: Record<string, unknown> | undefined): StudioProfile | undefined {
  if (!r) return undefined;
  return {
    agent: {
      id: r.id as string,
      name: r.name as string,
      role: r.role as string,
      avatar: (r.avatar as StudioProfile["agent"]["avatar"]) ?? undefined,
      tone: (r.tone as string) ?? "",
      summary: (r.summary as string) ?? "",
      personality: (r.personality as string) ?? "",
      traits: (r.traits as string[]) ?? [],
      model: (r.model as string) ?? "",
      contextTokens: Number(r.context_tokens ?? 0),
      memory: (r.memory as StudioProfile["agent"]["memory"]) ?? [],
      tools: (r.tools as StudioProfile["agent"]["tools"]) ?? [],
      greeting: (r.greeting as string) ?? "",
      placeholder: (r.placeholder as string) ?? "",
    },
    tagline: (r.tagline as string) ?? "",
    workspace: r.workspace as StudioProfile["workspace"],
    origin: (r.origin as string) ?? undefined,
  };
}

/** The project a handoff files the task under: the session's project, else Engram. */
export function projectFor(session: SessionRow | undefined, projects: { id: string; archived?: boolean }[]): string {
  if (session?.projectId && projects.some((p) => p.id === session.projectId && !p.archived)) return session.projectId;
  const engram = projects.find((p) => p.id === "engram");
  return engram && !engram.archived ? "engram" : (projects.find((p) => !p.archived)?.id ?? "engram");
}

export { slugId };

export type { Session, Disposition };
