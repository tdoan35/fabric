// The wait API (RUNTIME section 7): answer an open wait, or refuse. The
// open-wait check and the `human.responded` append are ONE transaction — the
// stream head row is locked `for update` first, so of N concurrent responders
// exactly one sees the wait open; the rest re-read the appended answer and are
// refused. Refusals: the run is closed or cancellation requested
// (`cancelled`), the wait is gone (`already_answered`), the deadline passed
// (`expired`), a gated wait answered from a channel (`gated` — gated waits
// take answers from the app only).
import { fold } from "@fabric/core";
import { append } from "../store/store";
import type { RuntimeStore } from "../store/types";
import { enqueueReDecides, readEventRows } from "../workers/decide";

export type RefusalReason = "expired" | "already_answered" | "cancelled" | "gated";

export type RespondResult = { outcome: "accepted" } | { outcome: "refused"; reason: RefusalReason };

export type RespondOptions = {
  /** Who answered, recorded on the fact. */
  by: string;
  /** Where the answer came from; gated waits accept `app` only. */
  surface: "app" | "channel";
  /** Injected clock for the expiry check; the real clock when absent. */
  now?: () => number;
  /** When given, the answered stream's loop is re-decided (the wait's turn resumes). */
  queue?: import("../queue/types").Queue;
};

const isClosed = (state: ReturnType<typeof fold>): boolean =>
  state.status === "blocked" || state.status === "finished" || state.status === "stopped";

export async function respond(
  store: RuntimeStore,
  workspaceId: string,
  streamId: string,
  waitId: string,
  decision: string,
  options: RespondOptions
): Promise<RespondResult> {
  const now = options.now ?? (() => Date.now());
  return store.transaction(async (tx) => {
    // Lock the head first: a concurrent responder serializes behind us and
    // re-reads the state with our answer already on it (T7).
    await tx.query("select head from streams where id = $1 and workspace_id = $2 for update", [
      streamId,
      workspaceId,
    ]);
    const rows = await readEventRows(tx, streamId, workspaceId);
    const state = fold(rows);

    if (state.cancelRequested || isClosed(state)) return { outcome: "refused", reason: "cancelled" };
    const wait = state.waits.get(waitId);
    if (wait === undefined) return { outcome: "refused", reason: "already_answered" };
    if (wait.deadline !== null && now() > wait.deadline) {
      return { outcome: "refused", reason: "expired" };
    }
    if (wait.gated && options.surface !== "app") {
      return { outcome: "refused", reason: "gated" };
    }

    await append(tx, workspaceId, [
      {
        streamId,
        events: [
          {
            type: "human.responded",
            actor: "api",
            payload: { waitId, decision, by: options.by, surface: options.surface },
          },
        ],
      },
    ]);
    if (options.queue !== undefined) {
      await enqueueReDecides(tx, options.queue, workspaceId, [streamId]);
    }
    return { outcome: "accepted" };
  });
}
