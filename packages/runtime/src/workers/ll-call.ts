// The `ll.call` job handler (RUNTIME §4, §5.1): rebuild the conversation from
// facts — the definition snapshot's system prompt, the latest
// `context.compacted` summary, then each later input, completion and tool
// result — append `context.snapshot`, call the model ONCE with execute-less
// tools, and append `llm.completed` or `llm.failed`. Compaction (rule 7)
// precedes the call when the rebuilt context exceeds the configured limit;
// 429/5xx retry through the queue's backoff without a `llm.failed` (W5); other
// retryable failures record `llm.failed { retryable: true }` for the decide
// loop's single retry (rule 5); everything else records
// `llm.failed { retryable: false }` (W6). The result fact carries
// `causation = <job key>` exactly, so R5's unique index — and this handler's
// recorded-result guard — make a re-run append nothing twice (W7).
//
// The model call runs inside the append transaction: the compaction, the
// snapshot, the completion and the lease's completion commit together, and a
// failed call rolls the attempt back entirely for the retry to redo.
import { parseEvent } from "@fabric/core";
import type { Queue, QueueLease } from "../queue/types";
import type { ModelMessage, ModelPort, ModelResult, ModelTool } from "../ports";
import { append } from "../store/store";
import type { EventInput, RuntimeStore } from "../store/types";
import { enqueueReDecides, readEventRows, type EventRow } from "./decide";

export type LlmCallJobDeps = {
  store: RuntimeStore;
  queue: Queue;
  model: ModelPort;
  /** Injected clock, handed to the queue's retry bookkeeping. */
  now?: () => number;
  /** Live-delta sink, handed straight to the port; never logged (§8). */
  onDelta?: (delta: { text: string }) => void;
  /** Rule 7: when set, a rebuilt context over `tokenLimit` compacts first. */
  compaction?: { tokenLimit: number; countTokens: (text: string) => number };
};

/** One rebuilt message and the seq of the fact it came from (compaction's handle). */
interface Rebuilt {
  message: ModelMessage;
  seq: number;
}

interface Rebuild {
  system: string;
  /** Every conversation message, seq-tagged — pre-compaction ones included. */
  pairs: Rebuilt[];
  /** The latest `context.compacted` summary; null when the stream has none. */
  summary: string | null;
  /** The seq the latest compaction covers; facts at or below it are summary. */
  compactedUpTo: number;
  /** The turn/call/model the `llm.requested` for this call recorded. */
  call: { turn: number; callNo: number; model: string } | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const textOf = (payload: Record<string, unknown>, key: string): string =>
  typeof payload[key] === "string" ? (payload[key] as string) : "";

function definitionOf(rows: readonly EventRow[]): Record<string, unknown> {
  const created = rows.find((row) => row.type === "run.created");
  if (created === undefined) return {};
  const payload = isRecord(created.payload) ? created.payload : {};
  return isRecord(payload.definition) ? payload.definition : {};
}

/** §5.1's rebuild: every conversation fact, seq-tagged, plus the bookkeeping
 * the caller needs to cut the compaction summary in and the call out. */
export function rebuildFrom(rows: readonly EventRow[]): Rebuild {
  const parsed = rows.map((row) => ({ seq: row.seq, event: parseEvent(row) }));

  let compactedUpTo = 0;
  let summary: string | null = null;
  for (const { event } of [...parsed].reverse()) {
    if (event.type !== "context.compacted") continue;
    const payload = event.payload as Record<string, unknown>;
    compactedUpTo = Math.max(compactedUpTo, typeof payload.upToSeq === "number" ? payload.upToSeq : 0, event.seq);
    summary = textOf(payload, "summary");
    break; // the latest compaction, by seq
  }

  const pairs: Rebuilt[] = [];
  for (const { seq, event } of parsed) {
    if (event.class !== "fact" || seq <= compactedUpTo) continue;
    const payload = event.payload as Record<string, unknown>;
    switch (event.type) {
      case "message.received":
        pairs.push({ seq, message: { role: "user", text: textOf(payload, "text") } });
        break;
      case "human.responded":
        pairs.push({ seq, message: { role: "user", text: textOf(payload, "decision") } });
        break;
      case "delegation.result":
        pairs.push({ seq, message: { role: "user", text: textOf(payload, "summary") } });
        break;
      case "llm.completed":
        pairs.push({
          seq,
          message: {
            role: "assistant",
            text: textOf(payload, "text"),
            toolCalls: Array.isArray(payload.toolCalls)
              ? (payload.toolCalls as Record<string, unknown>[])
              : [],
          },
        });
        break;
      case "tool.completed":
        pairs.push({
          seq,
          message: {
            role: "tool",
            toolCallId: textOf(payload, "callId"),
            text:
              payload.ok === true ? renderResult(payload.result) : `error: ${textOf(payload, "error")}`,
          },
        });
        break;
      case "tool.interrupted":
        // §6: the model sees the interruption as the result and decides anew.
        pairs.push({
          seq,
          message: { role: "tool", toolCallId: textOf(payload, "callId"), text: textOf(payload, "note") },
        });
        break;
      case "proposal.decided":
        // ANY-57 S8a: a decided proposal is a user-visible input — the next
        // turn's model call sees the decision the way it sees an answer.
        pairs.push({
          seq,
          message: {
            role: "user",
            text: `proposal ${textOf(payload, "kind")} ${textOf(payload, "decision")} (by ${textOf(payload, "by")})`,
          },
        });
        break;
      default:
        break; // llm.requested / llm.failed / lifecycle facts: not conversation
    }
  }

  let call: Rebuild["call"] = null;
  for (const { event } of [...parsed].reverse()) {
    if (event.type === "llm.requested") {
      const payload = event.payload as Record<string, unknown>;
      call = {
        turn: typeof payload.turn === "number" ? payload.turn : 0,
        callNo: typeof payload.callNo === "number" ? payload.callNo : 0,
        model: typeof payload.model === "string" ? payload.model : "default",
      };
      break;
    }
  }

  const def = definitionOf(rows);
  // The session definition's `system` (ANY-56 S7) wins; the legacy snapshot key stays.
  const system =
    typeof def.system === "string" ? def.system : typeof def.systemPrompt === "string" ? def.systemPrompt : "";
  return { system, pairs, summary, compactedUpTo, call };
}

function renderResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === undefined || result === null) return "";
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/** Rule 7's mechanical compaction: drop the oldest messages — an assistant
 * never leaves without its tool results — until under the limit, and stand a
 * truncated digest in their place, bounded to fit by construction. A lone
 * oversized message stays. */
