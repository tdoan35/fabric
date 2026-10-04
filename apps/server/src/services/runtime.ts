// DATA owns this file. Wires the backend modules together once, on first use, so the server boots
// while the CP-0 stubs still throw. Routes call runtime() inside their handlers. Later steps'
// modules (team, assistant) are resolved lazily: a stub that throws NotImplementedError logs one
// line and reads as "not available yet", so splice and finalize work today (§7.0).
import { NotImplementedError } from "@fabric/contracts";
import type { Assistant } from "@fabric/agents/assistant";
import type { TeamRuntime } from "@fabric/agents/team";
import { createAssistant } from "@fabric/agents/assistant";
import { createTeamRuntime } from "@fabric/agents/team";
import { createDb, createRunWriterWith } from "@fabric/db";
import type { Db, RunWriter } from "@fabric/db";
import { env } from "../env";
import { hub } from "./hub";
import { finalizeRun } from "./finalize";

export interface Runtime {
  db: Db;
  writer: RunWriter;
  /** Undefined until TEAM lands; callers log one line and carry on. */
  team(): TeamRuntime | undefined;
  /** Undefined until DANA lands. */
  assistant(): Assistant | undefined;
}

let instance: Runtime | undefined;

/** Memoizes a CP-0 factory: a NotImplementedError is cached as "absent", anything else propagates. */
function lazyStep<T>(owner: string, make: () => T): () => T | undefined {
  let value: T | undefined;
  let absent = false;
  return () => {
    if (!value && !absent) {
      try {
        value = make();
      } catch (err) {
        if (err instanceof NotImplementedError) {
          absent = true;
          console.log(`[runtime] ${owner} not implemented yet; continuing without it`);
        } else {
          throw err;
        }
      }
    }
    return value;
  };
}

export function runtime(): Runtime {
  if (instance) return instance;
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is not set: the server needs a Neon branch");
  const db = createDb(env.DATABASE_URL);
  const writer = createRunWriterWith(db, {
    onEvent: (e) => hub.publishRun(e),
    onEnd: async (runId) => {
      await finalizeRun(runId);
    },
  });
  const team = lazyStep("TEAM", () => createTeamRuntime({ writer }));
  // DANA can land before TEAM: hand her a stand-in that throws only if she starts a run.
  const notYetTeam: TeamRuntime = {
    async startTeamRun() { throw new NotImplementedError("TEAM", "startTeamRun"); },
    async cancelRun() { throw new NotImplementedError("TEAM", "cancelRun"); },
  };
  instance = {
    db,
    writer,
    team: () => team(),
    assistant: lazyStep("DANA", () => createAssistant({ writer, team: team() ?? notYetTeam })),
  };
  return instance;
}
