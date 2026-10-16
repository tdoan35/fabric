// S5 (ANY-54): the session commands (RUNTIME §13 — the client posts the
// message, then follows the stream). Every handler is one store transaction:
// the facts and their `decide` job commit together or not at all. Schemas are
// S3's `@fabric/contracts` session module; the log is scoped to the one
// workspace constant until tenancy (ANY-46).
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import {
  CreateSessionRequestSchema,
  encodeFrame,
  PostMessageRequestSchema,
  RespondWaitRequestSchema,
  SetApprovalModeRequestSchema,
  type SessionDelta,
  type SessionFrame,
} from "@fabric/contracts";
import { fold } from "@fabric/core";
import { append, respond } from "@fabric/runtime";
import { enqueueDecide, getRuntime, sessionTurnDefinition, RUNTIME_WORKSPACE } from "../runtime/bootstrap";

/** A new session's opening facts: whose agent it hosts (S2) plus the turn
 * definition snapshot decide reads — S7's `sessionTurnDefinition` (Dana's for
 * `dana`, the S5 placeholder for everyone else until S9). */
const sessionEvents = async (agentId: string, incognito: boolean) => [
  {
    type: "session.created",
    actor: "api",
    payload: { agentId, incognito, surfaces: ["app"] },
  },
  {
    type: "run.created",
    actor: "api",
    payload: {
      definition: await sessionTurnDefinition(agentId, { incognito }),
      engineVersion: "s5",
      brief: "",
      grants: [],
      budgets: {},
      parent: null,
    },
  },
];

