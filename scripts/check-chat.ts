#!/usr/bin/env node
// npm run check:chat [-- [--live] [--port 8891]]
//
// DANA's re-runnable end-to-end check (§7.0 step 4), on the session path
// (RUNTIME §13 — post, then follow). The one-response chat turn retired with
// S14; this check drives a real session instead:
//
//   1. boots the server on a throwaway PGlite runtime, MODEL_PORT=test by
//      default (the echo double: every reply is `echo: <text>`), or the real
//      models with --live when provider keys are present;
//   2. asserts the retired one-response POST /api/chat is gone (404);
//   3. creates a session for Dana, posts a message and follows the stream to
//      the `agent.message` reply;
//   4. resumes from the last seq after a disconnect: the second reply arrives
//      exactly once, and nothing at or before the cursor is replayed;
//   5. the event log itself holds exactly one copy of each reply.
//
// Never prints connection strings or keys. Exits non-zero on any failure.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const live = flag("live");
const port = Number(value("port", "8891"));
const base = `http://localhost:${port}`;
const hasProviderKey = ["OPENROUTER_API_KEY", "SPARK_API_KEY", "NEON_AI_GATEWAY_TOKEN"].some((k) => process.env[k]);
const modelPort = live && hasProviderKey ? "ai" : "test";

let serverLogs = "";
const ok = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(`✗ ${msg}\n  server (tail): ${serverLogs.slice(-1500)}`);
  console.log(`  ✓ ${msg}`);
};
const info = (msg: string) => console.log(msg);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- server lifecycle (detached + group kill, like the other checks) ----
const procs: ReturnType<typeof spawn>[] = [];
const stopAll = () => {
  for (const p of procs) {
    try { process.kill(-p.pid!, "SIGTERM"); } catch { /* already gone */ }
  }
};
process.on("exit", stopAll);
process.on("SIGINT", () => { stopAll(); process.exit(130); });
process.on("SIGTERM", () => { stopAll(); process.exit(143); });

const startServer = async (runtimeDir: string) => {
  const server = spawn("npx", ["tsx", "apps/server/src/index.ts"], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env, PORT: String(port), MODEL_PORT: modelPort,
      RUNTIME_PGLITE_DIR: runtimeDir, RUNTIME_CONCURRENCY: "2", SCHEDULER: "off",
    },
  });
  procs.push(server);
  let logs = "";
  server.stdout!.on("data", (c) => { logs += c.toString(); serverLogs = logs; });
  server.stderr!.on("data", (c) => { logs += c.toString(); serverLogs = logs; });
  server.on("exit", (code) => { if (code !== 0 && code !== null) console.error(`server exited ${code}:\n${logs.slice(-3000)}`); });
  for (let i = 0; i < 120; i++) {
    if (await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false)) return;
    await sleep(250);
  }
  throw new Error(`server never came up on ${base}:\n${logs.slice(-2000)}`);
};

// ---- session helpers (the S13 client shape, inline: no app imports) ----

interface SessionEvent { seq: number; type: string; payload: Record<string, unknown> }
const textOf = (event: SessionEvent): string | undefined => {
  const text = (event.payload as { text?: unknown } | null)?.text;
  return typeof text === "string" ? text : undefined;
};

const post = async (path: string, body: unknown) => {
  const res = await fetch(`${base}/api${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "app://fabric" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
};

/** Follow the session SSE until `until` matches; the connection aborts on the hit. */
async function followUntil(
  sessionId: string,
  after: number | undefined,
  until: (events: SessionEvent[]) => SessionEvent | undefined,
  tag: string,
  timeoutMs = 20_000,
): Promise<{ hit: SessionEvent; events: SessionEvent[] }> {
  const controller = new AbortController();
  const events: SessionEvent[] = [];
  const arrived = (async (): Promise<SessionEvent> => {
    const res = await fetch(`${base}/api/sessions/${sessionId}/stream${after !== undefined ? `?after=${after}` : ""}`, {
      headers: { Accept: "text/event-stream" }, signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`${tag}: session stream → ${res.status}`);
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk as Uint8Array, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!data) continue;
        try { events.push(JSON.parse(data.slice(6)) as SessionEvent); } catch { /* keep-alive noise */ }
        const hit = until(events);
        if (hit) {
          controller.abort(); // the intentional disconnect
          return hit;
        }
      }
    }
    throw new Error(`${tag}: the stream closed before the expected event`);
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${tag}: nothing arrived in ${timeoutMs / 1000}s`)), timeoutMs); });
  const hit = await Promise.race([arrived, timedOut]).finally(() => clearTimeout(timer));
  return { hit, events };
}