export function compact(
  pairs: readonly Rebuilt[],
  tokenLimit: number,
  countTokens: (text: string) => number
): { messages: Rebuilt[]; dropped: Rebuilt[]; summary: string } | null {
  const total = (list: readonly Rebuilt[]) =>
    list.reduce((sum, { message }) => sum + countTokens(message.text), 0);
  const kept = [...pairs];
  const dropped: Rebuilt[] = [];
  while (total(kept) > tokenLimit && kept.length > 0) {
    const first = kept.shift()!;
    dropped.push(first);
    if (first.message.role === "assistant") {
      while (kept[0]?.message.role === "tool") dropped.push(kept.shift()!);
    }
  }
  if (dropped.length === 0) return null;

  const prefix = `Earlier conversation (${dropped.length} messages), summarized: `;
  const joined = dropped.map(({ message }) => `${message.role}: ${message.text}`).join("\n");
  const budget = Math.max(0, tokenLimit - countTokens(prefix));
  const summary = prefix + joined.slice(0, budget);
  return { messages: kept, dropped, summary };
}

/** The job's key is `<stream>:<turn>:llm:<callNo>`; the fallback when the
 * stream carries no `llm.requested` to read. */
function callFromKey(key: string, streamId: string): { turn: number; callNo: number } | null {
  if (!key.startsWith(`${streamId}:`)) return null;
  const parts = key.slice(streamId.length + 1).split(":");
  if (parts.length !== 3 || parts[1] !== "llm") return null;
  const turn = Number(parts[0]);
  const callNo = Number(parts[2]);
  if (!Number.isInteger(turn) || !Number.isInteger(callNo)) return null;
  return { turn, callNo };
}

