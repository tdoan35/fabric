// T6 red-commit fixtures (ANY-72): injected fakes for the Exa and AgentMail
// clients and a local HTTP origin for `web_fetch`. Kept free of `../builtin`
// imports so the red run fails per case on the missing module, not here.
import type { IncomingMessage, Server, ServerResponse } from "node:http";

/** The slice of the Exa client the tool uses: one search, results mapped. */
export interface FakeExa {
  search: (
    query: string,
    options?: unknown
  ) => Promise<{
    results: Array<{ title: string | null; url: string; highlights?: string[]; text?: string }>;
  }>;
}

/** The slice of AgentMail the send tool uses. */
export interface FakeAgentMail {
  inboxes: {
    messages: {
      send: (
        inboxId: string,
        request: { to?: string; subject?: string; text?: string },
        requestOptions?: { idempotencyKey?: string }
      ) => Promise<{ messageId: string; threadId: string }>;
    };
  };
}

export interface RecordingExa extends FakeExa {
  calls: Array<{ query: string; options: unknown }>;
}

export const fakeExa = (hits: Array<{ title: string; url: string; highlight: string }>): RecordingExa => {
  const calls: Array<{ query: string; options: unknown }> = [];
  return {
    calls,
    search: async (query, options) => {
      calls.push({ query, options });
      return {
        results: hits.map((h) => ({ title: h.title, url: h.url, highlights: [h.highlight] })),
      };
    },
  };
};

export interface RecordedSend {
  inboxId: string;
  request: Record<string, unknown>;
  options: Record<string, unknown> | undefined;
}

export interface RecordingAgentMail extends FakeAgentMail {
  sends: RecordedSend[];
}

export const fakeAgentMail = (messageId = "am-1"): RecordingAgentMail => {
  const sends: RecordedSend[] = [];
  return {
    sends,
    inboxes: {
      messages: {
        send: async (inboxId, request, options) => {
          sends.push({
            inboxId,
            request: { ...request },
            options: options === undefined ? undefined : { ...options },
          });
          return { messageId, threadId: "th-1" };
        },
      },
    },
  };
};

/** A plain scope; tests add `secret`/`callId` per case. */
export const baseScope = { workspaceId: "ws-t6", streamId: "run:t6", agentId: "agent-1" };

export interface LocalOrigin {
  server: Server;
  url: string;
  close: () => Promise<void>;
}

/** One listening HTTP origin on 127.0.0.1: the W4 page and redirect targets. */
export const startOrigin = async (
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<LocalOrigin> => {
  const { createServer } = await import("node:http");
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  return {
    server,
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
};
