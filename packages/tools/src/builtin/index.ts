// @fabric/tools/builtin (ANY-72, ANY-44 D1 step 0): the tools that run inside
// `tool.exec` on the server and need no machine. Credentials come straight
// from the vault through `ToolScope.secret`; no broker, no host.
//
// Injection: the tool set is built once with defaults, but `execute` reads
// client instances off the scope when present (`exa`, `agentmail`) — the seam
// tests fake the SDKs through, with zero network.
import type { ToolDef } from "../define";
import type { ToolExecCtx } from "../define";
import { webSearchTool } from "./web-search";
import { webFetchTool } from "./web-fetch";
import { sendTool, type SendDeps } from "./send";

export {
  defaultClients,
  type AgentMailLike,
  type ExaLike,
  type ToolClients,
} from "./clients";
export type { SendDeps };

/** The step-0 set. `sendFrom` is the inbox `send` sends from; the factory
 * binds it once at assembly. */
export const builtinTools = (options: SendDeps): ToolDef[] => [
  scopeWrapped(webSearchTool()),
  webFetchTool(),
  scopeWrapped(sendTool({ sendFrom: options.sendFrom })),
];

/** Wraps a tool so `execute` merges scope-carried clients into the scope the
 * inner tool sees; production scopes carry none and fall through to the
 * module defaults inside each tool. */
const scopeWrapped = (tool: ToolDef): ToolDef => ({
  ...tool,
  async execute(args, ctx) {
    const merged = mergeScopeClients(ctx.scope);
    const nextCtx: ToolExecCtx =
      merged === null ? ctx : { ...ctx, scope: { ...ctx.scope, ...merged } };
    return tool.execute(args, nextCtx);
  },
});

/** `exa` / `agentmail` on the scope replace the defaults for that call. */
const mergeScopeClients = (scope: Record<string, unknown>): Record<string, unknown> | null => {
  const candidate = scope as Partial<Record<"exa" | "agentmail", unknown>>;
  if (candidate.exa === undefined && candidate.agentmail === undefined) return null;
  const merged: Record<string, unknown> = {};
  if (candidate.exa !== undefined) merged.exa = candidate.exa;
  if (candidate.agentmail !== undefined) merged.agentmail = candidate.agentmail;
  return merged;
};
