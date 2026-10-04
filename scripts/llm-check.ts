// S1 check: `npm run llm:check [-- --openrouter]` — hits the real lane SEQUENTIALLY (shared, 8 concurrent max).
// Never prints SPARK_BASE_URL or any key. Steps (WORK-PLAN §5.2 S1):
//   1. Spark routing prompt at thinking off/low/medium: latency + reasoning tokens (off must be 0)
//   2. A forced tool call
//   3. Streaming: first-chunk latency, tool-call deltas, usage
//   4. The same tool call + stream through a Mastra Agent over model()'s output (S1's open question)
//   5. compileBrief on the demo request with the Research Team fixture
//   6. --openrouter: one tiny Haiku call showing usage.cost
import { loadRootEnv } from "@fabric/db";
loadRootEnv();

import { generateText, streamText, tool as aiTool } from "ai";
import type { LanguageModel } from "@fabric/agents/llm";
import { z } from "zod";
import { model, providerName, runCostUsd, runUsages } from "@fabric/agents/llm";
import { compileBrief, countTokens, renderBrief } from "@fabric/agents/context";
import { studioTeams } from "@fabric/fixtures/teams";
import { profileById } from "@fabric/fixtures/studio";
import { RESEARCH_CRITERIA } from "@fabric/fixtures/run";

/** Every check call meters under one throwaway runId, so the meter table at the end is meaningful. */
const RUN = "llm-check";

const ROUTE_PROMPT =
  "Route this request for Ty's assistant Dana. Request: \"Summarize what changed in the repo since yesterday.\" " +
  "Answer with exactly one of handle_directly, delegate_team, clarify, then one short sentence why.";

const TOOL_INPUT = { query: "n-gram lookup table 135M perplexity" };
const dispositionTool = (toolFn: typeof aiTool) =>
  toolFn({
    description: "Record the routing disposition for this turn. Must be the first call of every turn.",
    inputSchema: z.object({ disposition: z.enum(["handle_directly", "delegate_team", "clarify"]), why: z.string() }),
    execute: async (args) => ({ ok: true, stored: args.disposition }),
  });

const versions = async () => {
  const read = async (name: string) => {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const pkg = require(`${name}/package.json`) as { version: string };
    return pkg.version;
  };
  return {
    ai: await read("ai"),
    "@ai-sdk/openai-compatible": await read("@ai-sdk/openai-compatible"),
    "@mastra/core": await read("@mastra/core"),
  };
};

const ms = (t0: bigint) => Number(process.hrtime.bigint() - t0) / 1e6;
const s = (n: number) => `${(n / 1000).toFixed(1)}s`;
let failures = 0;
const check = (label: string, ok: boolean, detail: string) => {
  if (!ok) failures++;
  console.log(`    ${ok ? "PASS" : "FAIL"}  ${label} — ${detail}`);
};

async function step1ThinkingLevels() {
  console.log("\n1. Spark · short routing prompt · thinking off/low/medium (latency, reasoning tokens)");
  console.log("   level    latency   in/out tokens   reasoning tokens");
  for (const level of ["off", "medium", "low"] as const) {
    const t0 = process.hrtime.bigint();
    const result = await generateText({
      model: model("Sonnet 5.5", { thinking: level, meter: { runId: RUN, agentId: "dana", step: `s1-${level}` } }),
      prompt: ROUTE_PROMPT,
      maxOutputTokens: 300,
      temperature: 0,
    });
    const latency = ms(t0);
    const reasoning = result.usage.outputTokenDetails?.reasoningTokens ?? 0;
    console.log(`   ${level.padEnd(8)} ${s(latency).padStart(7)}   ${String(result.usage.inputTokens ?? "?")}/${String(result.usage.outputTokens ?? "?").padEnd(10)} ${reasoning}`);
    if (level === "off") check("thinking off yields zero reasoning tokens", reasoning === 0, `reasoning=${reasoning}, out=${result.usage.outputTokens}`);
    // Neon's Sonnet/Opus 5 think adaptively: at low/medium effort they may skip reasoning on a short prompt.
    else if (providerName() === "neon") console.log(`    INFO  thinking ${level} (adaptive) — reasoning=${reasoning}`);
    else if (level === "low" || level === "medium") check(`thinking ${level} reasoned`, reasoning > 0, `reasoning=${reasoning} (unit tests pin the request body)`);
  }
}

async function step2ForcedToolCall() {
  console.log("\n2. Spark · forced tool call (thinking off)");
  const t0 = process.hrtime.bigint();
  const result = await generateText({
    model: model("Sonnet 5.5", { thinking: "off", meter: { runId: RUN, agentId: "dana", step: "s2" } }),
    prompt: `Route this request by calling the tool: "${TOOL_INPUT.query}"`,
    tools: { record_disposition: dispositionTool(aiTool) },
    toolChoice: "required",
    temperature: 0,
  });
  const call = (await result.toolCalls)[0];
  check("tool call came back", Boolean(call), call ? `${call.toolName} ${JSON.stringify(call.input)}` : `finish=${JSON.stringify(result.finishReason)}`);
  console.log(`    latency ${s(ms(t0))}`);
}

