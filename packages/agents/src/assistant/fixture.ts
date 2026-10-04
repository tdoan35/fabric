// Scripted Dana (DANA 6, RUN-12): the same branches as the web mock's mockAssistant, the same
// stream shape, and the same REAL side effects (dispositions, proposal rows, approvals, task, run).
// The cards are the scripted payloads in @fabric/fixtures/chat (CARD-1, D1), the same ones the web
// mock streams: their choices (name, purpose, roster, persona) go through the same teamCard /
// specialistCard as live turns, which fill the rest from the definition approval provisions — on
// the demo seed that is exactly the scripted payload (cards.test pins it).
import type {
  ChatPart, ChatStreamLine, DispositionArgs, HandoffPayload, Proposal, SpecialistProposal, TeamProposal,
} from "@fabric/contracts";
import { handoff as SCRIPTED_HANDOFF, specialistProposal as SCRIPTED_SPECIALIST, teamProposal as SCRIPTED_TEAM } from "@fabric/fixtures/chat";
import { STAYED } from "@fabric/fixtures/run";
import type { Brief } from "@fabric/contracts";
import { countTokens, preferenceItems, renderBrief } from "../context";
import type { BriefInput } from "../context";
import type { HandoffInput } from "./handoff";
import type { SessionRow, StoredProposal } from "./store";
import { specialistCard, teamCard } from "./teams";
import type { World } from "./teams";
import type { DecisionDelta, ThreadDelta } from "./thread";

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
const HANDOFF_SUMMARY = SCRIPTED_HANDOFF.summary;
const TASK_TITLE = "n-gram fusion on a 135M model";

/** What the fixture turn needs from the server: state plus its side-effect hooks. */
export interface FixtureDeps {
  sessionId: string;
  session: SessionRow | undefined;
  delta: ThreadDelta;
  /** The session's pending proposals, newest last. */
  pending: StoredProposal[];
  /** Who exists and who is free: what the cards resolve against (the same builders as live turns). */
  world: World;
  disposition(args: DispositionArgs, toolCallId: string): Promise<ChatPart>;
  propose(input: { toolCallId: string; kind: "team" | "specialist"; payload: Proposal }): Promise<Proposal>;
  handoff(input: HandoffInput): Promise<HandoffPayload>;
}

let n = 0;
const id = (prefix: string) => `call-${prefix}-${++n}`;

/** The team card (CARD-1): the scripted Research Team, without Sana — she joins on her own card. */
function teamPayload(ctx: FixtureDeps, changes: { supersedes?: string; reworkBudget?: number } = {}): TeamProposal {
  const card = teamCard({
    name: SCRIPTED_TEAM.name,
    purpose: SCRIPTED_TEAM.purpose,
    roster: SCRIPTED_TEAM.roster.map((r) => r.agentId),
    reworkBudget: changes.reworkBudget,
  }, ctx.world);
  return { ...card, ...(changes.supersedes ? { supersedes: changes.supersedes } : {}) };
}

/** The specialist card: the Validator, with the pool persona Dana picked (D1). */
function specialistPayload(ctx: FixtureDeps, changes: { supersedes?: string } = {}): SpecialistProposal {
  const card = specialistCard({ name: SCRIPTED_SPECIALIST.name, purpose: SCRIPTED_SPECIALIST.purpose, persona: SCRIPTED_SPECIALIST.persona?.id }, ctx.world);
  return { ...card, ...(changes.supersedes ? { supersedes: changes.supersedes } : {}) };
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
        sessionId: ctx.sessionId, session: ctx.session, teamName: SCRIPTED_HANDOFF.teamName,
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
        payload: teamPayload(ctx, { supersedes: pendingTeam.toolCallId ?? undefined, reworkBudget: (SCRIPTED_TEAM.reworkBudget ?? 2) + 1 }),
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
