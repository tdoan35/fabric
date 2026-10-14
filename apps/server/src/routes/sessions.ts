// S5 (ANY-54): the session commands (RUNTIME §13 — the client posts the
// message, then follows the stream). Every handler is one store transaction:
// the facts and their `decide` job commit together or not at all. Schemas are
// S3's `@fabric/contracts` session module; the log is scoped to the one
// workspace constant until tenancy (ANY-46).
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { CreateSessionRequestSchema, PostMessageRequestSchema } from "@fabric/contracts";
import { append } from "@fabric/runtime";
import { enqueueDecide, getRuntime, RUNTIME_WORKSPACE } from "../runtime/bootstrap";

/** A new session's opening facts: whose agent it hosts (S2) plus the turn
 * definition snapshot decide reads — the S7 stand-in per the card. */
const sessionEvents = (agentId: string, incognito: boolean) => [
  {
    type: "session.created",
    actor: "api",
    payload: { agentId, incognito, surfaces: ["app"] },
  },
  {
    type: "run.created",
    actor: "api",
    payload: {
      definition: { tools: [], maxSteps: 6, surfaces: ["app"], turnCostCapUsd: null },
      engineVersion: "s5",
      brief: "",
      grants: [],
      budgets: {},
      parent: null,
    },
  },
];

export const sessions = new Hono()
  .post("/sessions", async (c) => {
    const runtime = getRuntime();
    if (runtime === undefined) return c.json({ error: "runtime not started" }, 503);
    const parsed = CreateSessionRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid create-session request" }, 400);

    const sessionId = randomUUID();
    const streamId = `session:${sessionId}`;
    await runtime.store.transaction((tx) =>
      append(tx, RUNTIME_WORKSPACE, [
        {
          streamId,
          events: sessionEvents(parsed.data.agentId, parsed.data.incognito ?? false),
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

  .get("/sessions/:id/events", async (c) => {
    const runtime = getRuntime();
    if (runtime === undefined) return c.json({ error: "runtime not started" }, 503);

    const after = Number(c.req.query("after") ?? "0");
    if (!Number.isInteger(after) || after < 0) {
      return c.json({ error: "invalid after cursor" }, 400);
    }

    const streamId = `session:${c.req.param("id")}`;
    const stream = await runtime.store.transaction((tx) =>
      tx.query("select 1 from streams where id = $1 and workspace_id = $2", [
        streamId,
        RUNTIME_WORKSPACE,
      ]),
    );
    if (stream.length === 0) return c.json({ error: "session not found" }, 404);

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
  });