export const sessions = new Hono()
  // S11 (ANY-61): the thread list. Incognito sessions are excluded (PRODUCT
  // §10.7); the title is the first user message truncated to 60 chars, and
  // updatedAt is the head event's ts.
  .get("/sessions", async (c) => {
    const runtime = getRuntime();
    if (runtime === undefined) return c.json({ error: "runtime not started" }, 503);

    const rows = await runtime.store.transaction((tx) =>
      tx.query(
        `select s.id as stream_id,
                sc.payload ->> 'agentId' as agent_id,
                coalesce((sc.payload ->> 'incognito')::boolean, false) as incognito,
                (select e.payload ->> 'text' from events e
                  where e.stream_id = s.id and e.workspace_id = $1 and e.type = 'message.received'
                  order by e.seq limit 1) as title,
                (select e.ts from events e
                  where e.stream_id = s.id and e.workspace_id = $1
                  order by e.seq desc limit 1) as updated_at
         from streams s
         join lateral (select payload from events
                       where stream_id = s.id and workspace_id = $1 and type = 'session.created'
                       order by seq limit 1) sc on true
         where s.workspace_id = $1 and s.id like 'session:%'
           and coalesce((sc.payload ->> 'incognito')::boolean, false) = false
         order by updated_at desc, s.id desc`,
        [RUNTIME_WORKSPACE],
      )
    );
    const asTs = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));
    return c.json(
      rows.map((row) => ({
        sessionId: String(row.stream_id).slice("session:".length),
        agentId: String(row.agent_id ?? ""),
        title: String(row.title ?? "").slice(0, 60),
        updatedAt: asTs(row.updated_at),
        incognito: row.incognito === true,
      })),
    );
  })

  .post("/sessions", async (c) => {
    const runtime = getRuntime();
    if (runtime === undefined) return c.json({ error: "runtime not started" }, 503);
    const parsed = CreateSessionRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid create-session request" }, 400);

    const sessionId = randomUUID();
    const streamId = `session:${sessionId}`;
    // T14: the stamp (and S9's unknown-agent 404) lands before the transaction —
    // no stream exists when the agent id is bad.
    const events = await sessionEvents(parsed.data.agentId, parsed.data.incognito ?? false);
    await runtime.store.transaction((tx) =>
      append(tx, RUNTIME_WORKSPACE, [
        {
          streamId,
          events,
        },
      ]),
    );
    return c.json({ sessionId }, 200);
  })

  .post("/sessions/:id/messages", async (c) => {
    const runtime = getRuntime();
    if (runtime === undefined) return c.json({ error: "runtime not started" }, 503);
    const parsed = PostMessageRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid message" }, 400);

    const streamId = `session:${c.req.param("id")}`;
    const { clientMessageId, text } = parsed.data;

    // One transaction: existence, the (stream, platformMessageId) idempotency
    // check, the append and its decide job. The duplicate repost re-reads the
    // original seq and appends nothing.
    const outcome = await runtime.store.transaction(async (tx) => {
      const stream = await tx.query(
        "select head from streams where id = $1 and workspace_id = $2",
        [streamId, RUNTIME_WORKSPACE],
      );
      if (stream.length === 0) return { kind: "missing" } as const;

      const duplicate = await tx.query(
        `select seq from events
         where stream_id = $1 and workspace_id = $2
           and type = 'message.received' and payload->>'platformMessageId' = $3
         order by seq limit 1`,
        [streamId, RUNTIME_WORKSPACE, clientMessageId],
      );
      if (duplicate.length > 0) return { kind: "duplicate", seq: Number(duplicate[0]!.seq) } as const;

      await append(
        tx,
        RUNTIME_WORKSPACE,
        [
          {
            streamId,
            events: [
              {
                type: "message.received",
                actor: "user",
                payload: {
                  text,
                  attachments: parsed.data.attachments ?? [],
                  surface: "app",
                  sender: "user",
                  platformMessageId: clientMessageId,
                },
              },
            ],
          },
        ],
        { enqueue: enqueueDecide(runtime.queue) },
      );
      const head = await tx.query("select head from streams where id = $1", [streamId]);
      return { kind: "appended", seq: Number(head[0]!.head) } as const;
    });

    if (outcome.kind === "missing") return c.json({ error: "session not found" }, 404);
    return c.json({ seq: outcome.seq }, 200);
  })

  // S6 (ANY-55): the SSE session stream. The subscription is taken BEFORE the
  // backlog is read, and every drain pass re-reads the store from the last
  // sent seq, so a commit during the backlog is delivered exactly once, by
  // whichever pass reaches it — no gap, no duplicate on one connection. The
  // backlog is facts and telemetry; deltas and pings are live-only.
  .get("/sessions/:id/stream", async (c) => {
    const runtime = getRuntime();
    if (runtime === undefined) return c.json({ error: "runtime not started" }, 503);

    // Resume point: the header wins, then the query, then the stream start.
    const raw = c.req.header("Last-Event-ID") ?? c.req.query("after");
    let resume = 0;
    if (raw !== undefined && raw !== "") {
      resume = Number(raw);
      if (!Number.isInteger(resume) || resume < 0) {
        return c.json({ error: "invalid resume point" }, 400);
      }
    }

    const streamId = `session:${c.req.param("id")}`;
    // Existence via a bare read, never a check-transaction: a session stream
    // always carries its creation facts, so an empty read is an unknown id —
    // and a bare read cannot queue behind a worker's in-flight transaction the
    // way a check transaction would on the serialized (PGlite) driver, which
    // would delay the whole stream until the turn's transaction commits.
    const known = await runtime.store.readStream(streamId, {
      workspaceId: RUNTIME_WORKSPACE,
      fromSeq: 1,
    });
    if (known.length === 0) return c.json({ error: "session not found" }, 404);
    // S11 (ANY-61): a purged session's log is erased; its reads answer 410.
    if (known.some((event) => event.type === "content.erased")) {
      return c.json({ error: "session purged" }, 410);
    }

    const { live } = runtime;
    const encoder = new TextEncoder();
    let lastSent = resume;
    let closed = false;
    const pending = new Map<string, SessionDelta>();
    let flushTimer: ReturnType<typeof setInterval> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let activeClose: (() => void) | undefined;

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (frame: SessionFrame): void => {
          if (closed) return;
          controller.enqueue(encoder.encode(encodeFrame(frame)));
        };
        const fail = (error: unknown): void => {
          if (closed) return;
          closed = true;
          activeClose = undefined;
          controller.error(error);
        };

        // Subscribe first: anything appended from here on is ours to deliver.
        const unsubscribe = live.subscribe(streamId, {
          onAppend: (seq) => {
            if (seq > lastSent) kick();
          },
          onDelta: (delta) => pending.set(`${delta.turn}:${delta.callNo}`, delta),
        });

        // Serialized drains; each runs until the store yields nothing new.
        let tail: Promise<void> = Promise.resolve();
        const drain = async (): Promise<void> => {
          for (;;) {
            const events = await runtime.store.readStream(streamId, {
              workspaceId: RUNTIME_WORKSPACE,
              fromSeq: lastSent + 1,
            });
            if (events.length === 0) return;
            for (const event of events) {
              send({
                event: "event",
                id: event.seq,
                data: {
                  seq: event.seq,
                  type: event.type,
                  class: event.class as "fact" | "telemetry",
                  payload: event.payload,
                  ts: event.ts,
                },
              });
              lastSent = event.seq;
            }
          }
        };
        const kick = (): void => {
          tail = tail.then(drain).catch(fail);
        };

        activeClose = () => {
          if (closed) return;
          closed = true;
          unsubscribe();
          if (flushTimer !== undefined) clearInterval(flushTimer);
          if (pingTimer !== undefined) clearInterval(pingTimer);
          try {
            controller.close();
          } catch {
            // the client got there first
          }
        };

        void (async () => {
          kick();
          await tail;
          if (closed) return;
          // Mid-call join: the newest known text, at once; the rest batches.
          // Read `current` BEFORE clearing pending (R16): a delta landing in
          // between is strictly newer than the snapshot, so the flush never
          // re-sends the join frame — the frames keep strictly growing.
          const inFlight = live.current(streamId);
          pending.clear();
          if (inFlight !== null) send({ event: "delta", data: inFlight });

          flushTimer = setInterval(() => {
            if (pending.size === 0) return;
            for (const delta of pending.values()) send({ event: "delta", data: delta });
            pending.clear();
          }, 100);
          (flushTimer as unknown as { unref?: () => void }).unref?.();

          pingTimer = setInterval(() => send({ event: "ping" }), 15_000);
          (pingTimer as unknown as { unref?: () => void }).unref?.();
        })();
      },
      cancel: () => {
        activeClose?.();
      },
    });

    return c.body(body, 200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    });
  })

  // S8a (ANY-57): the proposal decision. The endpoint is the app's half of
  // PRODUCT §4: the transition runs once against the read model (the same
  // side effects the in-process decision applies — on approve, the team), and
  // the `proposal.decided` fact lands on the session stream in the same
  // transaction as its re-decide, so Dana's next turn consumes it. A decided
  // proposal answers 409 and appends nothing.
  .post("/sessions/:id/proposals/:proposalId/decision", async (c) => {
    const runtime = getRuntime();
    if (runtime === undefined) return c.json({ error: "runtime not started" }, 503);
    const proposals = runtime.proposals;
    if (proposals === undefined) return c.json({ error: "app database not configured" }, 503);

    const body = await c.req.json().catch(() => null);
    const decision = (body as { decision?: unknown } | null)?.decision;
    if (decision !== "approve" && decision !== "decline" && decision !== "discuss") {
      return c.json({ error: "invalid decision" }, 400);
    }
    const transition: "approved" | "declined" | "discuss" =
      decision === "approve" ? "approved" : decision === "decline" ? "declined" : "discuss";

    const sessionId = c.req.param("id");
    const proposalId = c.req.param("proposalId");
    const streamId = `session:${sessionId}`;

    const known = await runtime.store.transaction((tx) =>
      tx.query("select 1 from streams where id = $1 and workspace_id = $2", [streamId, RUNTIME_WORKSPACE]),
    );
    if (known.length === 0) return c.json({ error: "session not found" }, 404);

    const row = await proposals.byId(proposalId);
    if (row === undefined || row.sessionId !== sessionId) return c.json({ error: "proposal not found" }, 404);

    // the transition, once: a decided row moves nothing and touches nothing
    const applied = await proposals.decide(proposalId, transition);
    if (!applied) return c.json({ error: "proposal already decided" }, 409);

    await runtime.store.transaction((tx) =>
      append(
        tx,
        RUNTIME_WORKSPACE,
        [
          {
            streamId,
            events: [
              {
                type: "proposal.decided",
                actor: "api",
                payload: { kind: row.kind, decision, by: "user" },
              },
            ],
          },
        ],
        { enqueue: enqueueDecide(runtime.queue) },
      ),
    );
    return c.json({ proposalId, decision }, 200);
  })

  .get("/sessions/:id/events", async (c) => {
    const runtime = getRuntime();
    if (runtime === undefined) return c.json({ error: "runtime not started" }, 503);

    const after = Number(c.req.query("after") ?? "0");
    if (!Number.isInteger(after) || after < 0) {
      return c.json({ error: "invalid after cursor" }, 400);
    }

    const streamId = `session:${c.req.param("id")}`;
    const stream = await runtime.store.transaction((tx) =>
      tx.query(
        `select exists(select 1 from streams where id = $1 and workspace_id = $2) as known,
                exists(select 1 from events where stream_id = $1 and workspace_id = $2
                       and type = 'content.erased') as purged`,
        [streamId, RUNTIME_WORKSPACE],
      )
    );
    if (!stream[0]!.known) return c.json({ error: "session not found" }, 404);
    // S11 (ANY-61): a purged session's log is erased; its reads answer 410.
    if (stream[0]!.purged) return c.json({ error: "session purged" }, 410);

    const events = await runtime.store.readStream(streamId, {
      workspaceId: RUNTIME_WORKSPACE,
      fromSeq: after + 1,
    });
    return c.json(
      events.map((event) => ({
        seq: event.seq,
        type: event.type,
        class: event.class as "fact" | "telemetry",
        payload: event.payload,
        ts: event.ts,
      })),
    );
  })

  // T17 (ANY-82): the wait answer (RUNTIME §7). The answer comes from the app,
  // so `surface: "app"` — gated waits take app answers only — and R10's
  // `respond` owns the open-check/append/re-decide transaction and its refusal
  // reasons. An `approve:` wait takes the decision words only, checked before
  // anything is touched; every other wait takes any non-empty text.
  .post("/sessions/:id/waits/:waitId", async (c) => {
    const runtime = getRuntime();
    if (runtime === undefined) return c.json({ error: "runtime not started" }, 503);
    const parsed = RespondWaitRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid decision" }, 400);

    const waitId = c.req.param("waitId");
    const { decision } = parsed.data;
    if (waitId.startsWith("approve:") && decision !== "approve" && decision !== "deny") {
      return c.json({ error: "invalid decision for an approve wait" }, 400);
    }

    const streamId = `session:${c.req.param("id")}`;
    const known = await runtime.store.transaction((tx) =>
      tx.query("select 1 from streams where id = $1 and workspace_id = $2", [streamId, RUNTIME_WORKSPACE]),
    );
    if (known.length === 0) return c.json({ error: "session not found" }, 404);

    const result = await respond(runtime.store, RUNTIME_WORKSPACE, streamId, waitId, decision, {
      by: "user",
      surface: "app",
      queue: runtime.queue,
    });
    return result.outcome === "accepted"
      ? c.json({ outcome: "accepted" }, 200)
      : c.json({ outcome: "refused", reason: result.reason }, 409);
  })

  // T17 (ANY-82): the approval mode (RUNTIME §13, PRODUCT §8.3). One
  // transaction: fold the stream, append `session.approval_mode_set` only on a
  // real change. No `decide` job — T3 applies the mode from the next decision
  // and never retro-approves a held wait.
  .put("/sessions/:id/approval-mode", async (c) => {
    const runtime = getRuntime();
    if (runtime === undefined) return c.json({ error: "runtime not started" }, 503);
    const parsed = SetApprovalModeRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid approval mode" }, 400);
    const { mode } = parsed.data;

    const streamId = `session:${c.req.param("id")}`;
    const outcome = await runtime.store.transaction(async (tx) => {
      const known = await tx.query("select 1 from streams where id = $1 and workspace_id = $2", [
        streamId,
        RUNTIME_WORKSPACE,
      ]);
      if (known.length === 0) return { kind: "missing" } as const;

      const rows = await tx.query(
        `select id, workspace_id, stream_id, seq, type, class, v, actor, causation, ts, payload
         from events where stream_id = $1 and workspace_id = $2 order by seq`,
        [streamId, RUNTIME_WORKSPACE],
      );
      // the log's snake_case rows into the envelope `fold` parses (the same
      // shape the runtime's own event readers hand it)
      const state = fold(
        rows.map((row) => {
          const ts: unknown = row.ts;
          return {
            id: String(row.id),
            workspaceId: String(row.workspace_id),
            streamId: String(row.stream_id),
            seq: Number(row.seq),
            type: String(row.type),
            class: String(row.class) as "fact" | "telemetry",
            v: Number(row.v),
            actor: String(row.actor),
            causation: row.causation === null || row.causation === undefined ? null : String(row.causation),
            ts: ts instanceof Date ? ts.toISOString() : String(ts),
            payload: row.payload,
          };
        }),
      );
      if (state.approvalMode !== mode) {
        await append(tx, RUNTIME_WORKSPACE, [
          {
            streamId,
            events: [{ type: "session.approval_mode_set", actor: "api", payload: { mode } }],
          },
        ]);
      }
      return { kind: "set", mode } as const;
    });

    if (outcome.kind === "missing") return c.json({ error: "session not found" }, 404);
    return c.json({ mode: outcome.mode }, 200);
  });
