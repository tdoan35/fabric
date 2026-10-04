// Scripted Dana (DANA 6, RUN-12): the same branches as the web mock's mockAssistant, the same
// stream shape, and the same REAL side effects (dispositions, proposal rows, approvals, task, run).
// The payloads are the enriched card data (CARD-1, D1): real agent ids and roles, personas from
// the pool, workflow, budget, criteria and lead defaults. packages/fixtures/src/chat.ts and the
// web mock stay untouched; UI-CHAT renders the new fields.
import type {
  ChatPart, ChatStreamLine, DispositionArgs, HandoffPayload, PersonaPoolEntry, Proposal,
  ProposalDecision, RosterEntry, SpecialistProposal, StudioProfile, TeamProposal,
} from "@fabric/contracts";
import { specialistProposal as specialistRows } from "@fabric/fixtures/chat";
import { studioTeams } from "@fabric/fixtures/teams";
import { STAYED } from "@fabric/fixtures/run";
import type { Brief } from "@fabric/contracts";
import { countTokens, preferenceItems, renderBrief } from "../context";
import type { BriefInput } from "../context";
import type { HandoffInput } from "./handoff";
import type { SessionRow, StoredProposal } from "./store";
import type { DecisionDelta, ThreadDelta } from "./thread";

const RESEARCH = studioTeams.find((t) => t.id === "research")!;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The demo script's lines, verbatim from the mock so the two modes read the same. */
const LINES = {
  ideaIntro: "That's an interesting idea — but I think it would go better if I built a research team for it. It'd cover the survey, the implementation and an independent review.",
  teamApproved: "Ok will do — but adding a validator to the team would improve the results. It can check the work independently.",
  teamDeclined: "Understood. I won't build the team. Want me to just answer questions about the idea instead?",
  teamDiscuss: "Happy to talk it through. Which part of the team would you change?",
  specDeclined: "No problem, I'll hand off without a Validator. The Reviewer still checks the work.",
  specDiscuss: "Sure, what would you like to change about the Validator?",
  handoff: "Got it, the team is formed and your experiment is handed off. I'll ping you here and by email when there are results.",
  ngram: "An n-gram is a run of n consecutive tokens. Counting how often each one follows its context gives a simple lookup-table language model.",
  direct: "I can answer that directly without building a team.",
  reProposeTeam: "Sure — here it is again with the rework budget raised. Nothing is created until you approve it.",
  reProposeSpec: "Sure — here's the revised Validator. The card you already saw stays pending until you decide.",
};

const RESTATEMENT =
  "Test whether grafting an n-gram lookup table onto a small open model improves its held-out perplexity, with the table kept on disk rather than RAM.";
const HANDOFF_SUMMARY = "Brief compiled from your request and the team definition — not your chat transcript.";
const TASK_TITLE = "n-gram fusion on a 135M model";

const LEAD_DEFAULTS: TeamProposal["leadDefaults"] = [
  { label: "Tools", value: "artifacts.read · workspace.write · team.assign", why: "Plans and assigns the work; doesn't run code himself" },
  { label: "Memory", value: "Team-scoped · no personal memory", why: "Sees project facts, never yours" },
  { label: "Model", value: "Sonnet 5.5", why: "Planning-heavy work at moderate length" },
  { label: "Rework budget", value: "2 bounces, then it escalates to you", why: "Bounded autonomy: exhaustion blocks, it never loops" },
];

/** What the fixture turn needs from the server: state plus its side-effect hooks. */
export interface FixtureDeps {
  sessionId: string;
  session: SessionRow | undefined;
  delta: ThreadDelta;
  /** The session's pending proposals, newest last. */
  pending: StoredProposal[];
  profiles: StudioProfile[];
  pool: PersonaPoolEntry[];
  disposition(args: DispositionArgs, toolCallId: string): Promise<ChatPart>;
  propose(input: { toolCallId: string; kind: "team" | "specialist"; payload: Proposal }): Promise<Proposal>;
  handoff(input: HandoffInput): Promise<HandoffPayload>;
}

let n = 0;
const id = (prefix: string) => `call-${prefix}-${++n}`;
function roster(ctx: FixtureDeps, members: typeof RESEARCH.members): RosterEntry[] {
  const byId = new Map(ctx.profiles.map((p) => [p.agent.id, p]));
  const poolById = new Map(ctx.pool.map((p) => [p.id, p]));
  return members.map((m) => {
    const known = byId.get(m.agentId);
    const persona = poolById.get(m.agentId);
    return {
      agentId: m.agentId,
      name: known?.agent.name ?? persona?.name ?? m.agentId,
      role: known?.agent.role ?? persona?.role ?? m.duty,
      status: known ? "existing" : "new",
      avatar: (known?.agent.avatar ?? persona?.avatar)?.still,
    };
  });
}

