// Errors thrown by @fabric/db beyond the standard ones.
/** Thrown by RunWriter when a run can no longer accept events (spliced or finalized); TEAM's
 *  cancelled steps catch this. finalize's own run.finished (emitAt) is exempt. */
export class RunClosedError extends Error {
  constructor(
    readonly runId: string,
    readonly reason: "spliced" | "finalized",
  ) {
    super(`run ${runId} is ${reason}; late events are rejected`);
    this.name = "RunClosedError";
  }
}
