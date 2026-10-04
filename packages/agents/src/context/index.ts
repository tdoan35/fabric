// CTX owns this folder (TEAM in the 7-agent setup): the brief compiler and context assembly (WORK-PLAN §5.3 CTX).
//
// Two rules shape everything here (CONCEPT §2.6, §6):
//   1. A brief is compiled, never copied: BriefInput has no transcript field, and compileBrief never sees one.
//   2. A snapshot records exactly what crossed the boundary: every section carries the real `content`.
import { getEncoding } from "js-tiktoken";
import { generateObject } from "ai";
import type { LanguageModel } from "../llm";
import { z } from "zod";
import { STAYED } from "@fabric/fixtures/run";
import type { Brief, ContextSection, ContextSnapshot, Run, StudioProfile, ToolName, ToolPolicy } from "@fabric/contracts";
import { model as modelFor } from "../llm";

// ---- Token counting ----

let encoding: ReturnType<typeof getEncoding> | undefined;

/** A tokenizer estimate (o200k_base), flagged estimated: true — provider usage is the only exact count (ARCH §7). */
export function countTokens(text: string): { tokens: number; estimated: boolean } {
  encoding ??= getEncoding("o200k_base");
  return { tokens: encoding.encode(text).length, estimated: true };
}

/** `1h 30m` / `45m`, like the loop view's span formatting. */
function fmtSpan(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

// ---- The brief ----

/** Deliberately has no transcript field: the brief is compiled, never copied from the chat (CONCEPT §2.6). */
export interface BriefInput {
  /** The user's request, as Dana restated it in the handoff call. */
  request: string;
  team: { name: string; purpose: string; criteria: string[] };
  /** Team members, for their USER.md preferences. */
  specialists: StudioProfile[];
  constraints?: string[];
  /** Dana's display model ("" means Sonnet 5.5). Defaults to the compile-time Dana default. */
  modelId?: string;
}

/** One structured-output call (schema-validated) on Dana's model, thinking off. */
const briefBodySchema = z.object({
  objective: z.string().min(20).describe("One sentence, specific to this request"),
  constraints: z.array(z.string().min(3)).max(8).describe("The given ones plus only what the request itself implies"),
  criteria: z.array(z.string().min(3)).max(8).describe("The team's completion criteria narrowed to this request"),
  preferences: z.array(z.string().min(3)).max(8).describe("The deduplicated USER.md preference items"),
});

const BRIEF_SYSTEM = `You are Dana, Ty's executive assistant. You compile the handoff brief for a team run: it is the only context the specialists receive about this request beyond their own files.
Rules:
- The brief never contains chat transcript content. Only the request, criteria, preferences and constraints you are given.
- objective: one sentence, specific to this request, in Dana's voice restating what Ty wants.
- criteria: start from the team's criteria and narrow them to this request; keep wording that already fits.
- constraints: keep every given constraint, plus only what the request itself implies (budget, data, hardware, method limits).
- preferences: the deduplicated items from the specialists' USER.md files, each a short line like "Short status updates".`;

function briefPrompt(i: BriefInput): string {
  const wants = [...new Set(i.specialists.flatMap(preferenceItems))];
  return [
    `Request (Ty's request as restated by Dana):\n${i.request}`,
    `Team: ${i.team.name} — ${i.team.purpose}`,
    `Team's completion criteria:\n${i.team.criteria.map((c) => `- ${c}`).join("\n")}`,
    wants.length ? `User preferences from the specialists' USER.md files (deduplicate):\n${wants.map((p) => `- ${p}`).join("\n")}` : "User preferences: none on file.",
    i.constraints?.length ? `Given constraints:\n${i.constraints.map((c) => `- ${c}`).join("\n")}` : "Given constraints: none.",
  ].join("\n\n");
}

/** The full brief as text — what `tokens` counts. */
export function renderBrief(brief: Brief): string {
  return [
    `Objective: ${brief.objective}`,
    `Done when:\n${brief.criteria.map((c) => `- ${c}`).join("\n")}`,
    `Constraints:\n${brief.constraints.map((c) => `- ${c}`).join("\n")}`,
    `Preferences:\n${brief.preferences.map((p) => `- ${p}`).join("\n")}`,
    `Stayed with Dana:\n${brief.stayed.map((s) => `- ${s}`).join("\n")}`,
  ].join("\n\n");
}

export async function compileBrief(i: BriefInput, opts: { model?: LanguageModel } = {}): Promise<Brief> {
  const m = opts.model ?? modelFor(i.modelId ?? "", { thinking: "off" });
  const { object } = await generateObject({ model: m, schema: briefBodySchema, system: BRIEF_SYSTEM, prompt: briefPrompt(i) });
  const brief: Brief = { ...object, stayed: [...STAYED], tokens: 0 };
  brief.tokens = countTokens(renderBrief(brief)).tokens;
  return brief;
}

// ---- User preferences (each specialist's own USER.md, not Dana's memory of you) ----

/** The preference items a specialist's USER.md carries ("Wants: …"), as short lines. */
export function preferenceItems(agent: StudioProfile): string[] {
  const body = agent.workspace.files.find((f) => f.name === "USER.md")?.body ?? "";
  const wants = /^[-*]\s*\*\*Wants?:?\*\*:?\s*(.+)$/im.exec(body)?.[1] ?? "";
  return wants
    .split(/,\s*/)
    .map((item) => item.trim().replace(/\.$/, ""))
    .filter(Boolean)
    .map((item) => item.charAt(0).toUpperCase() + item.slice(1));
}

// ---- Context assembly (deterministic; no LLM call) ----

export interface AssembleInput {
  agent: StudioProfile;
  run: Run;
  step: string;
  brief: Brief;
  artifactRefs: { id: string; name: string; by?: string }[];
  teamKnowledge: string[];
  tools: { name: ToolName; policy: ToolPolicy }[];
  sandbox?: string;
  /** Seconds since run start, for snapshot.assembledAtS. */
  t: number;
  /** The lead's name, for the not-loaded line of independent roles (validators, reviewers). */
  leadName?: string;
}

type Section = { label: string; source: string; content: string };
const section = (s: Section): ContextSection => ({ ...s, tokens: countTokens(s.content).tokens, estimated: true });

function soulContent(agent: StudioProfile): string {
  return agent.workspace.files
    .filter((f) => f.name !== "USER.md")
    .map((f) => f.body.trim())
    .join("\n\n");
}

/** What the Inspector's Task brief tab shows: objective, done-when, constraints, budget. */
export function taskBriefContent(brief: Brief, run: Pick<Run, "reworkBudget" | "budget">): string {
  return [
    `Objective: ${brief.objective}`,
    `Done when:\n${brief.criteria.map((c) => `- ${c}`).join("\n")}`,
    `Constraints:\n${brief.constraints.map((c) => `- ${c}`).join("\n")}`,
    `Budget: rework ${run.reworkBudget} · ${fmtSpan(run.budget.timeS)}`,
  ].join("\n\n");
}

function toolsContent(tools: AssembleInput["tools"]): string {
  return tools.length ? tools.map((t) => `${t.name}: ${t.policy}`).join("\n") : "No tools bound to this step.";
}

function preferencesContent(items: string[]): string {
  return items.length ? items.map((p) => `- ${p}`).join("\n") : "None for this role. Dana passes on only what the role needs.";
}

function artifactRefsContent(refs: AssembleInput["artifactRefs"]): string {
  return refs.length
    ? refs.map((r) => `artifact://${r.name}${r.by ? ` (from ${r.by})` : ""}`).join("\n")
    : "No artifacts existed yet.";
}

function teamKnowledgeContent(knowledge: string[]): string {
  return knowledge.length ? knowledge.map((k) => `- ${k}`).join("\n") : "Nothing retrieved at this step.";
}

const NOT_LOADED_BASE = "your chat transcript · personal memory";

function notLoadedFor(agent: StudioProfile, leadName: string): string {
  const role = agent.agent.role.toLowerCase();
  if (role.includes("lead")) return `${NOT_LOADED_BASE} · members' tool schemas`;
  if (role.includes("validat") || role.includes("review")) return `${NOT_LOADED_BASE} · ${leadName}'s plan rationale`;
  if (role.includes("investigat") || role.includes("research")) return `${NOT_LOADED_BASE} · the code sandbox`;
  return `${NOT_LOADED_BASE} · other specialists' skills`;
}

function noteFor(i: AssembleInput): string {
  const role = i.agent.agent.role.toLowerCase();
  if (role.includes("lead")) return "Soul, brief and the team's workflow. Members' tools stay with them.";
  if (role.includes("investigat") || role.includes("research")) return "Soul, brief and search tools. No sandbox, no personal memory.";
  if (role.includes("validat")) {
    return i.teamKnowledge.length
      ? "Restricted: cannot edit acceptance criteria. Sees project facts, never yours."
      : "Restricted: cannot edit acceptance criteria.";
  }
  if (role.includes("review")) return "Reads the evidence, not the reasoning that produced it, so the review stays independent.";
  const refs = i.artifactRefs.length ? `, ${i.artifactRefs.length} artifact refs` : "";
  return `Soul, task brief, tool policy${refs}. No chat transcript, no personal memory.`;
}

export async function assembleContext(i: AssembleInput): Promise<{ system: string; snapshot: Omit<ContextSnapshot, "id"> }> {
  const items = preferenceItems(i.agent);
  const sections = [
    section({ label: "Soul / identity", source: "SOUL.md · IDENTITY.md", content: soulContent(i.agent) }),
    section({ label: "Task brief", source: "compiled by Dana", content: taskBriefContent(i.brief, i.run) }),
    section({ label: "Tools & policy", source: "Executor", content: toolsContent(i.tools) }),
    section({ label: "User preferences", source: `USER.md · ${items.length} items`, content: preferencesContent(items) }),
    section({ label: "Artifact references", source: "links, not content", content: artifactRefsContent(i.artifactRefs) }),
    section({ label: "Team knowledge", source: "retrieved on demand", content: teamKnowledgeContent(i.teamKnowledge) }),
  ];
  const snapshot: Omit<ContextSnapshot, "id"> = {
    runId: i.run.id,
    agentId: i.agent.agent.id,
    step: i.step,
    assembledAtS: i.t,
    sections,
    totalTokens: sections.reduce((n, s) => n + s.tokens, 0),
    tools: i.tools.map((t) => ({ name: t.name, policy: t.policy })),
    notLoaded: notLoadedFor(i.agent, i.leadName ?? "the lead"),
    note: noteFor(i),
    ...(i.sandbox ? { sandbox: i.sandbox } : {}),
  };
  return { system: sections.map((s) => s.content).join("\n\n"), snapshot };
}

// ---- Dana's base context (P1-3: runs.assistant_tokens, beside each specialist's own count) ----

/** What Dana's measured context is made of, for the Inspector's Context tab (MEM adds the last one). */
export function assistantContextSections(profile: StudioProfile, memory?: { content: string; items: number }): ContextSection[] {
  const files = profile.workspace.files.map((f) => f.body.trim()).join("\n\n");
  const skills = profile.workspace.skills.map((s) => `- ${s.name} — ${s.description}`).join("\n");
  const connectors = profile.workspace.connectors.map((c) => `- ${c.name} — ${c.note}`).join("\n");
  return [
    { label: "Workspace files", source: "SOUL.md · IDENTITY.md · USER.md", content: files },
    skills && { label: "Skills", source: "capabilities", content: `# Skills\n${skills}` },
    connectors && { label: "Connectors", source: "accounts", content: `# Connectors\n${connectors}` },
    memory && { label: "Personal memory", source: `Mnemosyne · ${memory.items} items`, content: memory.content },
  ].filter((s): s is { label: string; source: string; content: string } => !!s)
    .map((s) => ({ ...s, tokens: countTokens(s.content).tokens, estimated: true }));
}

/** Dana's per-turn base context: her profile plus her compact capability list, measured with the same counter. */
export function measureAssistantContext(profile: StudioProfile, memory?: { content: string; items: number }): number {
  const files = profile.workspace.files.map((f) => f.body.trim()).join("\n\n");
  const skills = profile.workspace.skills.map((s) => `- ${s.name} — ${s.description}`).join("\n");
  const connectors = profile.workspace.connectors.map((c) => `- ${c.name} — ${c.note}`).join("\n");
  const rendered = [files, skills && `# Skills\n${skills}`, connectors && `# Connectors\n${connectors}`, memory?.content]
    .filter(Boolean).join("\n\n");
  return countTokens(rendered).tokens;
}
