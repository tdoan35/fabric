/**
 * S13 protocol smoke: drives lib/chat.ts's send path (the same helpers the app
 * runs under expo/fetch) and @fabric/contracts' followSession (the client
 * lib/session-stream.ts follows) against a live server started with
 * `MODEL_PORT=test npm run dev:server` — the echo double
 * (apps/server/src/runtime/test-model.ts): every reply is `echo: <text>`.
 *
 *   1. create a session;
 *   2. post a message;
 *   3. follow the stream until the `agent.message` reply arrives;
 *   4. disconnect, post again, reconnect from the last seq;
 *   5. the second reply arrives exactly once, with nothing replayed at or
 *      before the resume cursor.
 *
 * Exits non-zero on any failure. The MOB-E fixture mode is gone (S13).
 */
import { followSession, type FetchLike, type SessionDelta, type SessionEvent } from "@fabric/contracts";
import { createChatSession, sendChatMessage } from "../lib/chat";

const base = (process.env.EXPO_PUBLIC_API_URL || "http://localhost:8787").replace(/\/$/, "");
const WAIT_MS = 15_000;
const fail = (msg: string): never => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};
// Top-level awaits that throw (a dead server refuses connections) still exit
// non-zero on their own; this prints the cause as a FAIL line on the way out.
process.on("unhandledRejection", (err: unknown) => {
  fail(err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err));
});
// Nothing may hang the script past this.
const watchdog = setTimeout(() => fail("deadline: the smoke did not finish in 45 s"), 45_000);

const textOf = (event: SessionEvent): string | undefined => {
  const payload = event.payload as { text?: unknown } | null;
  return typeof payload?.text === "string" ? payload.text : undefined;
};

/** followSession never ends on its own — drive it until `until` picks an event,
 * then abort: the disconnect the resume step needs. */
async function followUntil(
  sessionId: string,
  after: number | undefined,
  until: (events: SessionEvent[], deltas: SessionDelta[]) => SessionEvent | undefined,
  tag: string,
): Promise<{ hit: SessionEvent; events: SessionEvent[]; deltas: SessionDelta[] }> {
  const controller = new AbortController();
  const events: SessionEvent[] = [];
  const deltas: SessionDelta[] = [];
  let hit: SessionEvent | undefined;
  const arrived = new Promise<void>((resolve) => {
    void followSession(fetch as FetchLike, base, sessionId, {
      after,
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event);
        if (!hit) {
          hit = until(events, deltas);
          if (hit) resolve();
        }
      },
      onDelta: (delta) => {
        deltas.push(delta);
      },
    }).catch((err: unknown) => {
      // An aborted reader rejects on node ("This operation was aborted"):
      // the intentional disconnect, not a failure.
      if (controller.signal.aborted) return;
      fail(`${tag}: the stream errored: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${tag}: nothing arrived in ${WAIT_MS / 1000} s`)), WAIT_MS);
  });
  await Promise.race([arrived, timedOut]).catch((err: unknown) =>
    fail(err instanceof Error ? err.message : String(err)),
  );
  clearTimeout(timer);
  controller.abort(); // the disconnect — an aborted client resolves its loop
  return { hit: hit!, events, deltas };
}

// ---- 1. create a session ----
const sessionId = await createChatSession(fetch as FetchLike, "dana");
console.log(`1. session ${sessionId} created (agent dana)`);

// ---- 2. post a message ----
const first = "first reply must echo";
await sendChatMessage(fetch as FetchLike, sessionId, first);
console.log(`2. posted: "${first}"`);

// ---- 3. follow the stream until the reply ----
const run1 = await followUntil(
  sessionId,
  undefined,
  (events) => events.find((e) => e.type === "agent.message" && textOf(e) === `echo: ${first}`),
  "3. the first reply",
);
const lastSeq = Math.max(...run1.events.map((e) => e.seq));
console.log(`3. reply "echo: …" arrived at seq ${run1.hit.seq} — ${run1.events.length} events, ${run1.deltas.length} deltas, log head seq ${lastSeq}`);

// ---- 4. disconnect (run1 aborted on return), post again, reconnect from the last seq ----
const second = "second reply after the reconnect";
await sendChatMessage(fetch as FetchLike, sessionId, second);
console.log(`4. posted while disconnected: "${second}"; resuming from seq ${lastSeq}`);

// ---- 5. the second reply arrives exactly once ----
const run2 = await followUntil(
  sessionId,
  lastSeq,
  (events) => events.find((e) => e.type === "agent.message" && textOf(e) === `echo: ${second}`),
  "5. the second reply",
);
const repeats = run2.events.filter((e) => e.type === "agent.message" && textOf(e) === `echo: ${second}`).length;
if (repeats !== 1) fail(`5. the second reply arrived ${repeats}× after resume — expected exactly once`);
const replayed = run2.events.filter((e) => e.seq <= lastSeq);
if (replayed.length > 0) fail(`5. the resume replayed ${replayed.length} frame(s) at or before the cursor (seq ≤ ${lastSeq})`);
const firstAgain = run2.events.filter((e) => e.type === "agent.message" && textOf(e) === `echo: ${first}`).length;
if (firstAgain > 0) fail("5. the first reply was re-delivered after the resume");
console.log(`5. reply at seq ${run2.hit.seq} arrived exactly once; ${run2.events.length} events, nothing at or before the cursor`);

clearTimeout(watchdog);
console.log(`SMOKE OK — session ${sessionId}: 2 posts, 2 echo replies, resume exact`);
