// The shared spine of every tool: run-event emission (§4.5) and policy enforcement (§5.3 TOOLS 2).
//
// Every call emits tool.call {tool, summary} first. Terminal output streams as line-buffered,
// throttled tool.result {line, kind: "term"} events. A blocked or approval-only policy emits
// tool.denied and returns an error result to the model — phase 1 has no approval round trip, so
// "approval" reads as denied with "needs approval" (it becomes a Weave ask in phase 2).
//
// Enforcement note (ARCH §1.3/§9): these are OUR allowlist rules applied in the tool layer
// ("behavioral scoping"), plus the Sprite's real DNS egress policy for sandboxed commands.
import { tool } from "ai";
import type { Tool } from "ai";
import { z } from "zod";
import { RunClosedError } from "@fabric/db";
import type { RunWriter } from "@fabric/db";
import type { ToolName, ToolPolicy } from "@fabric/contracts";

/** What a tool's execute gets besides its input: how to narrate itself into the run log. */
export interface ToolCtx {
  runId: string;
  step: string;
  writer: RunWriter;
  /** Events' actorAgentId. */
  actor: string;
}

export class ToolIO {
  private closed = false;
  private lastEmit = 0;
  private lines = 0;
  /** Min gap between term events; the writer's Neon round trip paces us further. */
  private readonly minGapMs = 25;
  /** Hard cap: after this many lines one suppression note is emitted and the rest are dropped. */
  private readonly maxLines = 400;

  constructor(private readonly ctx: ToolCtx) {}

  /** tool.call — the one event every call emits, before any policy check. */
  async call(name: ToolName, summary: string): Promise<void> {
    await this.emit("tool.call", { tool: name, summary });
  }

  /** Terminal output, line-buffered and throttled (kind is always "term"). */
  async term(line: string): Promise<void> {
    if (this.closed) return;
    if (this.lines >= this.maxLines) {
      if (this.lines === this.maxLines) {
        this.lines++;
        await this.emit("tool.result", { line: `… output truncated at ${this.maxLines} lines`, kind: "term" });
      }
      return;
    }
    this.lines++;
    const wait = this.lastEmit + this.minGapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastEmit = Date.now();
    await this.emit("tool.result", { line, kind: "term" });
  }

  /** Narration ("exa.search "…" · fast"). */
  async message(text: string): Promise<void> {
    await this.emit("agent.message", { text });
  }

  /** The blocked-call record the Inspector's Tools tab shows. */
  async denied(name: ToolName, target: string, reason: string): Promise<void> {
    await this.emit("tool.denied", { tool: name, target, reason });
  }

  private async emit(type: "tool.call" | "tool.result" | "agent.message" | "tool.denied", payload: Record<string, unknown>): Promise<void> {
    if (this.closed && type !== "tool.call") return;
    try {
      await this.ctx.writer.emit(this.ctx.runId, type, this.ctx.actor, payload as never);
    } catch (err) {
      if (err instanceof RunClosedError) {
        // The run was spliced or finalized mid-call (§7.0): stop narrating, keep working.
        this.closed = true;
        console.log(`[tools] run ${this.ctx.runId} closed; dropping further ${this.ctx.actor} events`);
        return;
      }
      throw err;
    }
  }
}

/** One tool result shape for every model-facing return: success carries its payload, failure says why. */
export type ToolOk<T> = { ok: true } & T;
export type ToolErr = { ok: false; error: string };
export type ToolResult<T> = ToolOk<T> | ToolErr;

export interface ToolSpec<I, T> {
  name: ToolName;
  description: string;
  inputSchema: z.ZodType<I>;
  policy: ToolPolicy;
  /** tool.call's one-line summary of the args (a command, a query, a URL…). */
  summary: (input: I) => string;
  /** tool.denied's target when the policy blocks the call. */
  target?: (input: I) => string;
  /** Defaults to "blocked by policy"; network.fetch says "not on the egress list" like the mock. */
  blockedReason?: string;
  /** Runs only when the policy allows. */
  run: (input: I, io: ToolIO, ctx: ToolCtx) => Promise<T>;
}

export function makeTool<I, T>(spec: ToolSpec<I, T>, ctx: ToolCtx): Tool {
  // The SDK's tool() is an identity function; building the object keeps the generic types honest.
  return {
    description: spec.description,
    inputSchema: spec.inputSchema,
    execute: async (raw: unknown): Promise<ToolResult<T>> => {
      const io = new ToolIO(ctx);
      const parsed = spec.inputSchema.safeParse(raw ?? {});
      if (!parsed.success) {
        await io.call(spec.name, "invalid arguments");
        return { ok: false, error: `${spec.name}: invalid arguments (${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message})` };
      }
      const input = parsed.data as I;
      await io.call(spec.name, spec.summary(input));
      if (spec.policy !== "allowed") {
        const target = spec.target?.(input) ?? "";
        const reason = spec.policy === "approval" ? "needs approval" : (spec.blockedReason ?? "blocked by policy");
        await io.denied(spec.name, target, reason);
        return { ok: false, error: `${spec.name} ${reason}${target ? ` (${target})` : ""}: this tool is ${spec.policy} for your role` };
      }
      try {
        return { ok: true, ...(await spec.run(input, io, ctx)) };
      } catch (err) {
        return { ok: false, error: `${spec.name} failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  } as Tool;
}
