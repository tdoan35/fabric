// The fake model: the ModelPort test double for the worker suites (ANY-35 R9a).
// Scripts one entry per call — a result resolves the call, an error spec rejects
// it as a model error ({ status, retryAfter?, retryable }). Every call is
// recorded with the exact system, messages and tools the worker sent, so the
// tests assert on the conversation the worker rebuilt, never on the port.
//
// Deliberately self-typed (no import of ../ports): it satisfies the port
// structurally, and the red commit carries no production modules.

/** One tool as the worker hands it to the model — a name, never an `execute`. */
export interface FakeModelTool {
  name: string;
  description?: string;
  parameters?: unknown;
}

/** One conversation message as the worker rebuilds it from facts. */
export interface FakeModelMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  /** The `tool.call` id, on role "tool". */
  toolCallId?: string;
  /** The assistant's requested calls, on role "assistant". */
  toolCalls?: readonly Record<string, unknown>[];
}

/** A scripted success. */
export interface FakeModelResult {
  text: string;
  toolCalls: readonly Record<string, unknown>[];
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  finishReason: string;
}

/** A scripted failure; raised as `FakeModelError` with these fields. */
export interface FakeModelErrorSpec {
  message: string;
  status?: number;
  retryAfter?: number;
  retryable: boolean;
}

/** The error the port contract throws: { status, retryAfter?, retryable } plus a message. */
export class FakeModelError extends Error {
  readonly status?: number;
  readonly retryAfter?: number;
  readonly retryable: boolean;

  constructor(spec: FakeModelErrorSpec) {
    super(spec.message);
    this.name = "FakeModelError";
    this.status = spec.status;
    this.retryAfter = spec.retryAfter;
    this.retryable = spec.retryable;
  }
}

export interface FakeModelCall {
  system: string;
  messages: readonly FakeModelMessage[];
  tools: readonly FakeModelTool[];
}

export class FakeModel {
  /** One record per `call`: the exact request the worker assembled. */
  readonly calls: FakeModelCall[] = [];
  /** Cumulative text deltas, in emission order, across all calls. */
  readonly deltas: string[] = [];

  readonly #script: (FakeModelResult | FakeModelErrorSpec)[];

  constructor(script: readonly (FakeModelResult | FakeModelErrorSpec)[]) {
    this.#script = [...script];
  }

  /** The port's `call`: pops the next scripted entry, records the request. */
  async call(request: {
    system: string;
    messages: readonly FakeModelMessage[];
    tools: readonly FakeModelTool[];
    onDelta?: (delta: { text: string }) => void;
  }): Promise<FakeModelResult> {
    this.calls.push({ system: request.system, messages: [...request.messages], tools: [...request.tools] });
    const entry = this.#script.shift();
    if (entry === undefined) throw new Error("FakeModel: no scripted entry left");
    if ("retryable" in entry) throw new FakeModelError(entry);

    const result = entry as FakeModelResult;
    if (request.onDelta !== undefined && result.text.length > 0) {
      // Two raw increments (R16): the port's shape — the worker accumulates.
      const half = Math.ceil(result.text.length / 2);
      request.onDelta({ text: result.text.slice(0, half) });
      request.onDelta({ text: result.text.slice(half) });
      this.deltas.push(result.text.slice(0, half), result.text.slice(half));
    }
    return { ...result, toolCalls: [...result.toolCalls] };
  }
}
