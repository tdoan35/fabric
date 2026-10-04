// Pure proposal state transitions (DANA 3, D2/CARD-4). The store applies these; the rules live
// here so they can be pinned by unit tests without a database.
import type { ProposalDecision } from "@fabric/contracts";

export type ProposalStatus = "pending" | "approved" | "declined" | "superseded";

/** A minimal proposals row, as the transition rules see it. */
export interface ProposalLike {
  id: string;
  kind: "team" | "specialist";
  status: ProposalStatus;
  toolCallId: string | null;
}

/**
 * Where a decided card lands. Only a pending proposal moves: `discuss` keeps it pending while Dana
 * talks it through, and a decision replayed on an already-decided row changes nothing (null).
 */
export function statusAfterDecision(row: ProposalLike, decision: ProposalDecision): ProposalStatus | null {
  if (row.status !== "pending") return null;
  return decision === "approved" ? "approved" : decision === "declined" ? "declined" : "pending";
}

/**
 * What a new proposal of the same kind does to the session's pending rows (CARD-4): they all
 * become `superseded`, and the card carries `supersedes` = the newest pending row's toolCallId.
 */
export function transitionOnReproposal(
  pending: ProposalLike[],
  kind: "team" | "specialist",
): { supersededIds: string[]; supersedes?: string } {
  const rows = pending.filter((p) => p.kind === kind && p.status === "pending");
  const newest = rows[rows.length - 1];
  return {
    supersededIds: rows.map((r) => r.id),
    supersedes: newest?.toolCallId ?? undefined,
  };
}
