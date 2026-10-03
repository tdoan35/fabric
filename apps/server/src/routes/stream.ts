// DATA owns this file. SSE of AppEvents (§4.4): invalidation only, no replay, 15 s heartbeat.
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEvent } from "@fabric/contracts";
import { hub } from "../services/hub";

export const stream = new Hono().get("/stream", (c) =>
  streamSSE(c, async (stream) => {
    let closed = false;
    stream.onAbort(() => { closed = true; });
    const queue: AppEvent[] = [];
    const wakeups = new Set<() => void>();
    const unsub = hub.subscribeApp((e) => {
      queue.push(e);
      for (const w of wakeups) w();
    });
    const heartbeat = setInterval(() => {
      void stream.writeSSE({ event: "ping", data: "" }).catch(() => (closed = true));
    }, 15_000);
    try {
      await stream.writeSSE({ event: "hello", data: JSON.stringify({ ok: true }) });
      while (!closed) {
        while (queue.length && !closed) {
          await stream.writeSSE({ event: queue[0].type.split(".")[0], data: JSON.stringify(queue.shift()) });
        }
        if (closed) break;
        const { promise, resolve } = Promise.withResolvers<void>();
        const timer = setTimeout(() => {
          wakeups.delete(resolve);
          resolve();
        }, 250);
        wakeups.add(resolve);
        await promise;
        clearTimeout(timer);
      }
    } finally {
      unsub();
      clearInterval(heartbeat);
    }
  }));
