// DANA owns this folder: the main assistant, proposals, handoff and fixture mode (WORK-PLAN §5.3 DANA).
//
// createAssistant wires Dana onto the real state: the stored thread is authoritative, every turn
// opens with a recorded disposition (forced tool call, one retry), proposals are human tools whose
// decisions create rows on the next request, and the handoff compiles a brief and starts a real
// task + run. Fixture mode (DANA 6) runs the scripted branches with the same side effects.
import { ToolChoiceViolationError, stepCountIs, streamText, tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { NotImplementedError } from "@fabric/contracts";
import type {
  AppEvent, ChatPart, ChatRequest, ChatStreamLine, ChatToolCallPart, HandoffPayload, Proposal,
  PersonaPoolEntry, ResultsPayload, RosterEntry, SessionMessages, StudioProfile, TeamProposal, ThreadMessage,
} from "@fabric/contracts";
import { readRegistry } from "@fabric/db";
import type { Db, RunWriter } from "@fabric/db";
import { createInbox } from "@fabric/integrations";
import type { LanguageModel } from "../llm";
import { model } from "../llm";
import { compileBrief } from "../context";
import type { BriefInput } from "../context";
import type { TeamRuntime } from "../team";
import { buildSystemPrompt } from "./prompt";
import { fixtureBrief, fixtureTurn } from "./fixture";
import type { FixtureDeps } from "./fixture";
import { runHandoff } from "./handoff";
import type { HandoffDeps, HandoffInput } from "./handoff";
import {
  ensureSession, getSession, getProfile, insertMessage, listMessages, listPersonaPool, listProfiles,
  listProposals, pendingFor, recordDisposition, setProposalStatus, setToolResult, storeProposal,
  touchSession,
} from "./store";
import type { SessionRow, StoredProposal } from "./store";
import { applyApproval } from "./teams";
import { prepareDispositionFirstStep, withForcedDisposition } from "./stream";
import type { AttemptControl } from "./stream";
import { statusAfterDecision } from "./transitions";
import { diffThread, parseIncoming, toModelMessages } from "./thread";
import type { DecisionDelta, ThreadDelta } from "./thread";

export interface Assistant {
  /** POST /api/chat: yields cumulative snapshots of the assistant message (§4.3). */
  chat(req: ChatRequestBody): AsyncIterable<ChatStreamLine>;
  history(sessionId: string): Promise<SessionMessages>;
  /** Called by finalizeRun: Dana's "I got the results" message (CHAT-14). */
  postResultsMessage(sessionId: string, p: ResultsPayload): Promise<{ messageId: string }>;
}

/** ChatRequest plus the server-side switches the route resolves (header, DANA_MODE). */
export interface ChatRequestBody {
  sessionId: string;
  messages: unknown[];
  fixture?: boolean;
}

export interface AssistantDeps {
  writer: RunWriter;
  team: TeamRuntime;
  /** The server's own db client (services/runtime.ts wires it). */
  db: Db;
  /** AppEvents for the invalidation stream (§4.4) — wired to hub.publishApp. */
  publish: (e: AppEvent) => void;
  /** DANA_MODE. Per-request `fixture` / the x-fabric-fixture header override to on, never off. */
  mode?: "live" | "fixture";
  /** DEMO_RECORDING_KEY: what a Fast-forward splices into after the handoff. */
  recordingKey?: string;
  /** Tests inject a mock model; live turns use model(dana.agent.model) on the current provider. */
  modelFor?: (dana: StudioProfile) => LanguageModel;
  /** Tests inject a no-op; the default calls TOOLS createInbox and swallows its NotImplementedError. */
  createInbox?: (agentId: string) => Promise<string>;
}

const RECORDING_KEY = "ngram-135m";

/** Low, fixed: routing should be deterministic (WORK-PLAN DANA "use low temperature"). */
const TEMPERATURE = 0.2;
/** Tool-loop bound: disposition → maybe search → text+propose/handoff is 3; 6 is headroom. */
const MAX_STEPS = 6;

// ---- tool schemas: what the model fills; the server enriches before streaming ----

const dispositionSchema = z.object({
  disposition: z.enum(["handle_directly", "delegate_agent", "delegate_team", "propose_team", "propose_specialist", "clarify"]),
  reason: z.string().min(3),
  considered: z.array(z.string()).optional(),
});

const searchSchema = z.object({
  query: z.string().describe("What capability you need, e.g. 'coding', 'research team', 'free persona'"),
});

const rosterSchema = z.object({
  agentId: z.string().describe("Persona slug from search_registry, or a pool persona id for a new one"),
  name: z.string(),
  role: z.string().optional(),
  status: z.enum(["new", "existing"]),
});

const proposeTeamSchema = z.object({
  kind: z.literal("team"),
  name: z.string(),
  purpose: z.string(),
  roster: z.array(rosterSchema),
  workflow: z.array(z.object({ label: z.string(), agentIds: z.array(z.string()), gate: z.boolean().optional() })).optional(),
  reworkBudget: z.number().int().min(0).max(5).optional(),
  criteria: z.array(z.string()).optional(),
  leadDefaults: z.array(z.object({ label: z.string(), value: z.string(), why: z.string() })).optional(),
});

const proposeSpecialistSchema = z.object({
  kind: z.literal("specialist"),
  name: z.string(),
  purpose: z.string(),
  rows: z.array(z.object({ label: z.string(), value: z.string(), why: z.string() })),
  persona: z.object({ id: z.string(), name: z.string(), role: z.string().optional() }).optional()
    .describe("The pool portrait Ty will see; pick one from search_registry when you can"),
});

const handoffSchema = z.object({
  teamName: z.string(),
  request: z.string().describe("Your one-sentence restatement of what Ty wants. This is all the brief compiler sees."),
  title: z.string().optional().describe("Short task title for the Work board"),
  summary: z.string().describe("One line for the handoff card, e.g. what the team receives"),
});


export function createAssistant(deps: AssistantDeps): Assistant {
  const { db, publish } = deps;
  const recordingKey = deps.recordingKey ?? RECORDING_KEY;
  const inboxFor = deps.createInbox ?? (async (agentId: string) => {
    // createInbox throws synchronously while TOOLS is a stub (§7.0): catch it and carry on.
    try {
      return await createInbox(agentId);
    } catch (err) {
      if (err instanceof NotImplementedError) {
        console.log(`[assistant] TOOLS createInbox not implemented yet; skipping inbox for ${agentId}`);
        return "";
      }
      throw err;
    }
  });

  const handoffDeps = (brief: HandoffDeps["brief"]): HandoffDeps => ({
    db, writer: deps.writer, team: deps.team, publish, recordingKey, brief,
  });

  return {
    async *chat(req) {
      const sessionId = req.sessionId;
      const incoming = parseIncoming(req.messages ?? []);
      let stored = await listMessages(db, sessionId);

      // ---- the session row: unknown ids get created so the sidebar shows the thread ----
      const provisionalTitle = incoming.filter((m) => m.role === "user").map((m) => m.parts.map((p) => p.text ?? "").join(" ")).filter(Boolean).pop();
      if (await ensureSession(db, sessionId, provisionalTitle)) {
        publish({ type: "registry.changed" });
        stored = [];
      }
      const session = await getSession(db, sessionId);

      // ---- diff: only the new user message and decisions on our own pending calls ----
      const delta = diffThread(stored, incoming);
      for (const d of delta.decisions) await applyDecision(sessionId, stored, d);
      if (delta.newUserText) {
        await insertMessage(db, sessionId, "user", [{ type: "text", text: delta.newUserText }]);
      }

      // ---- the turn ----
      const fixture = req.fixture || deps.mode === "fixture";
      const lines = fixture ? fixtureLines(sessionId, session, delta) : liveLines(sessionId, session, delta);
      let final: ChatPart[] = [];
      for await (const line of lines) {
        final = line.content;
        yield line;
      }
      if (final.length) {
        await insertMessage(db, sessionId, "assistant", final);
        const open = (await listProposals(db, sessionId)).some(
          (p) => p.status === "pending" && final.some((part) => part.type === "tool-call" && part.toolCallId === p.toolCallId),
        );
        await touchSession(db, sessionId, open ? "input" : "unread");
      }

      // ---- helpers close over the turn above ----

      async function applyDecision(sessionId: string, storedMessages: ThreadMessage[], d: DecisionDelta): Promise<void> {
        const message = storedMessages.find((m) => m.content.some((p) => p.type === "tool-call" && p.toolCallId === d.toolCallId));
        if (!message) return;
        const row = pendingFor(await listProposals(db, sessionId), d.toolCallId);
        if (!row) return; // we never stored this call: not ours to decide
        await setToolResult(db, message.id, d.toolCallId, { decision: d.decision });
        const next = statusAfterDecision(row, d.decision);
        if (next === "approved") {
          await setProposalStatus(db, row.id, next);
          const pool = await listPersonaPool(db);
          await applyApproval(db, { row, pool, onInbox: (agentId) => void inboxFor(agentId) });
          publish({ type: "registry.changed" });
        } else if (next === "declined") {
          await setProposalStatus(db, row.id, next);
        }
        // discuss (next === "pending"): stays pending while Dana talks it through (CARD-4)
      }

      function fixtureLines(sessionId: string, session: SessionRow | undefined, delta: ReturnType<typeof diffThread>) {
        const ctx: FixtureDeps = {
          sessionId, session, delta,
          pending: [],
          profiles: [], pool: [],
          disposition: async (args, toolCallId) => {
            const result = await recordDisposition(db, sessionId, args);
            return { type: "tool-call", toolCallId, toolName: "record_disposition", args, argsText: JSON.stringify(args), result };
          },
          propose: async (input) => (await storeProposal(db, { sessionId, ...input })).payload,
          handoff: (input: HandoffInput) => runHandoff(handoffDeps(async (i) => fixtureBrief(i)), input),
        };
        return (async function* () {
          ctx.pending = (await listProposals(db, sessionId)).filter((p) => p.status === "pending");
          ctx.profiles = await listProfiles(db);
          ctx.pool = await listPersonaPool(db);
          yield* fixtureTurn(ctx);
        })();
      }

      async function* liveLines(sessionId: string, session: SessionRow | undefined, delta: ThreadDelta): AsyncGenerator<ChatStreamLine> {
        const active = await activeToolsFor(delta, await listProposals(db, sessionId));
        const dana = await getProfile(db, "dana");
        const registry = await readRegistry(db);
        const system = buildSystemPrompt(dana ?? fallbackDana(), {
          agents: registry.agents.map((a) => ({ id: a.agent.id, name: a.agent.name, role: a.agent.role, summary: a.agent.summary })),
          teams: registry.teams.map((t) => ({ id: t.id, name: t.name, purpose: t.purpose, members: t.members.map((m) => m.agentId) })),
          personaPool: registry.personaPool.map((p) => ({ id: p.id, name: p.name, role: p.role })),
        });
        const messages = toModelMessages(await listMessages(db, sessionId));

        const tools: ToolSet = {
          record_disposition: tool({
            description: "Record how this turn is routed: {disposition, reason, considered[]}. First call of every turn.",
            inputSchema: dispositionSchema,
            execute: (args) => recordDisposition(db, sessionId, args),
          }),
          search_registry: tool({
            description: "Internal lookup of your agents, teams and free personas. Never shown to Ty.",
            inputSchema: searchSchema,
            execute: async ({ query }) => {
              // ~8 rows: return the whole compact registry and flag what matched (ARCH §5).
              const r = await readRegistry(db);
              const q = query.toLowerCase();
              const hit = (s: string) => s.toLowerCase().includes(q);
              return {
                agents: r.agents.map((a) => ({ id: a.agent.id, name: a.agent.name, role: a.agent.role, summary: a.agent.summary, match: hit(`${a.agent.name} ${a.agent.role} ${a.agent.summary}`) })),
                teams: r.teams.map((t) => ({ id: t.id, name: t.name, purpose: t.purpose, members: t.members.map((m) => m.agentId), match: hit(`${t.name} ${t.purpose}`) })),
                personaPool: r.personaPool.map((p) => ({ id: p.id, name: p.name, role: p.role, match: hit(`${p.name} ${p.role}`) })),
              };
            },
          }),
          propose_team: tool({
            description: "Propose a new team as a card Ty approves. Ends your turn; the decision arrives as the tool result.",
            inputSchema: proposeTeamSchema,
          }),
          propose_specialist: tool({
            description: "Propose a new specialist as a card Ty approves. Ends your turn; the decision arrives as the tool result.",
            inputSchema: proposeSpecialistSchema,
          }),
          handoff_to_team: tool({
            description: "Hand the work to an approved team: compiles the brief, creates the task and starts the run.",
            inputSchema: handoffSchema,
            // The lane sometimes emits the call twice in one response; one handoff per turn.
            // compileBrief is an LLM call: if the lane fails it, the deterministic scripted brief
            // takes over (ARCH §11) so the handoff itself never fails.
            execute: (args) => (handoffDone ??= runHandoff(handoffDeps(async (i: BriefInput) => {
              try {
                return await compileBrief({ ...i, modelId: dana?.agent.model });
              } catch (err) {
                console.log(`[assistant] compileBrief failed (${err instanceof Error ? err.message : err}); using the deterministic brief`);
                return fixtureBrief(i);
              }
            }), {
              sessionId, session, teamName: args.teamName, request: args.request, title: args.title, summary: args.summary,
            })),
          }),
        };

        const m = deps.modelFor?.(dana ?? fallbackDana()) ?? model(dana?.agent.model ?? "", { thinking: "off", meter: { agentId: "dana", step: "chat" } });
        const allowed = active ?? Object.keys(tools);
        let handoffDone: Promise<HandoffPayload> | undefined;
        const attempt = async function* (control: AttemptControl): AsyncGenerator<ChatStreamLine> {
          let yielded = false;
          const turnAbort = new AbortController();
          const stream = streamText({
            model: m,
            system,
            messages,
            tools,
            temperature: TEMPERATURE,
            abortSignal: turnAbort.signal,
            ...(active ? { activeTools: active } : {}),
            stopWhen: stepCountIs(MAX_STEPS),
            // DANA 2: record_disposition is forced as the first call of every turn; later steps choose freely.
            // activeTools must be re-asserted every step: a step-level prepareStep return
            // overrides the top-level option.
            prepareStep: ({ stepNumber }) => ({
              ...(active ? { activeTools: active } : {}),
              ...prepareDispositionFirstStep(stepNumber),
            }),
          });
          const toolParts: ChatToolCallPart[] = [];
          let text = "";
          let anchor = 0; // non-disposition tool parts that came before the text
          let dispositionSeen = false;
          // Contract turn-enders (§4.3): a propose_* call (human decision pending) and a completed
          // handoff. Live models sometimes keep going past them; Dana's turn ends there.
          let terminal = false;
          // The disposition part is always rendered first (the contract shape, and what the mock
          // yields), whatever order the model produced text and calls in. `anchor` counts the
          // non-disposition tool parts that preceded the text, so later calls land after it.
          const snapshot = (): ChatStreamLine => {
            const disposition = toolParts.filter((p) => p.toolName === "record_disposition");
            const rest = toolParts.filter((p) => p.toolName !== "record_disposition");
            return {
              content: [
                ...disposition.map(copy),
                ...rest.slice(0, anchor).map(copy),
                ...(text ? [{ type: "text" as const, text }] : []),
                ...rest.slice(anchor).map(copy),
              ],
            };
          };
          try {
            for await (const part of stream.fullStream) {
              if (part.type === "error") throw part.error;
            if (part.type === "text-delta") {
              if (!text) anchor = toolParts.filter((p) => p.toolName !== "record_disposition").length;
              text += part.text;
            } else if (part.type === "tool-call") {
              if (part.toolName === "search_registry") continue; // internal: never streamed
              if (!allowed.includes(part.toolName)) {
                // The lane occasionally emits a tool the turn didn't offer (seen with activeTools
                // narrowed): the turn can't be used as-is. Retry it once (DANA 2).
                control.invalid = true;
                turnAbort.abort();
                break;
              }
              if (part.toolName === "record_disposition") dispositionSeen = true;
              if (part.toolName === "propose_team" || part.toolName === "propose_specialist") terminal = true;
              // One part per tool per turn: a duplicated call of a name already on the message is
              // dropped, not streamed and not stored (the lane repeats calls when loaded).
              if (toolParts.some((p) => p.toolName === part.toolName)) continue;
              let args: unknown = part.input;
              if (part.toolName === "propose_team" || part.toolName === "propose_specialist") {
                // Store the pending row now, and stream the enriched payload (proposalId, supersedes).
                const stored = await storeProposal(db, {
                  sessionId,
                  toolCallId: part.toolCallId,
                  kind: part.toolName === "propose_team" ? "team" : "specialist",
                  payload: enrichProposalArgs(part.input, part.toolName, registry.personaPool),
                });
                args = stored.payload;
              }
              toolParts.push({ type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, args, argsText: JSON.stringify(args) });
            } else if (part.type === "tool-result") {
              const target = toolParts.find((p) => p.toolCallId === part.toolCallId && p.result === undefined);
              if (target) {
                target.result = part.output;
                if (target.toolName === "handoff_to_team" && isHandoffPayload(part.output)) {
                  target.args = part.output; // the card reads the real ids and personas
                  target.argsText = JSON.stringify(part.output);
                  terminal = true;
                }
              }
            } else {
              continue;
            }
            // Hold everything back until the disposition call has landed, so a retried turn never
            // streams text without one (the UI replaces content per line either way).
            if (dispositionSeen) {
              yielded = true;
              yield snapshot();
            }
            // A card/handoff may share a step with the disposition call; its result still has to
            // land (the chip shows {recorded: true}) before the turn can end.
            const disposition = toolParts.find((p) => p.toolName === "record_disposition");
            if (terminal && disposition?.result !== undefined) {
              yield snapshot();
              turnAbort.abort(); // the turn is complete; nothing may follow the card or the handoff
              break;
            }
          }
          } catch (err) {
            // A provider that ignores the forced tool choice (seen on the Spark lane) fails before
            // anything streamed: hand the turn to the one retry instead of failing the request.
            if (yielded || !(err instanceof ToolChoiceViolationError)) throw err;
            console.warn(`[assistant] step 0 ignored the forced record_disposition; retrying: ${err.message}`);
          }
          if (!dispositionSeen) control.invalid = true; // nothing usable came out of this attempt
        };

        yield* withForcedDisposition(attempt, () =>
          console.warn(`[assistant] unusable first attempt for ${sessionId} (no disposition, or a disallowed tool call); retrying the turn`));
      }
    },

    async history(sessionId) {
      return { sessionId, messages: await listMessages(db, sessionId) };
    },

    async postResultsMessage(sessionId, p) {
      const content: ChatPart[] = [
        { type: "text", text: "I got the results here." },
        { type: "tool-call", toolCallId: `post-${p.reportId}`, toolName: "post_results", args: p, argsText: JSON.stringify(p), result: { posted: true } },
      ];
      const messageId = await insertMessage(db, sessionId, "assistant", content);
      await touchSession(db, sessionId, "unread");
      return { messageId };
    },
  };
}

// ---- helpers ----

const copy = (p: ChatToolCallPart): ChatToolCallPart => ({ ...p });

/**
 * The canonical post-approval steps (the demo script, D2/D3), as a tool guard rather than hope:
 * after a team approval the next card is the missing specialist; after the specialist approval the
 * turn hands off. Anything else in the thread keeps every tool.
 */
async function activeToolsFor(delta: ThreadDelta, proposals: { kind: "team" | "specialist" }[]): Promise<string[] | undefined> {
  const last = delta.decisions[delta.decisions.length - 1];
  if (!last) return undefined;
  if (last.toolName === "propose_specialist" && last.decision === "approved") {
    return ["record_disposition", "search_registry", "handoff_to_team"];
  }
  if (last.toolName === "propose_team" && last.decision === "approved" && !proposals.some((p) => p.kind === "specialist")) {
    return ["record_disposition", "search_registry", "propose_specialist"];
  }
  return undefined;
}

function isHandoffPayload(result: unknown): result is HandoffPayload {
  return !!result && typeof result === "object" && typeof (result as HandoffPayload).runId === "string" && Array.isArray((result as HandoffPayload).members);
}

/** Fills what the model can't know: roster roles/avatars from the registry, the persona from the pool. */
function enrichProposalArgs(
  args: unknown,
  toolName: string,
  pool: PersonaPoolEntry[],
): Proposal {
  if (toolName === "propose_team") {
    const team = args as TeamProposal;
    const roster: RosterEntry[] = team.roster.map((r) => {
      const persona = pool.find((p) => p.id === r.agentId);
      return { ...r, role: r.role ?? persona?.role, avatar: r.avatar ?? persona?.avatar?.still };
    });
    return { ...team, roster };
  }
  const spec = args as Exclude<Proposal, TeamProposal>;
  const picked = spec.persona
    ?? (pool[0] ? { id: pool[0].id, name: pool[0].name, role: pool[0].role, avatar: pool[0].avatar.still } : undefined);
  return picked ? { ...spec, persona: picked } : { ...spec };
}

function fallbackDana(): StudioProfile {
  // Only reached if the agents row is missing (unseeded branch); enough to build a prompt/model.
  return {
    agent: { id: "dana", name: "Dana", role: "Executive assistant", tone: "", summary: "", personality: "", traits: [], model: "", contextTokens: 0, memory: [], tools: [], greeting: "", placeholder: "" },
    tagline: "",
    workspace: { files: [{ name: "SOUL.md", body: "# SOUL.md\n\nYou are Dana, Ty's executive assistant.\n" }], skills: [], connectors: [], memories: [] },
  };
}
