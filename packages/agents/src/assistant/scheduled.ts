// DANA: the scheduled turn (SCH). One generateText call with read-only tools — a routine never
// starts a team or proposes anything behind the user's back. The reply is posted into the
// routine's own thread as a header part (the routine and date) plus text, and the thread is
// touched unread, exactly like postResultsMessage.
import { generateText, stepCountIs, tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import type { AppEvent, ChatPart, StudioProfile } from "@fabric/contracts";
import type { Db } from "@fabric/db";
import { exaSearch } from "@fabric/integrations";
import type { LanguageModel } from "../llm";
import { model } from "../llm";
import { buildSystemPrompt } from "./prompt";
import type { RegistryBrief } from "./prompt";
import { ensureSession, getProfile, insertMessage, readDanaView, touchSession } from "./store";
import { fallbackDana } from "./prompt";

export interface ScheduledInput {
  /** The routine's thread; created if this fires before the route's ensureSession landed. */
  sessionId: string;
  title: string;
  prompt: string;
}

const DAY_FMT = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" });

/** Her usual prompt (files, who exists), her memories, then the routine's narrower rules. */
export function scheduledSystem(dana: StudioProfile, registry: RegistryBrief, prompt: string): string {
  const memories = dana.workspace.memories.map((m) => `- ${m.text}`).join("\n");
  return `${buildSystemPrompt(dana, registry)}

## Your memories

${memories || "- (none on file)"}

## This turn

This is a scheduled routine, not a reply to Ty: he may read it much later. Do the task below
yourself, with search only — no proposals, no handoffs, no cards, no questions unless the task is
impossible. Lead with what changed; keep it short.

${prompt}`;
}

/** DANA_MODE=fixture: a canned digest, so demos work without a model. */
export function fixtureDigest(): string {
  return [
    "Three things since yesterday:",
    "",
    "1. The 360M n-gram loop is still running — Megan's survey widened to three more corpora, no blockers.",
    "2. Carlos accepted the 135M report; the write-up is filed under Reports.",
    "3. The NAND probe's loop 2 ran out of rework budget and is waiting on you.",
    "",
    "Nothing needs your call before noon.",
  ].join("\n");
}

/** Search is the one read-only tool; only offered when Exa has a key. */
function scheduledTools(): ToolSet | undefined {
  if (!process.env.EXA_API_KEY) return undefined;
  return {
    exa_search: tool({
      description: "Search the web. Read-only: this scheduled turn cannot run anything.",
      inputSchema: z.object({ query: z.string().min(2) }),
      execute: async ({ query }) => {
        const outcome = await exaSearch(query, false);
        return {
          count: outcome.results.length,
          results: outcome.results.map((r) => ({ title: r.title, url: r.url, highlights: r.highlights })),
        };
      },
    }),
  };
}

export interface ScheduledDeps {
  db: Db;
  publish: (e: AppEvent) => void;
  /** DANA_MODE. Fixture mode skips the model call; same side effects either way. */
  mode?: "live" | "fixture";
  /** Tests inject a mock model; live turns use model(dana.agent.model) on the current provider. */
  modelFor?: (dana: StudioProfile) => LanguageModel;
}

export async function runScheduledTurn(deps: ScheduledDeps & ScheduledInput): Promise<{ messageId: string }> {
  const { db, sessionId, title, prompt } = deps;
  await ensureSession(db, sessionId, title);

  let text: string;
  if (deps.mode === "fixture") {
    text = fixtureDigest();
  } else {
    const [dana, view] = await Promise.all([getProfile(db, "dana"), readDanaView(db)]);
    const m = deps.modelFor?.(dana ?? fallbackDana()) ?? model(dana?.agent.model ?? "", { thinking: "off", meter: { agentId: "dana", step: "schedule" } });
    const result = await generateText({
      model: m,
      system: scheduledSystem(dana ?? fallbackDana(), view.registry, prompt),
      prompt,
      tools: scheduledTools(),
      temperature: 0.2,
      stopWhen: stepCountIs(4),
    });
    text = result.text || fixtureDigest();
  }

  const parts: ChatPart[] = [
    { type: "text", text: `${title} · ${DAY_FMT.format(new Date())}` },
    { type: "text", text },
  ];
  const messageId = await insertMessage(db, sessionId, "assistant", parts);
  await touchSession(db, sessionId, "unread");
  return { messageId };
}
