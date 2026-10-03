// DATA owns this file. Run read models, the SSE tail, splice and finalize-splice (§4.2, D5).
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { sql } from "drizzle-orm";
import { SpliceRequestSchema } from "@fabric/contracts";
import type { RunEvent } from "@fabric/contracts";
import { getRunRow, listSnapshots, mergedEvents, readRun } from "@fabric/db";
import { hub } from "../services/hub";
import { runtime } from "../services/runtime";
import { finalizeRun } from "../services/finalize";
import { spliceRun } from "../services/splice";

/** One SSE connection tailing a run: replay seq > after, then live. Hub wakes instantly for
 *  same-process emits; the 400 ms poll catches other writers (sim runs in its own process). */
export const runs = new Hono()
  .get("/runs", async (c) => {
    const rows = (await runtime().db.db.execute(sql`
      select r.id from runs r join tasks t on t.id = r.task_id order by t.ord asc, r.n asc`)).rows as { id: string }[];
    const out = [];
    for (const { id } of rows) {
      const run = await readRun(runtime().db, id);
      if (run) out.push(run);
    }
    return c.json(out);
  })
  .get("/runs/:id", async (c) => {
    const run = await readRun(runtime().db, c.req.param("id"));
    return run ? c.json(run) : c.json({ error: "run not found" }, 404);
  })
  .get("/runs/:id/events", async (c) => {
    const { db } = runtime();
    const row = await getRunRow(db, c.req.param("id"));
    return row ? c.json(await mergedEvents(db, row)) : c.json({ error: "run not found" }, 404);
  })
  .get("/runs/:id/stream", (c) => {
    const { db } = runtime();
    const runId = c.req.param("id");
    const after = Number(c.req.query("after") ?? 0) || 0;
    return streamSSE(c, async (stream) => {
      let lastSeq = after;
      let closed = false;
      stream.onAbort(() => { closed = true; });
      const wakeups = new Set<() => void>();
      const unsub = hub.subscribeRun(runId, (e) => {
        if (e.seq > lastSeq) for (const w of wakeups) w();
      });
      const heartbeat = setInterval(() => {
        void stream.writeSSE({ event: "ping", data: "" }).catch(() => (closed = true));
      }, 15_000);
      try {
        while (!closed) {
          const rows = (await db.db.execute(sql`
            select * from run_events where run_id = ${runId} and seq > ${lastSeq} order by seq`
          )).rows as unknown as { run_id: string; seq: number; t: string; type: RunEvent["type"]; actor_agent_id: string | null; payload: Record<string, unknown> }[];
          for (const r of rows) {
            const event: RunEvent = { runId: r.run_id, seq: r.seq, t: Number(r.t), type: r.type, actorAgentId: r.actor_agent_id ?? undefined, payload: r.payload };
            await stream.writeSSE({ event: "run", data: JSON.stringify(event) });
            lastSeq = r.seq;
          }
          if (closed || !rows.length) {
            const { promise, resolve } = Promise.withResolvers<void>();
            if (rows.length) continue;
            const timer = setTimeout(() => {
              wakeups.delete(resolve);
              resolve();
            }, 400);
            wakeups.add(resolve);
            await promise;
            clearTimeout(timer);
          }
        }
      } finally {
        unsub();
        clearInterval(heartbeat);
      }
    });
  })
  .get("/runs/:id/snapshots", async (c) => c.json(await listSnapshots(runtime().db, c.req.param("id"))))
  .post("/runs/:id/splice", async (c) => {
    const parsed = SpliceRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "body must be {t: number}" }, 400);
    const result = await spliceRun(c.req.param("id"), parsed.data.t);
    return result.ok ? c.json(result.body) : c.json({ error: result.error }, result.status);
  })
  .post("/runs/:id/finalize-splice", async (c) => {
    const runId = c.req.param("id");
    const row = await getRunRow(runtime().db, runId);
    if (!row) return c.json({ error: "run not found" }, 404);
    if (!row.spliced_from_run_id) return c.json({ error: `${runId} was not spliced` }, 409);
    const result = await finalizeRun(runId);
    return result ? c.json({ reportId: result.reportId }) : c.json({ error: "finalize produced no report" }, 500);
  });