export async function handleLlmCallJob(lease: QueueLease, deps: LlmCallJobDeps): Promise<void> {
  const { store, queue, model } = deps;
  const now = deps.now ?? (() => Date.now());
  if (lease.streamId === null) throw new Error("ll.call job without a stream");
  const streamId: string = lease.streamId;
  const key = lease.key;

  let recorded = false;
  try {
    await store.transaction(async (tx) => {
      // W7: the result already recorded — an at-least-once re-run. Skip the
      // call and the append; the tail completes the lease tolerantly.
      const done = await tx.query(
        `select 1 from events where stream_id = $1 and workspace_id = $2 and causation = $3 and class = 'fact' limit 1`,
        [streamId, lease.workspaceId, key]
      );
      if (done.length > 0) {
        recorded = true;
        return;
      }

      const rows = await readEventRows(tx, streamId, lease.workspaceId);
      const rebuilt = rebuildFrom(rows);
      const call = rebuilt.call ?? callFromKey(key, streamId);
      if (call === null) {
        throw new Error(`ll.call ${key}: no llm.requested on ${streamId} and the key does not parse`);
      }

      // the conversation: the compaction summary in front, then everything after it (W3)
      let conversation: Rebuilt[] = rebuilt.pairs;
      if (rebuilt.summary !== null && rebuilt.compactedUpTo > 0) {
        conversation = [{ seq: 0, message: { role: "user", text: rebuilt.summary } }, ...conversation];
      }

      // rule 7: over the limit, compact before anything else (W4)
      let compaction: { upToSeq: number; summary: string } | null = null;
      if (deps.compaction !== undefined) {
        const result = compact(conversation, deps.compaction.tokenLimit, deps.compaction.countTokens);
        if (result !== null) {
          const upToSeq = result.dropped.reduce((max, { seq }) => Math.max(max, seq), 0);
          compaction = { upToSeq, summary: result.summary };
          conversation = [{ seq: upToSeq, message: { role: "user", text: result.summary } }, ...result.messages];
        }
      }

      // the compaction and the snapshot precede the call, in the same tx
      const preEvents: EventInput[] = [];
      if (compaction !== null) {
        preEvents.push({
          type: "context.compacted",
          actor: "llm.call",
          payload: { upToSeq: compaction.upToSeq, summary: compaction.summary },
          causation: `${key}:context.compacted`,
        });
      }
      preEvents.push({
        type: "context.snapshot",
        actor: "llm.call",
        payload: { snapshotId: `snap:${streamId}:${call.turn}:${call.callNo}` },
        causation: `${key}:context.snapshot`,
      });
      await append(tx, lease.workspaceId, [{ streamId, events: preEvents }]);

      const definition = definitionOf(rows);
      const tools = toolDeclarationsOf(definition);
      const thinking = typeof definition.thinking === "string" ? definition.thinking : undefined;
      const result: ModelResult = await model.call({
        system: rebuilt.system,
        messages: conversation.map(({ message }) => message),
        tools,
        ...(thinking !== undefined ? { thinking } : {}),
        ...(deps.onDelta !== undefined ? { onDelta: deps.onDelta } : {}),
      });

      await append(tx, lease.workspaceId, [
        {
          streamId,
          events: [
            {
              type: "llm.completed",
              actor: "llm.call",
              payload: {
                turn: call.turn,
                callNo: call.callNo,
                text: result.text,
                toolCalls: [...result.toolCalls],
                usage: { ...result.usage },
                finishReason: result.finishReason,
                model: rebuilt.call?.model ?? "default",
              },
              causation: key,
            },
          ],
        },
      ]);
      await enqueueReDecides(tx, queue, lease.workspaceId, [streamId]);
      await queue.complete(tx, lease);
    });
  } catch (error) {
    await settleFailure(error);
  }
  if (recorded) {
    // The result is durable; complete the lease, tolerating the runner that
    // got there first — its completion is the proof the guard saw.
    try {
      await store.transaction((tx) => queue.complete(tx, lease));
    } catch (error) {
      const job = await queue.get(lease.jobId);
      if (job?.status !== "completed") throw error;
    }
  }

  /** A model failure becomes either a queue retry (429/5xx, no fact — W5) or a
   * recorded `llm.failed` with the lease completed (W6). */
  async function settleFailure(error: unknown): Promise<void> {
    const record = isRecord(error) ? error : {};
    const retryable = record.retryable === true;
    if (retryable && isRetryStatus(record.status)) {
      await queue.fail(
        lease,
        error instanceof Error ? error : new Error(String(error)),
        { retryable: true },
        now()
      );
      return;
    }
    const fallback = callFromKey(key, streamId);
    await store.transaction(async (tx) => {
      const rows = await readEventRows(tx, streamId, lease.workspaceId);
      const requested = requestedCallOf(rows) ?? fallback;
      await append(tx, lease.workspaceId, [
        {
          streamId,
          events: [
            {
              type: "llm.failed",
              actor: "llm.call",
              payload: {
                turn: requested?.turn ?? 0,
                callNo: requested?.callNo ?? 0,
                error: error instanceof Error ? error.message : String(error),
                retryable,
              },
              causation: key,
            },
          ],
        },
      ]);
      // the failure is a fact: the decide loop owns rule 5's single retry
      await enqueueReDecides(tx, queue, lease.workspaceId, [streamId]);
      await queue.complete(tx, lease);
    });
  }
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The tools the model call carries: the definition's full declarations
 * (`toolSchemas`, ANY-56 S7) when it carries any, else the legacy name list. */
function toolDeclarationsOf(definition: Record<string, unknown>): ModelTool[] {
  const schemas = arrayValue(definition.toolSchemas);
  if (schemas.length > 0) {
    return schemas.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.name !== "string") return [];
      return [
        {
          name: entry.name,
          ...(typeof entry.description === "string" ? { description: entry.description } : {}),
          ...(entry.parameters !== undefined ? { parameters: entry.parameters } : {}),
        },
      ];
    });
  }
  return arrayValue(definition.tools)
    .filter((name): name is string => typeof name === "string")
    .map((name) => ({ name }));
}

function isRetryStatus(status: unknown): boolean {
  if (status === 429) return true;
  return typeof status === "number" && status >= 500 && status < 600;
}

/** The turn/call/model of the last `llm.requested` on the stream. */
function requestedCallOf(rows: readonly EventRow[]): { turn: number; callNo: number; model: string } | null {
	for (let index = rows.length - 1; index >= 0; index -= 1) {
		const row = rows[index]!;
		if (row.type !== "llm.requested") continue;
		const payload = isRecord(row.payload) ? row.payload : {};
		return {
			turn: typeof payload.turn === "number" ? payload.turn : 0,
			callNo: typeof payload.callNo === "number" ? payload.callNo : 0,
			model: typeof payload.model === "string" ? payload.model : "default",
		};
	}
	return null;
}
