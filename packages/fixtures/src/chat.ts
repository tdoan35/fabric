// The scripted demo conversation's data: the idea, both proposals and the handoff.
// Dana's server-side fixture mode (DANA) and the web mock adapter both use it.
import type { HandoffPayload, SpecialistProposal, TeamProposal } from "@fabric/contracts";

export const IDEA_PROMPT =
  "I want to test an idea: graft an n-gram / Engram lookup table onto a much smaller open model to boost its capability. The table could live on NAND instead of RAM.";

export const teamProposal: TeamProposal = {
  kind: "team",
  name: "Research Team",
  purpose: "Survey, implement and independently review the experiment.",
  roster: [
    { agentId: "lead", name: "Research Lead", status: "new" },
    { agentId: "investigator", name: "Investigator", status: "existing" },
    { agentId: "coder", name: "Coder", status: "existing" },
    { agentId: "reviewer", name: "Reviewer", status: "existing" },
  ],
};

export const specialistProposal: SpecialistProposal = {
  kind: "specialist",
  name: "Validator",
  purpose: "Independently checks the experiment's results against a held-out split.",
  rows: [
    { label: "Tools", value: "Read artifacts · run checks in an isolated Sprite", why: "Needs to execute evaluations, nothing else" },
    { label: "Memory", value: "Team-scoped · no personal memory", why: "Sees project facts, never yours" },
    { label: "Restriction", value: "Cannot edit acceptance criteria", why: "Keeps the review independent" },
    { label: "Lifecycle", value: "This team · save as reusable agent", why: "Reuse beats creating again" },
  ],
};

export const handoff: HandoffPayload = {
  runId: "run-ngram-1",
  teamName: "Research Team",
  summary: "Brief compiled from your request and the team definition — not your chat transcript.",
  members: [
    { name: "Research Lead", state: "planning" },
    { name: "Investigator", state: "searching" },
    { name: "Coder", state: "setting up" },
    { name: "Validator", state: "preparing checks" },
  ],
};
