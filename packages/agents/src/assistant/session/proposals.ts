// The proposal surface on the agent loop (ANY-57 S8a, PRODUCT §4): a proposal is
// a disposition of kind `propose`, decided in the app. The `propose_*` tools run
// as `tool.exec` with effect `idempotent` — the body writes the proposal through
// today's assistant store keyed by the call id, so a retried job finds the row
// instead of creating a second one, and announces `proposal.created` on the
// session stream with a per-call causation, so the announcement lands exactly
// once across crashes and retries too. The same store backs the decision
// endpoint: the `proposal.decided` fact is the loop's input (the fold parks it,
// S2), while the transition's side effects stay on the read model, exactly as
// the in-process decision path applies them today.
import type { Proposal, ProposalDecision } from "@fabric/contracts";
import { append } from "@fabric/runtime";
import type { RuntimeStore } from "@fabric/runtime";
import type { Db } from "@fabric/db";
import { applyApproval, specialistCard, teamCard, type World } from "../teams";
import { listProposals, readDanaView, setProposalStatus, storeProposal, type StoredProposal } from "../store";
import { statusAfterDecision } from "../transitions";

/** The propose_* tools, in declaration order. */
export const PROPOSE_TOOLS = ["propose_team", "propose_specialist"] as const;

export type ProposalKind = "team" | "specialist";

/** The declarations the model sees; the `idempotent` effect lives in the definition's toolEffects. */
export const PROPOSAL_TOOL_SCHEMAS: Record<string, { description: string; parameters: Record<string, unknown> }> = {
  propose_team: {
    description:
      "Propose a new team as a card Ty approves; the workflow, budget and criteria are filled in for you. Ends your turn; the decision arrives as the tool result.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        purpose: { type: "string", description: "One sentence" },
        roster: {
          type: "array",
          minItems: 1,
          items: {
            anyOf: [
              { type: "string" },
              { type: "object", properties: { agentId: { type: "string" }, name: { type: "string" } } },
            ],
          },
          description: "Member ids, lead first: existing agents, and a free persona for each new member",
        },
      },
      required: ["name", "purpose", "roster"],
    },
  },
  propose_specialist: {
    description: "Propose a new specialist as a card Ty approves. Ends your turn; the decision arrives as the tool result.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The role, e.g. Validator" },
        purpose: { type: "string", description: "One sentence" },
        persona: {
          anyOf: [{ type: "string" }, { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } }],
          description: "The free persona's id",
        },
      },
      required: ["name", "purpose"],
    },
  },
};

/** The persistence the loop body and the decision endpoint share: idempotent
 * per (session, callId) on `record`, the read model on the rest. */
export type ProposalStore = {
  record(input: {
    sessionId: string;
    toolCallId: string;
    kind: ProposalKind;
    payload: Proposal;
  }): Promise<{ proposalId: string; created: boolean }>;
  /** Who exists and who is free: what a card's roster resolves against. */
  world(): Promise<World>;
};

/** The endpoint's half: the row read and the guarded transition. */
export type ProposalActions = ProposalStore & {
  byId(id: string): Promise<StoredProposal | undefined>;
  /** Applies the transition once; false when the row is missing or decided. */
  decide(id: string, decision: ProposalDecision): Promise<boolean>;
  close(): Promise<void>;
};

/** The bare session id behind a `session:<id>` stream; null elsewhere. */
export function sessionOf(streamId: string | undefined | null): string | null {
  if (typeof streamId !== "string" || !streamId.startsWith("session:")) return null;
  const id = streamId.slice("session:".length);
  return id.length > 0 ? id : null;
}

/** The loop's seam: the proposal store plus where its facts are announced. */
export type ProposalLoopDeps = {
  store: ProposalStore;
  loop: { store: RuntimeStore; workspace: string };
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The `propose_team` / `propose_specialist` body on the session ToolPort. The
 * card is built exactly as the in-process path builds it (teams.ts, from the
 * world), stored idempotently against the call id, and announced as
 * `proposal.created { kind, definition }` before the completion — the result
 * carries the `proposalId` either way.
 */
export async function runProposeTool(
  name: string,
  args: Record<string, unknown>,
  io: { callId?: string; streamId?: string },
  deps: ProposalLoopDeps,
): Promise<{ ok: boolean; result?: { proposalId: string }; error?: string }> {
  const callId = io.callId;
  const sessionId = sessionOf(io.streamId);
  if (callId === undefined || callId === "" || sessionId === null) {
    return { ok: false, error: "propose needs the call id and the session stream" };
  }
  const kind: ProposalKind | null =
    name === "propose_team" ? "team" : name === "propose_specialist" ? "specialist" : null;
  if (kind === null) return { ok: false, error: `unknown proposal tool: ${name}` };

  let payload: Proposal;
  try {
    const world = await deps.store.world();
    if (kind === "team") {
      const card = teamCard(args as unknown as Parameters<typeof teamCard>[0], world);
      if (card.roster.length === 0) return { ok: false, error: "proposal roster resolved to nobody" };
      payload = card;
    } else {
      payload = specialistCard(args as unknown as Parameters<typeof specialistCard>[0], world);
    }
  } catch (error) {
    return { ok: false, error: `unusable ${name} input: ${errorText(error)}` };
  }

  try {
    const { proposalId } = await deps.store.record({ sessionId, toolCallId: callId, kind, payload });
    await announceCreated(deps.loop, io.streamId!, callId, kind, payload);
    return { ok: true, result: { proposalId } };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

/** The stream half of the store: the proposal.created fact, once per call. The
 * transaction joins the handler's (the embedded driver serializes them), so the
 * announcement and the row land inside the same attempt. */
async function announceCreated(
  loop: ProposalLoopDeps["loop"],
  streamId: string,
  callId: string,
  kind: ProposalKind,
  payload: Proposal,
): Promise<void> {
  const causation = `${streamId}:${callId}:proposal.created`;
  await loop.store.transaction(async (tx) => {
    const done = await tx.query(
      `select 1 from events where stream_id = $1 and workspace_id = $2 and causation = $3 and class = 'fact' limit 1`,
      [streamId, loop.workspace, causation],
    );
    if (done.length === 0) {
      await append(tx, loop.workspace, [
        {
          streamId,
          events: [{ type: "proposal.created", actor: "tool.exec", payload: { kind, definition: payload }, causation }],
        },
      ]);
    }
  });
}

/** The production store: today's assistant tables, today's transition. */
export function dbProposalStore(db: Db): ProposalActions {
  const world = async (): Promise<World> => (await readDanaView(db)).world;

  const byId = async (id: string): Promise<StoredProposal | undefined> =>
    (await listProposals(db)).find((row) => row.id === id);

  const record: ProposalStore["record"] = async (input) => {
    const existing = (await listProposals(db, input.sessionId)).find(
      (row) => row.toolCallId === input.toolCallId && row.kind === input.kind,
    );
    if (existing !== undefined) return { proposalId: existing.id, created: false };
    const stored = await storeProposal(db, input);
    return { proposalId: stored.proposalId, created: true };
  };

  const decide = async (id: string, decision: ProposalDecision): Promise<boolean> => {
    const row = await byId(id);
    if (row === undefined) return false;
    const next = statusAfterDecision(row, decision);
    if (next === null) return false; // decided already: the endpoint answers 409
    if (next !== "pending") await setProposalStatus(db, id, next);
    if (next === "approved") await applyApproval(db, { row, world: await world(), onInbox: () => {} });
    return true;
  };

  return { record, world, byId, decide, close: () => db.close() };
}
