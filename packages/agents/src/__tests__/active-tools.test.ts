import { describe, expect, it, vi, afterEach } from "vitest";
import { stepCountIs, streamText, tool } from "ai";
import { z } from "zod";

// The turn's activeTools must ride prepareStep for EVERY step: the demo's post-approval
// progression (team approved → specialist card; specialist approved → handoff) is enforced by
// narrowing the wire's tool list, and a step-level prepareStep return overrides the top-level
// option. Seen failing live: step 1+ got every tool back and the model re-called propose_team.
describe("activeTools stays narrowed across steps", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("step 1+ keeps only the active tools when prepareStep returns extras", async () => {
    vi.stubEnv("LLM_PROVIDER", "spark");
    vi.stubEnv("SPARK_BASE_URL", "http://spark.test/v1");
    vi.stubEnv("SPARK_API_KEY", "k");
    vi.stubEnv("SPARK_MODEL", "qwen3.8-flash-next");
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", (async (_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body));
      bodies.push(body);
      const chunk = (delta: unknown, finish: string | null) =>
        JSON.stringify({ id: String(bodies.length), object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] });
      const lines = bodies.length === 1
        ? [
            chunk({ role: "assistant", tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "record_disposition", arguments: '{"disposition":"clarify","reason":"x"}' } }] }, null),
            chunk({}, "tool_calls"),
          ]
        : [
            chunk({ role: "assistant", content: "done" }, null),
            chunk({}, "stop"),
          ];
      lines.push(JSON.stringify({ id: String(bodies.length), object: "chat.completion.chunk", created: 1, model: "m", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      lines.push("[DONE]");
      return new Response(lines.map((l) => `data: ${l}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch);
    const { model } = await import("../llm");
    const tools = {
      record_disposition: tool({ inputSchema: z.object({ disposition: z.string(), reason: z.string() }), execute: async () => ({ recorded: true }) }),
      propose_team: tool({ inputSchema: z.object({ a: z.string() }) }),
      propose_specialist: tool({ inputSchema: z.object({ b: z.string() }) }),
    };
    const active: (keyof typeof tools)[] = ["record_disposition", "propose_specialist"];
    const r = streamText({
      model: model("", { thinking: "off" }),
      messages: [{ role: "user", content: "hi" }],
      tools,
      stopWhen: stepCountIs(2),
      prepareStep: ({ stepNumber }: { stepNumber: number }) => ({
        activeTools: active,
        ...(stepNumber === 0 ? { toolChoice: { type: "tool" as const, toolName: "record_disposition" } } : {}),
      }),
    });
    await r.text;
    expect(bodies.length).toBe(2);
    for (const b of bodies) {
      expect((b.tools as { function: { name: string } }[]).map((t) => t.function.name)).toEqual(["record_disposition", "propose_specialist"]);
    }
  });
});
