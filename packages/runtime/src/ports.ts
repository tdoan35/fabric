// The worker ports (RUNTIME §4–§6, ANY-35 R9a). The job handlers in
// `workers/` run exclusively behind these seams, so no test — and no CI run —
// ever reaches a real provider. R9b (`tool.exec`) and R9c (`delegate.resolve`,
// `deliver`) implement against the same three ports.
//
// Every port is a plain interface: the production adapters arrive with the
// integrations epic; the runtime ships the contracts and the fakes.

// -- ModelPort -----------------------------------------------------------------

/** One tool as the worker hands it to the model: a declaration to call, never
 * an `execute` (RUNTIME §4 — the SDK returns tool calls; `tool.exec` runs them). */
export type ModelTool = {
  name: string;
  description?: string;
  /** JSON schema of the arguments, provider-shaped. */
  parameters?: unknown;
};

/** One conversation message as the worker rebuilds it from facts (§5.1). */
export type ModelMessage = {
  role: "user" | "assistant" | "tool";
  text: string;
  /** The `tool.call` id, on role `tool`. */
  toolCallId?: string;
  /** The assistant's requested calls, on role `assistant` — the log's `toolCalls` verbatim. */
  toolCalls?: readonly Record<string, unknown>[];
};

/** A live token delta. Deltas are pushed, never logged (§8). */
export type ModelDelta = { text: string };

export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

/** What the fold's rules and `ll.completed` carry — the raw record shape, uninterpreted. */
export type ModelResult = {
  text: string;
  toolCalls: readonly Record<string, unknown>[];
  usage: ModelUsage;
  finishReason: string;
};

/** The error a model call raises; the retry policy reads the three fields (§4). */
export class ModelError extends Error {
  readonly status?: number;
  /** Seconds the provider asked us to wait; honoured as a floor by the queue's backoff. */
  readonly retryAfter?: number;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { status?: number; retryAfter?: number; retryable: boolean }
  ) {
    super(message);
    this.name = "ModelError";
    if (options.status !== undefined) this.status = options.status;
    if (options.retryAfter !== undefined) this.retryAfter = options.retryAfter;
    this.retryable = options.retryable;
  }
}

export type ModelCallRequest = {
  system: string;
  messages: readonly ModelMessage[];
  tools: readonly ModelTool[];
  /** Live deltas during the call; absent when nobody listens. */
  onDelta?: (delta: ModelDelta) => void;
};

/** One model. A port instance is bound to one provider endpoint; `llm.requested`'s
 * `model` field picks the wiring, not the call (RUNTIME §4: call the model once). */
export type ModelPort = {
  call(request: ModelCallRequest): Promise<ModelResult>;
};

// -- ToolPort ------------------------------------------------------------------

/** The effect class every tool declares (RUNTIME §6); `tool.call` records it
 * before `tool.exec` runs, so a crash leaves the attempt on the log. */
export type ToolEffect = "read" | "idempotent" | "rerunnable" | "once";

export type ToolDescriptor = {
  name: string;
  effect: ToolEffect;
  description?: string;
  parameters?: unknown;
  /** Absent on the descriptors the model sees: the SDK returns calls instead. */
  execute?: (
    args: Record<string, unknown>,
    io: { onLine?: (line: string) => void }
  ) => unknown | Promise<unknown>;
};

export type ToolRunResult = {
  ok: boolean;
  result?: unknown;
  error?: string;
};

export type ToolPort = {
  /** Run one tool. `onLine` streams terminal lines (telemetry, §3) while it
   * runs; `callId` is the `tool.call`'s id (ANY-72), the seed for a `once`
   * tool's idempotency key (RUNTIME §6). */
  run(
    name: string,
    args: Record<string, unknown>,
    io: { onLine?: (line: string) => void; callId?: string }
  ): Promise<ToolRunResult>;
  /** The tool's declaration; undefined for a name outside the registry. */
  describe(name: string): ToolDescriptor | undefined;
};

// -- SurfacePort ---------------------------------------------------------------

export type SurfaceMessage = {
  text: string;
  subject?: string;
};

export type SurfaceReceipt = {
  platformMessageId?: string;
};

/** One outbound channel (RUNTIME §4 `deliver`): keyed, chunking and retries are
 * the adapter's; the handler only records the receipt. */
export type SurfacePort = {
  send(
    target: string,
    message: SurfaceMessage,
    options?: { idempotencyKey?: string }
  ): Promise<SurfaceReceipt>;
};
