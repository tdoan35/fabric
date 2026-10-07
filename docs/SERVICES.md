# Fabric — External Services Inventory

| | |
|---|---|
| Status | Inventory only, as of 2026-10-06. Nothing here has been decoupled yet |
| Purpose | Every outside service, SDK and account Fabric touches, where it is wired in, and what happens without it. The starting point for decoupling |

Every integration is optional at boot except Postgres (the server throws without `DATABASE_URL`). The web app in `VITE_API_MODE=mock` needs none of them.

## 1. Services in use

| Service | What it does in Fabric | Wired in | Env | Without it |
|---|---|---|---|---|
| **Neon Postgres** | All state: agents, teams, sessions, runs and events, reports, schedules, memories | `packages/db` (`pg` + Drizzle), `apps/server/src/services/runtime.ts` | `DATABASE_URL` (pooled), `DATABASE_URL_UNPOOLED` (migrations), `NEON_BRANCH` | Server won't start. Mock-mode web still works |
| **Spark lane** (self-hosted vLLM on the DGX Spark, over Tailscale) | Default LLM for every agent: all display models map to `SPARK_MODEL` | `packages/agents/src/llm/index.ts` (`@ai-sdk/openai-compatible`) | `LLM_PROVIDER=spark`, `SPARK_BASE_URL`, `SPARK_API_KEY` (not enforced), `SPARK_MODEL` | Model calls fail. `DANA_MODE=fixture` scripts Dana's turns; team runs still need a model |
| **OpenRouter** | Backup LLM lane: real `anthropic/claude-*` ids, provider-reported `usage.cost` | `llm/index.ts` (`@openrouter/ai-sdk-provider`) | `LLM_PROVIDER=openrouter`, `OPENROUTER_API_KEY` | Only used when selected |
| **Neon AI Gateway** | Third LLM lane, built for the venue's credits | `llm/index.ts` (`@neon/ai-sdk-provider`); catalog ids in `providerModelId`, prices in `NEON_PRICES` | `LLM_PROVIDER=neon`, `NEON_AI_GATEWAY_BASE_URL`, `NEON_AI_GATEWAY_TOKEN` (both empty today) | Clear config error if selected. On Oct 4 it rejected `claude-sonnet-5-5`, so Sonnet maps to `claude-sonnet-5` |
| **Fly.io Sprites** | Sandboxes: Jonah's `sprite.exec` / `workspace.write`, Sana's checks, and Dana's headed Chromium for browser errands | `packages/integrations/src/sprites.ts`, `tools/sprite.ts`, `tools/browser.ts`; setup in `scripts/setup-dana-sprite.{sh,ts}` + `scripts/dana-browser-{proxy,worker,start}` | `SPRITES_TOKEN`, `SPRITE_CODER`, `SPRITE_VALIDATOR`, `SPRITE_ASSISTANT` (default `fabric-assistant`), `BROWSER_CONFIRM_BEFORE_SUBMIT` | Tool throws `SPRITES_TOKEN is not set`; the model sees a tool error |
| **Exa** | Megan's `exa.search` (web search with highlights) | `packages/integrations/src/exa.ts`, `tools/exa-tool.ts` | `EXA_API_KEY` | 8 s timeout or error serves the last cached result from `.cache/exa/`, labelled `(cached)` |
| **AgentMail** | Sana's inbox on specialist approval, the report email at finalize, the `agentmail.send` tool (approval-only) | `packages/integrations/src/agentmail.ts`, `tools/agentmail-tool.ts`; gated in `services/runtime.ts` and `services/finalize.ts` | `AGENTMAIL_API_KEY`, `FEATURE_AGENTMAIL` (off), `OWNER_EMAIL` | Off by default: no inbox, no email. Account limits at build time: 3 inboxes, 100 sends/day |
| **Hugging Face Hub** | Downloads `Xenova/bge-small-en-v1.5` (q8, ~33 MB) for Dana's memory recall; runs locally on CPU | `packages/agents/src/memory/index.ts` (`@huggingface/transformers`), warmed in `apps/server/src/index.ts` | none | First boot needs network to fetch the model. Pulls native deps `onnxruntime-node` and `sharp` (image code only, unused by Fabric) |
| **Mnemosyne store** (Hermes Agent's local SQLite) | One-shot import source for the `memories` table | `scripts/import-mnemosyne.ts` (`npm run memory:import`) | `MNEMOSYNE_DB` (else a default under `$HOME`) | Recall returns nothing. Holds PII: opened read-only, never copied into the repo |
| **Tailscale** | Network path to the Spark lane, and from the phone to the server | — (infrastructure) | — | Spark unreachable off the tailnet |

## 2. Configured but unused

| Item | State | Leftovers |
|---|---|---|
| **Executor** (MCP tool gateway) | Spike S6 failed on Oct 4 (cloud: OAuth-only, 401; self-host: no per-agent policies). Our own tool-layer allowlist replaced it | `EXECUTOR_URL`, `EXECUTOR_KEY`, `FEATURE_EXECUTOR` in `apps/server/src/env.ts` and `packages/integrations/src/env.ts`; the `executor` entry in `.mcp.json` |
| **Mastra** | Spike S1 chose the plain AI SDK; S3 chose plain async orchestration for teams | `@mastra/core` in `packages/agents/package.json`, imported only by `scripts/llm-check.ts` |
| **Kernel** (browser sessions) | Never integrated. Dana's browser runs in a Sprite instead | Listed as an "available" connector in `packages/fixtures/src/studio.ts` and `apps/web/src/lib/mock/options.ts` |

## 3. Libraries tied to the hackathon stack (not services)

- **Assistant UI** (`@assistant-ui/react`): the web chat thread, composer and tool cards (`apps/web/src/components/chat/`, `lib/chat/`).
- **Vercel AI SDK** (`ai`, `@ai-sdk/*`): every model call and tool definition. The seam the LLM lanes plug into.

## 4. Hardcoded account details

| What | Where |
|---|---|
| Neon project id `solitary-meadow-39146227` (used to shell out to the `neon` CLI for `--branch` URLs) | `packages/db/src/seed.ts`, `scripts/import-mnemosyne.ts`, `scripts/check-{chat,team,tools}.ts`, `scripts/check-data.mjs` |
| Owner's AgentMail inbox `ty-8132@agentmail.to`, Sana's `sana-fabric` username | `packages/integrations/src/agentmail.ts` |
| Neon Gateway catalog ids and prices | `packages/agents/src/llm/index.ts` (`providerModelId`, `NEON_PRICES`) |
| OpenRouter model ids | same file, `providerModelId` |
| Sprite egress allowlist (PyPI, Hugging Face) | `packages/integrations/src/sprites.ts` (`EGRESS_ALLOWLIST`) |
| Yelp reservation URL for the errand demo | `packages/agents/src/assistant/recall.ts` (`SAKESAN_BOOKING_URL`, env override of the same name) |

## 5. Neon branches

`production` (default; lived-in seed, 210 imported memories) · `dev` (lived-in seed, no memories) · `demo` · `memory` · `recording`. All on migration `0005`. The `memories` table needs the `vector` (pgvector) extension.

## 6. Env vars the code reads but `.env.example` doesn't list

| Var | Read by | Purpose |
|---|---|---|
| `BROWSER_MODEL` | `packages/agents/src/assistant/index.ts` | Display model for browser decisions (default `Haiku 4.5`) |
| `SCHEDULER` | `apps/server/src/env.ts` | `on`/`off` for the 30 s routines tick (default on) |
| `DANA_ERRAND_RECORDING`, `DANA_REPLAY_SPEED` | `packages/agents/src/assistant/errand-replay.ts` | Fixture-mode browser errand replay |
| `FABRIC_DEBUG_PROMPT` | `packages/agents/src/assistant/index.ts` | `1` logs Dana's system prompt per turn |
| `SAKESAN_BOOKING_URL` | `packages/agents/src/assistant/recall.ts` | Overrides the demo booking URL |
| `MNEMOSYNE_DB` | `scripts/import-mnemosyne.ts` | Path to the memory source |
| `FABRIC_DEV_URL` | `apps/web/electron/main.mjs` | Set by `electron:dev` to load the Vite server |

## 7. Coupling notes for the decoupling pass

- **LLM.** Already behind one factory (`model()` in `packages/agents/src/llm`), but provider details leak through it: Spark's thinking switches (`chat_template_kwargs`), hardcoded model ids and a hand-kept price table. On Spark every persona runs the same model, whatever its display model says.
- **Database.** Plain Postgres through `pg` + Drizzle. The Neon-specific parts are the CLI lookups by project id in seed and scripts, and Neon's pooled/unpooled URL pair.
- **Sandboxes.** Sprites-specific API (`SpritesClient`, `NetworkPolicy` egress rules) in `sprites.ts` and `tools/browser.ts`. Dana's browser is the heaviest piece: a provisioned Sprite running a firewall, a proxy and a worker.
- **Search and email.** One module plus one tool each, behind `toolsFor`. Exa already has a cache fallback; AgentMail is off unless flagged.
- **Embeddings.** Local model, no account, but the heaviest native dependencies in the tree (`onnxruntime-node`, `sharp`).
- **In-app demo code** sits next to the services and leans on them: `DANA_MODE=fixture` (scripted Dana), `DEMO_RECORDING_KEY` (splicing the live start onto a recorded run), `VITE_DEMO`, and the `demo` seed profile.
