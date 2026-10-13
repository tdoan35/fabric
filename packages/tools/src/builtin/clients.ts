// The clients the step-0 tools talk to (ANY-72): narrow structural slices,
// resolved per call. Nothing here is module-level and nothing reads
// `process.env` — the key arrives through `scope.secret`, the client through
// the injection point `clients.ts` exists to type. `packages/integrations`
// keeps its own clients until ANY-43 deletes them (D8).
import Exa from "exa-js";
import { AgentMailClient } from "agentmail";

/** The slice of the Exa client `web_search` uses. The real client satisfies
 * it structurally; tests inject fakes. */
export interface ExaLike {
  search(
    query: string,
    options?: { numResults?: number; contents?: { highlights: true } }
  ): Promise<{
    results: Array<{
      title: string | null;
      url: string;
      highlights?: string[];
      text?: string;
    }>;
  }>;
}

/** The slice of AgentMail `send` uses; `idempotencyKey` rides in the request
 * options when the SDK honours one. */
export interface AgentMailLike {
  inboxes: {
    messages: {
      send(
        inboxId: string,
        request: { to?: string; subject?: string; text?: string },
        requestOptions?: { idempotencyKey?: string }
      ): Promise<{ messageId: string; threadId?: string }>;
    };
  };
}

/** Injection point: default constructors over the caller's key. */
export type ToolClients = {
  exa: (apiKey: string) => ExaLike;
  agentmail: (apiKey: string) => AgentMailLike;
};

export const defaultClients: ToolClients = {
  exa: (apiKey) => new Exa(apiKey) as ExaLike,
  agentmail: (apiKey) => new AgentMailClient({ apiKey }) as unknown as AgentMailLike,
};
