# LLM+CTX status — updated Sun Oct 4, ~10:30 PDT (branch `seq/llm-ctx`)

Step 3 of §7.0: DANA step 1 (`llm`, thinking controls, `meter`) and all of CTX. 5 commits, nothing
merged or pushed. Gates: typecheck · test (server 18 / agents 26 / db 21) · build -w web ·
check:data (55.5 s) all green.

## Spikes
- **S1 — pass** (`npm run llm:check`, sequential on the Spark lane; last full run Oct 4, ~10:30).
  Versions: **ai 7.0.127 · @ai-sdk/openai-compatible 3.0.62 · @mastra/core 1.74.0**.
  - Thinking on the routing prompt: **off 0.7 s (0 reasoning tokens — verified)**, medium 5.5 s
    (180 reasoning), low 3.8 s (115). Unit tests additionally pin the exact wire body per level.
  - Forced tool call: 2.2–2.3 s, args parsed (`record_disposition {disposition, why}`).
  - Streaming: first chunk ~0 s, tool call arrives in **22 input deltas**, usage on the final chunk
    (needs `includeUsage: true` on the openai-compatible factory — found by the check, now set).
  - **Mastra verdict: it takes `model()`'s output cleanly** (a v4 instance): thinking-off
    `chat_template_kwargs` and our meter flow through, provider aliasing fine. Two footguns:
    1. per-call `tools` / `temperature` / `maxOutputTokens` in `agent.generate/stream` options are
       **silently ignored** — tools live on the `Agent` constructor, sampling under `modelSettings`
       (the wire dump proves it; no runtime error);
    2. `toolChoice: "required"` re-applies **every loop step** — the probe made 5 sequential tool
       calls before stopping. Don't use `required` for "must call record_disposition first".
  - compileBrief live on Spark: structured output via `response_format` json_schema (vLLM guided
    decoding) validates; demo brief below under Notes.
  - OpenRouter (`--openrouter-only`): Haiku 0.9 s, `usage.cost` $0.00003366 returned and metered
    byte-for-byte. Key cap untouched (one 18-token call).
  - Neon: implemented per `.claude/skills/neon-ai-gateway` (`@neon/ai-sdk-provider`, reads
    `NEON_AI_GATEWAY_*`); untestable until the venue — empty env throws a clear config error.
  - **Recommendation: plain AI SDK for DANA and TEAM.** Everything the demo needs (tools,
    streaming, structured output, metering) already runs on it with exact control; Mastra's agent
    loop adds silent option-dropping we'd have to defend against. Mastra stays viable for TEAM's
    S3 if its workflow earns its keep — the model rides either way.

## Done
- **llm** (`packages/agents/src/llm`): `model(modelId, {thinking, meter})` over
  spark/openrouter/neon chosen by `LLM_PROVIDER`; display models map per provider
  (`modelFamily`/`providerModelId`); `sparkThinkingBody` implements the probed knobs and never
  sends `"none"`; `defaultThinking(agentId)` = off for dana / medium otherwise; metering via AI
  SDK middleware on generate+stream (`Usage {model: provider:id, tokens, costUsd, estimated,
  agentId?, step?}`); costs: Spark $0, OpenRouter `usage.cost`, Neon from `NEON_PRICES` in code
  (flagged `estimated`); `meter(ctx)` sink + `runCostUsd(runId)` running total + `runUsages(runId)`.
- **context** (`packages/agents/src/context`): `countTokens` (js-tiktoken o200k_base, flagged
  estimated); `compileBrief` (one schema-validated structured-output call, Dana's model, thinking
  off; stayed always `STAYED`; `tokens` = countTokens of the rendered brief); `assembleContext`
  (deterministic six sections with the mock's labels/sources and real `content`; `system` = the
  sections joined; per-role `notLoaded`/`note` incl. dynamic artifact-ref and knowledge variants;
  optional `sandbox`); `measureAssistantContext`; `preferenceItems`/`renderBrief`/`taskBriefContent`
  exported for callers and tests.
- **db**: `RunWriter.startRun(taskId, brief, budget, opts?: {assistantTokens?})` — stores
  `runs.assistant_tokens` from the option instead of `brief.tokens`. Additive; no caller changed.
- **llm:check**: `scripts/llm-check.ts` + root script `llm:check`; `--openrouter` adds step 6,
  `--openrouter-only` runs step 6 alone for cheap re-probes.

## Next
- DANA steps 2–7 build on `model`/`meter` (dispositions, chat stream, proposals, handoff calling
  `compileBrief` + `startRun(…, {assistantTokens})`); TEAM consumes `assembleContext` per step and
  `runCostUsd` for `budget.update`.