async function step3Streaming() {
  console.log("\n3. Spark · streaming (thinking off): first chunk, tool-call deltas, usage");
  const t0 = process.hrtime.bigint();
  let firstChunkMs: number | null = null;
  let toolDeltas = 0;
  let toolStarts = 0;
  const result = streamText({
    model: model("Sonnet 5.5", { thinking: "off", meter: { runId: RUN, agentId: "dana", step: "s3" } }),
    prompt: `Route this request by calling the tool: "${TOOL_INPUT.query}"`,
    tools: { record_disposition: dispositionTool(aiTool) },
    toolChoice: "required",
    temperature: 0,
  });
  for await (const part of result.fullStream) {
    if (firstChunkMs === null) firstChunkMs = ms(t0);
    if (part.type === "tool-input-start") toolStarts++;
    if (part.type === "tool-input-delta") toolDeltas++;
  }
  const usage = await result.usage;
  const call = (await result.toolCalls)[0];
  console.log(`    first chunk ${firstChunkMs === null ? "never" : s(firstChunkMs)} · tool-input starts ${toolStarts} · deltas ${toolDeltas}`);
  check("stream delivered the tool call in pieces", toolStarts >= 1 && toolDeltas >= 1, `starts=${toolStarts} deltas=${toolDeltas}`);
  check("stream reported usage", (usage.outputTokens ?? 0) > 0, `in=${usage.inputTokens} out=${usage.outputTokens} reasoning=${usage.outputTokenDetails?.reasoningTokens ?? 0}`);
  check("streamed tool call parsed", Boolean(call), call ? `${call.toolName} ${JSON.stringify(call.input)}` : "no call");
}


async function step4Mastra() {
  console.log("\n4. Spark · the same tool call and stream through a Mastra Agent over model()'s output");
  const { Agent } = await import("@mastra/core/agent");
  const { createTool } = await import("@mastra/core/tools");
  const recordDisposition = createTool({
    id: "record_disposition",
    description: "Record the routing disposition for this turn.",
    inputSchema: z.object({ disposition: z.enum(["handle_directly", "delegate_team", "clarify"]), why: z.string() }),
    execute: async ({ context }) => ({ ok: true, stored: context.disposition }),
  });
  const spark: LanguageModel = model("Sonnet 5.5", { thinking: "off", meter: { runId: RUN, agentId: "dana", step: "s4-mastra" } });
  try {
    const agent = new Agent({
      id: "s1-check",
      name: "S1 check agent",
      instructions: "You route requests for Dana. Always call record_disposition first.",
      model: spark,
      // Mastra 1.74: tools live on the constructor; per-call options take toolsets/clientTools + toolChoice.
      tools: { record_disposition: recordDisposition },
    });
    const t0 = process.hrtime.bigint();
    // Log what Mastra actually put on the wire (tools, tool_choice) — S1's open question.
    const bodies: Record<string, unknown>[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return realFetch(url as Parameters<typeof fetch>[0], init);
    }) as typeof fetch;
    let gen: Awaited<ReturnType<Agent["generate"]>> | undefined;
    try {
      gen = await agent.generate(`Route this request by calling the tool: "${TOOL_INPUT.query}"`, {
        toolChoice: "required",
        modelSettings: { temperature: 0, maxOutputTokens: 300 },
      });
    } finally {
      globalThis.fetch = realFetch;
    }
    const wire = bodies.at(-1) ?? {};
    const wireTools = wire.tools as Record<string, unknown>[] | undefined;
    console.log(`    wire: tool_choice=${JSON.stringify(wire.tool_choice)} tools=${wireTools?.map((t) => Object.keys(t)).flat().join(",") ?? "none"} chat_template_kwargs=${JSON.stringify(wire.chat_template_kwargs)}`);
    const toolCalls = gen ? (await gen.toolCalls).length : 0;
    check("Mastra agent: forced tool call", toolCalls >= 1, `${toolCalls} call(s), finish=${gen?.finishReason ?? "?"}, text="${(gen?.text ?? "").slice(0, 90).replace(/\n/g, " ")}", ${s(ms(t0))}`);

    const t1 = process.hrtime.bigint();
    const streamed = await agent.stream(`Route this request by calling the tool: "${TOOL_INPUT.query}"`, {
      toolChoice: "required",
      modelSettings: { temperature: 0, maxOutputTokens: 300 },
    });
    let parts = 0;
    let firstChunkMs: number | null = null;
    for await (const _part of streamed.fullStream) {
      parts++;
      if (firstChunkMs === null) firstChunkMs = ms(t1);
    }
    check("Mastra agent: stream", parts > 0, `${parts} parts, first at ${firstChunkMs === null ? "never" : s(firstChunkMs)}`);
  } catch (error) {
    check("Mastra takes model()'s output", false, `${error instanceof Error ? error.message : String(error)}`);
  }
}

