// TEAM owns this folder: the data-driven team workflow (WORK-PLAN §5.3 TEAM).
import { NotImplementedError } from "@fabric/contracts";
import type { RunWriter } from "@fabric/db";

export interface TeamRuntime {
  /** Runs the loop's team workflow in the background; returns once it has started. */
  startTeamRun(runId: string): Promise<void>;
  /** Used by splice (D5). */
  cancelRun(runId: string): Promise<void>;
}

export function createTeamRuntime(_deps: { writer: RunWriter }): TeamRuntime {
  throw new NotImplementedError("TEAM", "createTeamRuntime");
}