/** The team card (CARD-1): everything from the canonical Research Team definition. */
function teamPayload(ctx: FixtureDeps, changes: { supersedes?: string; reworkBudget?: number } = {}): TeamProposal {
  return {
    kind: "team",
    name: RESEARCH.name,
    purpose: RESEARCH.purpose,
    roster: roster(ctx, RESEARCH.members.filter((m) => m.agentId !== "sana")),
    workflow: RESEARCH.workflow.map((s) => ({ label: s.label, agentIds: s.agentIds, gate: s.gate })),
    reworkBudget: changes.reworkBudget ?? RESEARCH.reworkBudget,
    criteria: RESEARCH.criteria,
    leadDefaults: LEAD_DEFAULTS,
    ...(changes.supersedes ? { supersedes: changes.supersedes } : {}),
  };
}

/** The specialist card: the Validator, with the pool persona Dana picked (D1). */
function specialistPayload(ctx: FixtureDeps, changes: { supersedes?: string } = {}): SpecialistProposal {
  const pooled = ctx.pool.find((p) => p.id === "sana");
  const known = ctx.profiles.find((p) => p.agent.id === "sana");
  const persona = pooled
    ? { id: pooled.id, name: pooled.name, role: pooled.role, avatar: pooled.avatar.still }
    : known
      ? { id: known.agent.id, name: known.agent.name, role: known.agent.role, avatar: known.agent.avatar?.still ?? "" }
      : undefined;
  return {
    ...specialistRows,
    persona,
    ...(changes.supersedes ? { supersedes: changes.supersedes } : {}),
  };
}

async function* typeOut(prefix: ChatPart[], text: string): AsyncGenerator<ChatStreamLine> {
  const words = text.split(" ");
  let acc = "";
  for (const w of words) {
    acc += (acc ? " " : "") + w;
    yield { content: [...prefix, { type: "text", text: acc }] };
    await sleep(25);
  }
}

const isIdea = (text: string) => /n-gram|engram|lookup table|experiment|test an idea/.test(text) && text.length > 60;
const REPROPOSE = /\b(yes|sure|ok|okay|go|propose|again|updated|revised)\b/i;

const lastDecision = (delta: ThreadDelta): DecisionDelta | undefined => delta.decisions[delta.decisions.length - 1];

