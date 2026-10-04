// CTX owns this folder (TEAM in the 7-agent setup): the brief compiler and context assembly (WORK-PLAN §5.3 CTX).
import { NotImplementedError } from "@fabric/contracts";
import type { Brief, ContextSnapshot, Run, StudioProfile, StudioTeam, ToolName, ToolPolicy } from "@fabric/contracts";

/** Deliberately has no transcript field: the brief is compiled, never copied from the chat (CONCEPT §2.6). */
export interface BriefInput {
  /** The user's request, as Dana restated it in the handoff call. */
  request: string;
  team: StudioTeam;
  /** Team members, for their USER.md preferences. */
  specialists: StudioProfile[];
  constraints?: string[];
}

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
}

export function compileBrief(_i: BriefInput): Promise<Brief> {
  throw new NotImplementedError("CTX", "compileBrief");
}

export function assembleContext(_i: AssembleInput): Promise<{ system: string; snapshot: Omit<ContextSnapshot, "id"> }> {
  throw new NotImplementedError("CTX", "assembleContext");
}

export function countTokens(_text: string): { tokens: number; estimated: boolean } {
  throw new NotImplementedError("CTX", "countTokens");
}
