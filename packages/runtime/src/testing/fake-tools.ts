// The fake tools: the ToolPort test double for the worker suites (ANY-39 R9b).
// Scripts one entry per run per tool — a run resolves with the recorded
// result, streaming its lines through `onLine` in order. Every run is
// recorded with the exact name and args the handler passed, so the tests
// assert on the calls the handler made, never on the port.
//
// Deliberately self-typed (no import of ../ports): it satisfies the port
// structurally, and the red commit carries no production modules.

/** The effect class a scripted tool declares (RUNTIME §6). */
export type FakeToolEffect = "read" | "idempotent" | "rerunnable" | "once";

/** One scripted run of a tool: the outcome the port returns, plus the lines
 * it streams to `onLine` while running. */
export interface FakeToolRun {
  ok: boolean;
  lines?: readonly string[];
  result?: unknown;
  error?: string;
}

export interface FakeToolSpec {
  /** What `describe` reports; the handler's fallback when `tool.call` is silent. */
  effect: FakeToolEffect;
  /** Consumed front to back, one per `run`; a missing entry raises. */
  runs: readonly FakeToolRun[];
}

/** One run the handler made, recorded verbatim. */
export interface FakeToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export class FakeTools {
  /** Every `run`, in order, across all tools. */
  readonly calls: FakeToolCall[] = [];

  readonly #specs: Map<string, FakeToolSpec>;
  readonly #next: Map<string, number> = new Map();

  constructor(specs: Record<string, FakeToolSpec>) {
    this.#specs = new Map(Object.entries(specs));
  }

  /** How many times a tool ran — the spy count the recovery tests assert on. */
  count(tool: string): number {
    return this.calls.filter((call) => call.tool === tool).length;
  }

  /** The port's `run`: pops the next scripted run, streams its lines, records the call. */
  async run(
    tool: string,
    args: Record<string, unknown>,
    io: { onLine?: (line: string) => void }
  ): Promise<FakeToolRun> {
    const spec = this.#specs.get(tool);
    if (spec === undefined) throw new Error(`FakeTools: no spec for tool "${tool}"`);
    const index = this.#next.get(tool) ?? 0;
    if (index >= spec.runs.length) {
      throw new Error(`FakeTools: no scripted run left for "${tool}"`);
    }
    this.#next.set(tool, index + 1);
    this.calls.push({ tool, args: { ...args } });
    const run = spec.runs[index]!;
    for (const line of run.lines ?? []) io.onLine?.(line);
    return {
      ok: run.ok,
      ...(run.result !== undefined ? { result: run.result } : {}),
      ...(run.error !== undefined ? { error: run.error } : {}),
    };
  }

  /** The port's `describe`: the declaration, or undefined off-registry. */
  describe(tool: string): { name: string; effect: FakeToolEffect } | undefined {
    const spec = this.#specs.get(tool);
    return spec === undefined ? undefined : { name: tool, effect: spec.effect };
  }
}
