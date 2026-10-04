// DATA owns this file. Wires the backend modules together once, on first use, so the server boots
// while the CP-0 stubs still throw. Routes call runtime() inside their handlers.
import { createAssistant, type Assistant } from "@fabric/agents/assistant";
import { createTeamRuntime, type TeamRuntime } from "@fabric/agents/team";
import { createRunWriter, type RunWriter } from "@fabric/db";
import { finalizeRun } from "./finalize";

export interface Runtime { writer: RunWriter; team: TeamRuntime; assistant: Assistant }

let instance: Runtime | undefined;

export function runtime(): Runtime {
  if (instance) return instance;
  const writer = createRunWriter({
    // onEvent: publish to the SSE hub (DATA).
    onEnd: (runId) => finalizeRun(runId),
  });
  const team = createTeamRuntime({ writer });
  const assistant = createAssistant({ writer, team });
  instance = { writer, team, assistant };
  return instance;
}
