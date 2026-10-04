// DANA owns this folder: the main assistant, proposals, handoff and fixture mode (WORK-PLAN §5.3 DANA).
import { NotImplementedError } from "@fabric/contracts";
import type { ChatRequest, ChatStreamLine, ResultsPayload, SessionMessages } from "@fabric/contracts";
import type { RunWriter } from "@fabric/db";
import type { TeamRuntime } from "../team";

export interface Assistant {
  /** POST /api/chat: yields cumulative snapshots of the assistant message (§4.3). */
  chat(req: ChatRequest): AsyncIterable<ChatStreamLine>;
  history(sessionId: string): Promise<SessionMessages>;
  /** Called by finalizeRun: Dana's "I got the results" message (CHAT-14). */
  postResultsMessage(sessionId: string, p: ResultsPayload): Promise<void>;
}

export function createAssistant(_deps: { writer: RunWriter; team: TeamRuntime }): Assistant {
  throw new NotImplementedError("DANA", "createAssistant");
}