async function step5CompileBrief() {
  console.log("\n5. compileBrief · demo request · Research Team fixture (thinking off, structured output)");
  const research = studioTeams.find((t) => t.id === "research")!;
  const brief = await compileBrief({
    request:
      "Test whether an n-gram lookup table helps a 135M open model on held-out perplexity, with the table kept on disk instead of in RAM.",
    team: { name: research.name, purpose: research.purpose, criteria: research.criteria },
    specialists: research.members.map((m) => profileById(m.agentId)),
    constraints: ["Cached corpus only; no new downloads", "One base model and one interpolation weight to start", "The table stays on disk, never loaded into RAM"],
  });
  console.log(`    objective    ${brief.objective}`);
  console.log(`    constraints  ${brief.constraints.join(" | ")}`);
  console.log(`    criteria     ${brief.criteria.join(" | ")}`);
  console.log(`    preferences  ${brief.preferences.join(" | ")}`);
  console.log(`    stayed       ${brief.stayed.join(" | ")}`);
  console.log(`    tokens       ${brief.tokens} (= countTokens of the rendered brief: ${countTokens(renderBrief(brief)).tokens})`);
  const shapeOk =
    brief.objective.split(/[.!?]/).filter((x) => x.trim()).length <= 2 &&
    brief.criteria.length > 0 &&
    brief.criteria.length <= research.criteria.length + 1 &&
    brief.stayed.length === 3;
  check("demo brief matches the 135M fixture brief's shape", shapeOk, `objective one sentence, ${brief.criteria.length} criteria (team has ${research.criteria.length}), stayed ×3`);
  const narrowed = brief.criteria.some((c) => research.criteria.some((t) => c === t || c.includes(t.slice(0, 20))));
  check("criteria start from the team's", narrowed, `e.g. "${brief.criteria[0]}" vs "${RESEARCH_CRITERIA[0]}"`);
}

async function step6OpenRouter() {
  console.log("\n6. OpenRouter · one tiny Haiku call (thinking off) with usage accounting");
  process.env.LLM_PROVIDER = "openrouter"; // model() resolves the provider per call
  const t0 = process.hrtime.bigint();
  const result = await generateText({
    model: model("Haiku 4.5", { thinking: "off", meter: { runId: RUN, agentId: "dana", step: "s6" } }),
    prompt: "Reply with the single word: ok",
    maxOutputTokens: 16,
    temperature: 0,
  });
  const metered = runUsages(RUN).at(-1);
  const cost = result.providerMetadata && "openrouter" in result.providerMetadata ? result.providerMetadata.openrouter : undefined;
  const reportedCost = (cost as { usage?: { cost?: number } } | undefined)?.usage?.cost;
  console.log(`    ${s(ms(t0))} · in ${result.usage.inputTokens} / out ${result.usage.outputTokens} · usage.cost ${reportedCost ?? "missing"}`);
  check("usage.cost came back and was metered", metered?.costUsd === reportedCost && reportedCost != null, `meter ${JSON.stringify(metered)}`);
}

const main = async () => {
  const openrouter = process.argv.includes("--openrouter");
  const onlyOpenrouter = process.argv.includes("--openrouter-only"); // step 6 alone, for cheap re-runs
  console.log(`llm:check — provider ${process.env.LLM_PROVIDER ?? "spark"} · spark model ${process.env.SPARK_MODEL}`);
  console.log(`versions: ${JSON.stringify(await versions())}`);
  if (onlyOpenrouter) {
    await step6OpenRouter();
  } else {
    await step1ThinkingLevels();
    await step2ForcedToolCall();
    await step3Streaming();
    await step4Mastra();
    await step5CompileBrief();
    if (openrouter) await step6OpenRouter();
    else console.log("\n6. skipped (pass --openrouter for the Haiku cost check)");
  }
  const usages = runUsages(RUN);
  console.log(`\nmeter: ${usages.length} calls under runId "${RUN}" · running cost $${runCostUsd(RUN).toFixed(5)}`);
  for (const u of usages) console.log(`    ${u.step ?? "-".padEnd(10)} ${u.model} in=${u.inputTokens} out=${u.outputTokens} cost=${u.costUsd ?? "-"}`);
  if (failures > 0) {
    console.error(`\nllm:check FAILED (${failures} check(s))`);
    process.exit(1);
  }
  console.log("\nllm:check PASSED");
};

main().catch((error) => {
  console.error("llm:check crashed:", error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