## Blocked (on whom)
- Neon Gateway: needs the venue's credits/env (by design). Re-check catalog ids via
  `GET /v1/models` and `NEON_PRICES` before the demo.

## Requests (contract / path / decision)
- None to contracts (no `contracts:` commits — nothing needed breaking or adding there).
- **Path notes (allowed by §7.0, for review):** `packages/db/src/{index,writer}.ts` (the startRun
  option), root `package.json` (+`llm:check`), `packages/agents/package.json` + lockfile (deps:
  ai, @ai-sdk/{provider,openai-compatible}, @openrouter/ai-sdk-provider, @neon/ai-sdk-provider,
  js-tiktoken, zod, @mastra/core; devDeps vitest, @fabric/fixtures).

## Deviations
- **Sana's USER.md disagrees with the fixture snapshots**: `run.ts` treats her as `USER.md · 0
  items`, but `studio.ts` (DATA/FND file, out of my paths) seeds her the shared `Wants` block, so
  real runs will show Sana at 2 items until that's aligned. Tests use an emptied USER.md; flagged
  for the integrator (one-line change in `packages/fixtures/src/studio.ts` if you agree).
- **`brief.tokens` vs the Task brief section**: tokens count `renderBrief` (all six fields, ARCH
  §6 shape); the section the specialist loads renders objective/criteria/constraints/budget, so
  its count can differ slightly. The fixture conflated the two; each number is real where it's
  shown and sections still sum to `totalTokens`.
- **Additive extras in my own interfaces**: `BriefInput.modelId?`, `AssembleInput.leadName?`,
  `compileBrief(i, {model?})` (offline tests), `Usage.agentId/step?`, `runUsages()`. All optional;
  the §4.6 shapes still satisfy.
- **Thinking off-provider**: openrouter maps off → send nothing (Claude thinking is opt-in),
  low/medium/high → `reasoning: {effort}`; neon has no thinking mapping yet (providerOptions at
  call time if the venue's models need it).
- **NEON_PRICES are placeholder list prices** (noted in code); metered costs carry `estimated:
  true` so the UI can say so.
- **countTokens is o200k_base**, not Qwen's tokenizer — an estimate by definition, flagged.
- **llm:check flags**: `--openrouter` and `--openrouter-only` (the spec named only `--openrouter`;
  the second avoids re-burning the shared lane when re-probing cost).

## Notes for DANA (and TEAM)
- **Models**: `import { model, defaultThinking } from "@fabric/agents/llm"`.
  `model(dana.agent.model /* "Sonnet 5.5"; "" works */)` → thinking defaults to **off** when
  `opts.meter.agentId === "dana"`, else **medium**; pass `{thinking}` to override. `""` maps to
  Sonnet. Usage carries `provider:modelId` (`spark:qwen3.8-flash-next`,
  `openrouter:anthropic/claude-haiku-4.5`) — show that, not the display name.
- **Metering**: pass `{meter: {runId, agentId, step}}` on every model you run; then
  `runCostUsd(runId)` is the run total for `budget.update {costUsd}` (DATA accumulates it as a
  total, not a delta) and `runUsages(runId)` lists per-call records (model, tokens, cost).
- **compileBrief**: `compileBrief({request, team: {name, purpose, criteria}, specialists,
  constraints?, modelId?})` → `Brief` (criteria narrowed from the team's, preferences deduped from
  USER.md, `stayed` fixed, `tokens` precomputed). Pass `modelId: dana.agent.model`. In tests pass
  `{model: mockModel}` to stay offline. Demo brief from the last live run: objective "Evaluate the
  impact of a disk-resident n-gram lookup table on held-out perplexity for a 135M open model.",
  3–4 criteria narrowed from the team's 4, 2 preferences, 163 tokens — same shape as the 135M
  fixture brief.
- **Dana's base context**: `measureAssistantContext(profileById("dana"))` → pass as
  `startRun(taskId, brief, budget, {assistantTokens})` so the Run header's "Assistant: N tokens"
  is real.
- **S1 verdict**: plain AI SDK (see Spikes). If TEAM still wants Mastra: tools on the constructor,
  sampling under `modelSettings`, never `toolChoice: "required"` for Dana's first-call pattern.

## How to verify
```bash
npm i && npm run typecheck && npm test && npm run build -w web   # all green
npm run llm:check                        # ~40 s, sequential on Spark; ends "llm:check PASSED"
npm run llm:check -- --openrouter        # adds one tiny metered Haiku call
npm run check:data                       # e2e unchanged (55.5 s last run)
```
Last runs: gates all green (Oct 4, ~10:30); `llm:check` PASSED with the numbers in Spikes;
`check:data` 20/20 asserts on branch demo. No `apps/web` changes (`git diff main -- apps/web`
empty); no `.env` or secret values committed or printed anywhere.
