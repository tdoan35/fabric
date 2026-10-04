// DATA owns this file. Runs after a real finish (RunWriter.end) or a spliced one (/finalize-splice); idempotent.
// Sets the final status, attaches the report, adds the Weave result item, then calls
// assistant.postResultsMessage and (if FEATURE_AGENTMAIL) sendReportEmail (WORK-PLAN §5.3 DATA step 8).
import { NotImplementedError } from "@fabric/contracts";

export async function finalizeRun(_runId: string): Promise<void> {
  throw new NotImplementedError("DATA", "finalizeRun");
}
