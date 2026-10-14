// S10 (ANY-60): system messages that land on the session stream. A finished
// run's results and a scheduled digest are telemetry on `session:<id>` for
// sessions that live on the log (RUNTIME §13); legacy chat threads keep the
// chat_messages insert and the `session.message` AppEvent, so the caller branches
// on this helper's boolean. The deterministic id rides `causation` — the store
// has no unique event-id column (R5's index covers facts only) — which puts the
// check and the append in one transaction: a repost of the same id is a no-op.
// `agent.message` is telemetry (RUNTIME §3), so the append plans no `decide`
// turn, and S3's projection renders it like any agent message.
import { append } from "@fabric/runtime";
import type { FabricRuntime } from "./bootstrap";
import { RUNTIME_WORKSPACE } from "./bootstrap";

export interface SystemMessage {
  /** The deterministic event id (`results:<runId>`, `schedule:<id>:<slot>`). */
  id: string;
  /** The message body, as S3's projection renders it. */
  text: string;
  /** What produced the message; reserved for attribution downstream. */
  origin?: { runId?: string; scheduleId?: string };
}

/**
 * Append the message to the session's stream when the stream exists, and
 * report whether it did: `true` = on the log (appended now, or already there
 * under the same id), `false` = no stream, the caller's legacy path stands.
 */
export async function postSystemMessage(
  runtime: Pick<FabricRuntime, "store">,
  sessionId: string,
  message: SystemMessage,
): Promise<boolean> {
  const streamId = `session:${sessionId}`;
  return runtime.store.transaction(async (tx) => {
    const stream = await tx.query("select 1 from streams where id = $1 and workspace_id = $2", [
      streamId,
      RUNTIME_WORKSPACE,
    ]);
    if (stream.length === 0) return false;

    const known = await tx.query(
      "select 1 from events where stream_id = $1 and workspace_id = $2 and causation = $3 limit 1",
      [streamId, RUNTIME_WORKSPACE, message.id],
    );
    if (known.length > 0) return true; // already posted: the repost is a no-op

    await append(tx, RUNTIME_WORKSPACE, [
      {
        streamId,
        events: [
          {
            type: "agent.message",
            actor: "system",
            payload: { text: message.text },
            causation: message.id,
          },
        ],
      },
    ]);
    return true;
  });
}
