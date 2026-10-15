// The stream half of the S13 protocol: one followSession loop per open thread
// (S12a's client under expo/fetch), feeding the projection the thread renders —
// projectThread over the accumulated events, applyDelta folding the live
// cumulative deltas in — plus the resume wiring. The client already reconnects
// from the last delivered seq on any drop; AppState "active" (the phone
// foregrounding, and with it the network returning) cuts the current
// connection so the loop reconnects immediately instead of sitting on a socket
// the OS killed — a dropped-connection failure rides the same loop, which
// retries with backoff. Mirrors the /api/stream pair (lib/stream.ts +
// lib/app-stream.ts). scripts/chat-smoke.mts drives @fabric/contracts'
// followSession directly under node: this module talks to React state.
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { fetch as expoFetch } from "expo/fetch";
import { z } from "zod";
import {
  applyDelta,
  followSession,
  projectThread,
  SessionEventSchema,
  type SessionDelta,
  type SessionEvent,
  type SessionThreadMessage,
} from "@fabric/contracts";

import { apiBase, httpApi } from "./api";
import { useAppEvents } from "./app-stream";
import { createChatSession, newClientMessageId, sendChatMessage, type FetchLike } from "./chat";

export type SessionThreadStatus =
  | { kind: "unstarted" } // fresh: the durable session is minted on the first send
  | { kind: "probing" } // existing id: durable session or legacy thread?
  | { kind: "live" } // following the durable session stream
  | { kind: "legacy" } // /api/chat-era thread: rendered read-only (S14 retires it)
  | { kind: "purged" }; // incognito-purged (S11): the log is erased, nothing to show

export interface SessionThread {
  status: SessionThreadStatus;
  messages: SessionThreadMessage[];
  /** True while the create/post round-trip is in flight; the turn itself plays out on the stream. */
  busy: boolean;
  error?: string;
  /** Post `text` as a user message, following (and creating, on a fresh thread) the session. */
  send: (text: string) => Promise<void>;
}

/** Restart backoff after a stream error, mirroring the client's own reconnect
 * ladder (session-client.ts FOLLOW_BACKOFF_MS), capped at its last entry. */
const RESTART_BACKOFF_MS = [500, 1000, 2000, 4000, 10_000];

/**
 * One chat thread on the durable-session protocol. `sessionId` is the durable
 * id (server-minted uuid) or, when `fresh`, a locally minted key that is never
 * sent — the real session is created on the first send. An id the session
 * store doesn't know is a legacy /api/chat-era thread: history loads once and
 * the thread renders read-only, as on web.
 */