/** One scripted turn. Branches mirror mockAssistant's state machine over the thread. */
export async function* fixtureTurn(ctx: FixtureDeps): AsyncGenerator<ChatStreamLine> {
  await sleep(250);
  const last = lastDecision(ctx.delta);

  // ---- a decision on the specialist card: hand off, or talk it through ----
  if (last?.toolName === "propose_specialist") {
    if (last.decision === "approved") {
      const pre = [
        await ctx.disposition({
          disposition: "delegate_team",
          reason: "Team is complete; hand off the experiment with a compiled brief.",
          considered: ["delegate_team", "handle_directly"],
        }, id("disp")),
      ];
      yield* typeOut(pre, LINES.handoff);
      const payload = await ctx.handoff({
        sessionId: ctx.sessionId, session: ctx.session, teamName: RESEARCH.name,
        request: RESTATEMENT, title: TASK_TITLE, summary: HANDOFF_SUMMARY,
      });
      yield {
        content: [...pre, { type: "text", text: LINES.handoff }, {
          type: "tool-call", toolCallId: id("handoff"), toolName: "handoff_to_team",
          args: payload, argsText: JSON.stringify(payload), result: payload,
        }],
      };
      return;
    }
    const declined = last.decision === "declined";
    const pre = [
      await ctx.disposition({
        disposition: "handle_directly",
        reason: declined ? "The Validator proposal was declined; the team runs without one." : "Talking through the Validator proposal before changing it.",
        considered: ["delegate_team", "handle_directly", "clarify"],
      }, id("disp")),
    ];
    yield* typeOut(pre, declined ? LINES.specDeclined : LINES.specDiscuss);
    return;
  }

  // ---- a decision on the team card: propose the missing specialist, or talk it through ----
  if (last?.toolName === "propose_team") {
    if (last.decision === "approved") {
      const pre = [
        await ctx.disposition({
          disposition: "propose_specialist",
          reason: "A missing capability: independent validation.",
          considered: ["delegate_team", "propose_specialist"],
        }, id("disp")),
      ];
      yield* typeOut(pre, LINES.teamApproved);
      const toolCallId = id("spec");
      const stored = await ctx.propose({ toolCallId, kind: "specialist", payload: specialistPayload(ctx) });
      yield {
        content: [...pre, { type: "text", text: LINES.teamApproved }, {
          type: "tool-call", toolCallId, toolName: "propose_specialist",
          args: stored, argsText: JSON.stringify(stored),
        }],
      };
      return;
    }
    const declined = last.decision === "declined";
    const pre = [
      await ctx.disposition({
        disposition: "handle_directly",
        reason: declined ? "The team proposal was declined; answering in chat instead." : "Talking through the team proposal before changing it.",
        considered: ["propose_team", "handle_directly", "clarify"],
      }, id("disp")),
    ];
    yield* typeOut(pre, declined ? LINES.teamDeclined : LINES.teamDiscuss);
    return;
  }

  const text = (ctx.delta.newUserText ?? "").toLowerCase();

  // ---- a re-proposal after "chat about this" (CARD-4): the new card supersedes the pending one ----
  const pendingTeam = [...ctx.pending].reverse().find((p) => p.kind === "team");
  const pendingSpec = [...ctx.pending].reverse().find((p) => p.kind === "specialist");
  if (text && REPROPOSE.test(text) && (pendingTeam || pendingSpec)) {
    if (pendingTeam) {
      const pre = [
        await ctx.disposition({ disposition: "propose_team", reason: "Ty asked for the team again with a change; re-proposing.", considered: ["propose_team", "handle_directly"] }, id("disp")),
      ];
      yield* typeOut(pre, LINES.reProposeTeam);
      const toolCallId = id("team");
      const stored = await ctx.propose({
        toolCallId, kind: "team",
        payload: teamPayload(ctx, { supersedes: pendingTeam.toolCallId ?? undefined, reworkBudget: RESEARCH.reworkBudget + 1 }),
      });
      yield {
        content: [...pre, { type: "text", text: LINES.reProposeTeam }, {
          type: "tool-call", toolCallId, toolName: "propose_team", args: stored, argsText: JSON.stringify(stored),
        }],
      };
      return;
    }
    const pre = [
      await ctx.disposition({ disposition: "propose_specialist", reason: "Ty asked for the Validator again with a change; re-proposing.", considered: ["propose_specialist", "handle_directly"] }, id("disp")),
    ];
    yield* typeOut(pre, LINES.reProposeSpec);
    const toolCallId = id("spec");
    const stored = await ctx.propose({
      toolCallId, kind: "specialist",
      payload: specialistPayload(ctx, { supersedes: pendingSpec!.toolCallId ?? undefined }),
    });
    yield {
      content: [...pre, { type: "text", text: LINES.reProposeSpec }, {
        type: "tool-call", toolCallId, toolName: "propose_specialist", args: stored, argsText: JSON.stringify(stored),
      }],
    };
    return;
  }

  // ---- the experiment idea: propose the team ----
  if (isIdea(text)) {
    const pre = [
      await ctx.disposition({
        disposition: "propose_team",
        reason: "Multi-step research: survey, implement, review. Best handled by a team.",
        considered: ["handle_directly", "delegate_team", "propose_team"],
      }, id("disp")),
    ];
    yield* typeOut(pre, LINES.ideaIntro);
    const toolCallId = id("team");
    const stored = await ctx.propose({ toolCallId, kind: "team", payload: teamPayload(ctx) });
    yield {
      content: [...pre, { type: "text", text: LINES.ideaIntro }, {
        type: "tool-call", toolCallId, toolName: "propose_team", args: stored, argsText: JSON.stringify(stored),
      }],
    };
    return;
  }

  // ---- everything else: answer directly ----
  const pre = [
    await ctx.disposition({ disposition: "handle_directly", reason: "Conceptual question; no delegation needed.", considered: ["handle_directly", "delegate_team"] }, id("disp")),
  ];
  const reply = /one line/.test(text) && /n-gram/.test(text) ? LINES.ngram : LINES.direct;
  yield* typeOut(pre, reply);
}

/**
 * The deterministic brief for fixture-mode handoffs: same shape as compileBrief's output, no model
 * call, so scripted Dana works with the lane down. Never contains transcript text (CONCEPT §2.6).
 */
export function fixtureBrief(input: BriefInput): Brief {
  const demo = /n-gram|engram/i.test(input.request);
  const brief: Brief = {
    objective: demo
      ? "Evaluate the impact of a disk-resident n-gram lookup table on held-out perplexity for a 135M open model."
      : `Run this end to end and report whether it holds: ${input.request.replace(/\s+/g, " ").trim().slice(0, 160)}`,
    constraints: demo
      ? ["Cached corpus only; no new downloads", "The n-gram table stays on disk, never loaded into RAM"]
      : ["Stay within the team's rework budget"],
    criteria: input.team.criteria,
    preferences: [...new Set(input.specialists.flatMap(preferenceItems))],
    stayed: [...STAYED],
    tokens: 0,
  };
  brief.tokens = countTokens(renderBrief(brief)).tokens;
  return brief;
}
