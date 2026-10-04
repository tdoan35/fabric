// GET /api/stream (MOBILE-PLAN §2 M1): SSE of AppEvents, invalidation only (§4.4). RN has no
// EventSource, so the frames are read from a streaming fetch body — `expo/fetch` in the app
// (wired in lib/app-stream.ts), because RN's global fetch doesn't expose response bodies as
// streams. This module is PURE — no react/react-native/expo imports — so scripts/chat-smoke.mts
// drives the exact same parser and manager under node's fetch. Mirrors the web's routes/root.tsx
// listener: AppEventSchema-validates every frame, warns in dev on mismatches, reconnects on drops.
// The React layer (useAppEvents / useStreamStatus / the shared connection) is lib/app-stream.ts.
import { AppEventSchema, type AppEvent } from "@fabric/contracts";
import { apiBase } from "./api";

/** Any WHATWG fetch whose `response.body` is a ReadableStream (expo/fetch, node ≥ 18). */
export type FetchLike = typeof globalThis.fetch;

export interface SseFrame {
  event: string;
  data: string;
}

/** Takes every complete frame (blank-line terminated) off `input`; returns the remainder.
 * Handles `\n\n` and `\r\n\r\n` terminators and multi-line `data:` fields; comments are dropped. */
export function takeSseFrames(input: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  let buffer = input;
  for (;;) {
    const lf = buffer.indexOf("\n\n");
    const crlf = buffer.indexOf("\r\n\r\n");
    if (lf < 0 && crlf < 0) break;
    const end = crlf >= 0 && (lf < 0 || crlf < lf) ? crlf : lf;
    const raw = buffer.slice(0, end);
    buffer = buffer.slice(end + (end === crlf ? 4 : 2));
    const data: string[] = [];
    let event = "";
    for (const line of raw.split(/\r?\n/)) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (event || data.length) frames.push({ event, data: data.join("\n") });
  }
  return { frames, rest: buffer };
}

export type StreamState = "connecting" | "live" | "reconnecting";

export interface StreamStatus {
  state: StreamState;
  /** Consecutive failed attempts since the last live frame; 0 while healthy. */
  attempts: number;
  lastEventAt: number | undefined;
  lastEvent: AppEvent | undefined;
}

type Listener = { filter: (e: AppEvent) => boolean; cb: (e: AppEvent) => void };

const dev = typeof __DEV__ !== "undefined" && __DEV__;
/** The server heartbeats every 15 s (routes/stream.ts); a silent connection is dead by 45 s. */
const DEAD_AFTER_MS = 45_000;
const MAX_BACKOFF_MS = 15_000;
const backoffMs = (attempts: number) => Math.min(1000 * 2 ** (attempts - 1), MAX_BACKOFF_MS);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface AppStream {
  /** Events the filter returns true for. The first subscriber starts the connection; the last
   * unsubscribe stops it, so the app only holds a stream while a screen cares. */
  subscribe(filter: (e: AppEvent) => boolean, cb: (e: AppEvent) => void): () => void;
  onStatus(cb: (status: StreamStatus) => void): () => void;
  status(): StreamStatus;
  /** Drop the current connection and connect again now (used on foreground). No-op while live. */
  reconnect(): void;
}

/** One SSE connection to /api/stream with exponential backoff (capped) and a heartbeat watchdog. */
export function createAppStream(fetchImpl: FetchLike, baseUrl: string): AppStream {
  const listeners = new Set<Listener>();
  const statusListeners = new Set<(status: StreamStatus) => void>();
  let status: StreamStatus = { state: "connecting", attempts: 0, lastEventAt: undefined, lastEvent: undefined };
  let stopped = true;
  let running = false;
  let controller: AbortController | undefined;

  const push = (patch: Partial<StreamStatus>) => {
    status = { ...status, ...patch };
    for (const cb of statusListeners) cb(status);
  };

  const handleFrame = (frame: SseFrame): void => {
    status.attempts = 0; // any frame — hello, ping or app — proves the connection is alive
    if (frame.event === "app") {
      let value: unknown;
      try {
        value = JSON.parse(frame.data);
      } catch {
        if (dev) console.warn("[app stream] non-JSON data:", frame.data.slice(0, 120));
        return;
      }
      const parsed = AppEventSchema.safeParse(value);
      if (!parsed.success) {
        if (dev) console.warn("[app stream] invalid event", parsed.error.issues);
        return;
      }
      push({ state: "live", lastEventAt: Date.now(), lastEvent: parsed.data });
      for (const { filter, cb } of listeners) {
        if (!filter(parsed.data)) continue;
        try {
          cb(parsed.data);
        } catch (err) {
          console.warn("[app stream] listener failed", err instanceof Error ? err.message : err);
        }
      }
    } else if (frame.event === "hello") {
      push({ state: "live" });
    } else if (frame.event === "error" && dev) {
      console.warn("[app stream] server error frame:", frame.data.slice(0, 120));
    }
    // "ping" (the 15 s heartbeat) and unknown events carry nothing to invalidate with.
  };

  const readFrames = async (body: ReadableStream<Uint8Array>): Promise<void> => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let lastFrameAt = Date.now();
    for (;;) {
      const watchdog = new Promise<{ kind: "dead" }>((resolve) => {
        setTimeout(() => resolve({ kind: "dead" }), Math.max(0, DEAD_AFTER_MS - (Date.now() - lastFrameAt)));
      });
      const read = reader.read().then((r) => ({ ...r, kind: "read" as const }));
      const won = await Promise.race([read, watchdog]);
      if (won.kind === "dead") throw new Error("stream went silent (no frames within the heartbeat window)");
      if (won.value) {
        buffer += decoder.decode(won.value, { stream: true });
        const { frames, rest } = takeSseFrames(buffer);
        buffer = rest;
        for (const frame of frames) {
          lastFrameAt = Date.now();
          handleFrame(frame);
        }
      }
      if (won.done) throw new Error("stream ended");
    }
  };

  const run = async (): Promise<void> => {
    while (!stopped) {
      controller = new AbortController();
      try {
        push({ state: status.attempts > 0 ? "reconnecting" : "connecting" });
        const response = await fetchImpl(`${baseUrl}/api/stream`, {
          headers: { accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error(`stream ${response.status}`);
        await readFrames(response.body);
      } catch (err) {
        if (stopped || (err instanceof Error && err.name === "AbortError")) {
          if (!stopped) continue; // reconnect() dropped a stale connection — go again now
          break;
        }
        push({ state: "reconnecting", attempts: status.attempts + 1 });
        await sleep(backoffMs(status.attempts));
      }
    }
  };

  const kick = (): void => {
    if (running || stopped) return;
    running = true;
    void run().finally(() => {
      running = false;
    });
  };

  const idle = (): boolean => listeners.size === 0 && statusListeners.size === 0;

  return {
    subscribe(filter, cb) {
      const listener: Listener = { filter, cb };
      listeners.add(listener);
      stopped = false;
      kick();
      return () => {
        listeners.delete(listener);
        if (idle()) {
          stopped = true;
          controller?.abort();
        }
      };
    },
    onStatus(cb) {
      statusListeners.add(cb);
      cb(status);
      stopped = false;
      kick();
      return () => {
        statusListeners.delete(cb);
        if (idle()) {
          stopped = true;
          controller?.abort();
        }
      };
    },
    status: () => status,
    reconnect() {
      if (status.state === "live") return; // healthy — the watchdog covers silent deaths
      stopped = false;
      push({ attempts: 0 });
      controller?.abort();
      kick();
    },
  };
}