export function useSessionThread(sessionId: string, opts: { fresh?: boolean } = {}): SessionThread {
  const [status, setStatus] = useState<SessionThreadStatus>({ kind: "probing" });
  const [messages, setMessages] = useState<SessionThreadMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const eventsRef = useRef(new Map<number, SessionEvent>());
  // Latest cumulative delta per in-flight call, keyed `${turn}:${callNo}` — the
  // same key the server's stream route batches by (routes/sessions.ts).
  const deltasRef = useRef(new Map<string, SessionDelta>());
  // The optimistic user line, until its message.received replays (its id — the
  // clientMessageId the server dedupes on — appears in the projection).
  const pendingRef = useRef<{ id: string; message: SessionThreadMessage } | undefined>(undefined);
  const lastSeqRef = useRef<number | undefined>(undefined);
  const sessionRef = useRef<string | undefined>(undefined); // the durable id, once known
  const abortRef = useRef<AbortController | undefined>(undefined);
  const aliveRef = useRef(true);
  const liveRef = useRef(false); // a followSession loop is (or should be) running
  const statusRef = useRef<SessionThreadStatus>({ kind: "probing" });
  const sendingRef = useRef(false);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  /** Rebuild the rendered thread: projection + optimistic line + provisional deltas. */
  const recompute = useCallback(() => {
    if (!aliveRef.current) return;
    const projected = projectThread([...eventsRef.current.values()]);
    const pending = pendingRef.current;
    const base =
      pending && !projected.some((m) => m.id === pending.id) ? [...projected, pending.message] : projected;
    setMessages([...deltasRef.current.values()].reduce((ms, delta) => applyDelta(ms, delta), base));
  }, []);
  const restartsRef = useRef(0); // consecutive stream-error restarts since the last frame
  // A callback can't name itself; the error path below restarts through this.
  const startFollowRef = useRef<(id: string, after?: number) => void>(() => {});

  const startFollow = useCallback(
    (id: string, after?: number) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      liveRef.current = true;
      void followSession(expoFetch as FetchLike, apiBase, id, {
        after,
        signal: controller.signal,
        onEvent: (event) => {
          // A frame arrived: the connection is healthy again.
          restartsRef.current = 0;
          setError(undefined); // no-op once clear (React bails on Object.is)
          // agent.message carries only {text} — no turn/callNo to correlate
          // with (core decide.ts endTurn) — and it ends the turn, so the final
          // reply replaces every provisional this turn streamed. A turn that
          // ends in human.requested never sends one: drop the provisionals
          // there too, or a failed turn's partial text lingers forever.
          if (event.type === "agent.message" || event.type === "human.requested") {
            deltasRef.current.clear();
          }
          eventsRef.current.set(event.seq, event);
          lastSeqRef.current = Math.max(lastSeqRef.current ?? 0, event.seq);
          recompute();
        },
        onDelta: (delta) => {
          deltasRef.current.set(`${delta.turn}:${delta.callNo}`, delta);
          recompute();
        },
      }).catch((err: unknown) => {
        // The client's retry loop rides out connect failures and non-ok
        // responses, but a read error mid-body (node undici's "terminated")
        // is rethrown by consumeStream instead of being treated as a drop —
        // an S12a gap whose real fix belongs in contracts. Until then this
        // hook owns the restart: surface the error, then follow again from
        // the last delivered seq with backoff (the client's own ladder).
        if (controller.signal.aborted || !aliveRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
        if (abortRef.current !== controller) return; // a newer loop owns the stream
        const delay = RESTART_BACKOFF_MS[Math.min(restartsRef.current, RESTART_BACKOFF_MS.length - 1)]!;
        restartsRef.current += 1;
        setTimeout(() => {
          if (aliveRef.current && abortRef.current === controller) {
            startFollowRef.current(id, lastSeqRef.current);
          }
        }, delay);
      });
    },
    [recompute],
  );
  useEffect(() => {
    startFollowRef.current = startFollow;
  }, [startFollow]);

  // Probe once, then follow. GET /api/sessions/:id/events answers 404 for ids
  // the session store doesn't know (legacy threads), 410 for purged ones, and
  // the backlog otherwise — instant hydration plus the follow cursor.
  useEffect(() => {
    aliveRef.current = true;
    eventsRef.current.clear();
    deltasRef.current.clear();
    pendingRef.current = undefined;
    lastSeqRef.current = undefined;
    sessionRef.current = undefined;
    liveRef.current = false;

    if (opts.fresh) {
      setStatus({ kind: "unstarted" });
      return () => {
        aliveRef.current = false;
        abortRef.current?.abort();
      };
    }

    let cancelled = false;
    setStatus({ kind: "probing" });
    setError(undefined);
    void (async () => {
      try {
        const res = await expoFetch(
          `${apiBase}/api/sessions/${encodeURIComponent(sessionId)}/events?after=0`,
        );
        if (cancelled) return;
        if (res.status === 404) {
          const history = await httpApi.getSessionMessages(sessionId);
          if (cancelled) return;
          // The legacy store's parts (text, tool-call) are the projection's
          // subset; the extra fields the projection carries are simply absent.
          setMessages(history.messages as SessionThreadMessage[]);
          setStatus({ kind: "legacy" });
          return;
        }
        if (res.status === 410) {
          setStatus({ kind: "purged" });
          return;
        }
        if (!res.ok) throw new Error(`session check failed: HTTP ${res.status}`);
        const value: unknown = await res.json();
        if (__DEV__) {
          const checked = z.array(SessionEventSchema).safeParse(value);
          if (!checked.success) console.warn("[session-stream] /events contract mismatch", checked.error.issues);
        }
        for (const event of value as SessionEvent[]) {
          eventsRef.current.set(event.seq, event);
          lastSeqRef.current = Math.max(lastSeqRef.current ?? 0, event.seq);
        }
        recompute();
        sessionRef.current = sessionId;
        setStatus({ kind: "live" });
        startFollow(sessionId, lastSeqRef.current);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      aliveRef.current = false;
      abortRef.current?.abort();
      liveRef.current = false;
    };
  }, [sessionId, opts.fresh, recompute, startFollow]);

  // Resume wiring: foregrounding cuts the (OS-killed) connection so the client
  // reconnects from the last delivered seq now, not after its backoff.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active" && liveRef.current && sessionRef.current) {
        startFollow(sessionRef.current, lastSeqRef.current);
      }
    });
    return () => sub.remove();
  }, [startFollow]);

  // Live while legacy: the results message (CHAT-14) and desktop decisions
  // change the thread's history — reload on the app stream, never mid-send.
  const reloadLegacy = useCallback(async () => {
    try {
      const history = await httpApi.getSessionMessages(sessionId);
      setMessages(history.messages as SessionThreadMessage[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [sessionId]);
  useAppEvents(
    (e) => e.type === "registry.changed" || (e.type === "session.message" && e.sessionId === sessionId),
    () => {
      if (statusRef.current.kind === "legacy" && !sendingRef.current) void reloadLegacy();
    },
  );

  const send = useCallback(
    async (text: string) => {
      if (sendingRef.current) return;
      sendingRef.current = true;
      setBusy(true);
      setError(undefined);
      const clientMessageId = newClientMessageId();
      pendingRef.current = {
        id: clientMessageId,
        message: {
          id: clientMessageId,
          role: "user",
          content: [{ type: "text", text }],
          createdAt: new Date().toISOString(),
        },
      };
      recompute();
      try {
        let id = sessionRef.current;
        if (!id) {
          id = await createChatSession(expoFetch as FetchLike);
          sessionRef.current = id;
          setStatus({ kind: "live" });
          startFollow(id); // from 0: the whole log, opening facts included
        }
        await sendChatMessage(expoFetch as FetchLike, id, text, clientMessageId);
        // The stream does the rest: message.received replaces the optimistic
        // line, deltas stream the reply, agent.message finalizes it.
      } catch (err) {
        pendingRef.current = undefined;
        recompute();
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        sendingRef.current = false;
        setBusy(false);
      }
    },
    [recompute, startFollow],
  );

  return { status, messages, busy, error, send };
}