/** The event log, polled until an agent.message lands past `afterSeq`. */
const waitAgentMessage = async (sessionId: string, afterSeq: number, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${base}/api/sessions/${sessionId}/events?after=0`);
    if (!res.ok) throw new Error(`GET events → ${res.status}`);
    const log = (await res.json()) as SessionEvent[];
    if (log.some((e) => e.type === "agent.message" && e.seq > afterSeq)) return log;
    if (Date.now() > deadline) throw new Error(`no agent.message within ${timeoutMs / 1000}s (log: ${log.map((e) => e.type).join(", ")})`);
    await sleep(250);
  }
};

// =====================================================================================
const startedAll = Date.now();
const runtimeDir = await mkdtemp(join(tmpdir(), "fabric-check-chat-"));

info(`1. booting the server (MODEL_PORT=${modelPort}, throwaway runtime ${runtimeDir}) …`);
await startServer(runtimeDir);

info("2. the retired one-response path answers 404");
const retired = await fetch(`${base}/api/chat`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ sessionId: "c1", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
});
ok(retired.status === 404, `POST /api/chat → ${retired.status} (retired with S14)`);

info("3. a session for Dana, one turn, the reply on the stream");
const sessionRes = await post("/sessions", { agentId: "dana" });
const session = (await sessionRes.json()) as { sessionId: string };
ok(typeof session.sessionId === "string" && session.sessionId.length > 0, `session ${session.sessionId} created (agent dana)`);

const first = live ? "Reply with one short sentence about the weather." : "first reply must echo";
await post(`/sessions/${session.sessionId}/messages`, { clientMessageId: randomUUID(), text: first });
const expectedFirst = live ? undefined : `echo: ${first}`;
const run1 = await followUntil(
  session.sessionId, undefined,
  (events) => events.find((e) => e.type === "agent.message" && (expectedFirst === undefined || textOf(e) === expectedFirst) && !!textOf(e)),
  "3. the first reply",
);
const lastSeq = Math.max(...run1.events.map((e) => e.seq));
ok(true, `reply "${(textOf(run1.hit) ?? "").slice(0, 60)}" at seq ${run1.hit.seq} (${run1.events.length} frames)`);

info("4. disconnect, post again, resume from the last seq");
const second = live ? "And now one about the sea." : "second reply after the reconnect";
await post(`/sessions/${session.sessionId}/messages`, { clientMessageId: randomUUID(), text: second });
const expectedSecond = live ? undefined : `echo: ${second}`;
const run2 = await followUntil(
  session.sessionId, lastSeq,
  (events) => events.find((e) => e.type === "agent.message" && (expectedSecond === undefined || textOf(e) === expectedSecond) && e.seq > lastSeq),
  "4. the second reply",
);
const repeats = run2.events.filter((e) => e.type === "agent.message" && (expectedSecond === undefined || textOf(e) === expectedSecond) && e.seq > lastSeq).length;
ok(repeats === 1, "the second reply arrived exactly once after the resume");
ok(run2.events.every((e) => e.seq > lastSeq), `nothing at or before the cursor replayed (seq ≤ ${lastSeq})`);

info("5. the event log holds exactly one copy of each reply");
await sleep(1_000); // let any runaway appends land
const log = await waitAgentMessage(session.sessionId, run2.hit.seq);
const copiesOf = (needle: string | undefined, since = 0) =>
  log.filter((e) => e.type === "agent.message" && e.seq > since && (needle === undefined || textOf(e) === needle)).length;
if (live) {
  ok(copiesOf(undefined, 0) >= 2, `both replies landed in the log (${log.filter((e) => e.type === "agent.message").length} agent messages)`);
} else {
  ok(copiesOf(`echo: ${first}`) === 1, "exactly one copy of the first reply in the log");
  ok(copiesOf(`echo: ${second}`, lastSeq) === 1, "exactly one copy of the second reply in the log");
}

console.log(`\ncheck:chat PASSED in ${((Date.now() - startedAll) / 1000).toFixed(1)}s · MODEL_PORT=${modelPort} · session ${session.sessionId}`);
stopAll();
process.exit(0);
