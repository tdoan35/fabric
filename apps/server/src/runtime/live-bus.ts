// The session live bus (S6, ANY-55; RUNTIME §8 "Local (one process)"): every
// append notifies its streams and model-token deltas ride the same channel,
// never entering the log. The port is the whole contract — the stream endpoint
// subscribes and reads `current`; the bootstrap wiring calls `appended` and
// `delta`. A later second implementation (pg_notify for the cloud work) will
// sit behind the same interface.
import type { SessionDelta } from "@fabric/contracts";

export interface LiveBus {
  /** An append committed on the stream; `seq` is the new head. */
  appended(streamId: string, seq: number): void;
  /** Cumulative text of the in-flight model call. */
  delta(streamId: string, d: { turn: number; callNo: number; text: string }): void;
  subscribe(
    streamId: string,
    l: { onAppend(seq: number): void; onDelta(d: SessionDelta): void },
  ): () => void;
  /** The in-progress call's cumulative text; null between calls. */
  current(streamId: string): SessionDelta | null;
}

/** One stream's listeners. */
type Listeners = Set<{ onAppend(seq: number): void; onDelta(d: SessionDelta): void }>;

export class InProcessLiveBus implements LiveBus {
  readonly #listeners = new Map<string, Listeners>();
  readonly #current = new Map<string, SessionDelta>();

  appended(streamId: string, seq: number): void {
    for (const listener of this.#listeners.get(streamId) ?? []) listener.onAppend(seq);
  }

  delta(streamId: string, d: { turn: number; callNo: number; text: string }): void {
    // The latest text per call is the only state a mid-call join needs; keep a
    // copy so a caller-mutated payload cannot rewrite history.
    this.#current.set(streamId, { ...d });
    for (const listener of this.#listeners.get(streamId) ?? []) listener.onDelta(this.#current.get(streamId)!);
  }

  subscribe(
    streamId: string,
    listener: { onAppend(seq: number): void; onDelta(d: SessionDelta): void },
  ): () => void {
    const listeners = this.#listeners.get(streamId) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(streamId, listeners);
    return () => {
      listeners.delete(listener);
    };
  }

  current(streamId: string): SessionDelta | null {
    const call = this.#current.get(streamId);
    return call === undefined ? null : { ...call };
  }

  /** Wiring-only, outside the port: the call's `ll.completed`/`ll.failed`
   * landed, so a client connecting now must not see a stale delta. */
  endCall(streamId: string): void {
    this.#current.delete(streamId);
  }

  /** Introspection for tests and ops: listeners on one stream. */
  count(streamId: string): number {
    return this.#listeners.get(streamId)?.size ?? 0;
  }
}
