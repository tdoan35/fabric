# DANA status — updated Sat Oct 3, ~20:10 PDT (branch `seq/dana`)

Step 4 of §7.0: DANA steps 2–7 (assistant, thread, proposals, handoff, fixture mode, results
message). 14 commits, nothing merged or pushed. Gates: typecheck · test (server 18 / agents 42 /
db 21) · `build -w web` · `check:data` all green; `check:chat` fixture PASSED (~100 s, every
branch); `check:chat --live --times 5` **5/5** (numbers below).

## Spikes
- None assigned here. S1's verdict (plain AI SDK, not Mastra) is applied: `streamText` with
  `prepareStep` forcing `record_disposition` on step 0 only — exactly the footgun S1 found in
  Mastra (`toolChoice: "required"` re-applied every step) avoided by construction.

## Done
- **`packages/db/src/provision.ts`** — `provisionTeam(db, {team, templates, origin, org?})`: the ONE
  shared creation path for approved teams/specialists. Creates missing agent rows from persona
  templates (they leave `persona_pool`), the team + members (roster order, lead flag), the org slot
  in ty-lab and the Research → Product preview edge once both teams exist. Idempotent; `services/sim.ts`
  now calls it, so the dev sim and a real approval produce the same rows.
- **`packages/agents/src/assistant/`** (thread · prompt · store · teams · handoff · fixture · stream ·
  transitions · index):
  - **thread.ts** (pure): `parseIncoming`/`diffThread`/`toModelMessages`. The stored thread is
    authoritative: only the latest user message (when it lands last and isn't the stored tail) and
    `{decision}` results on human tool calls the server itself stored are taken from the request.
  - **prompt.ts**: the system prompt = Dana's workspace files from the DB + a compact registry brief
    + routing rules and worked examples (the demo conversation). Small and fixed.
  - **store.ts**: sessions (unknown id → row with title from the first message → `registry.changed`),
    chat_messages, dispositions (with `considered[]`, CHAT-13), proposals (pending rows carrying
    `proposalId`/`supersedes` in the payload, keyed by `toolCallId`).
  - **teams.ts**: proposal → registry rows. The canonical definition for a demo team is the fixture's
    (so the registry after approval matches the world UI-WORK was built against); the roster filter
    means team approval creates only what that card authorizes — Sana joins when HER card is approved.
    `applyApproval` runs `provisionTeam`, then TOOLS `createInbox` per new agent (stub → one log line).
  - **handoff.ts**: `runHandoff` = compileBrief (no transcript) → `createTask` (session's project or
    Engram, `recordingKey = DEMO_RECORDING_KEY`) → `startRun(…, {assistantTokens:
    measureAssistantContext(dana)})` → `team.startTeamRun` (NotImplementedError → one line; the run
    stays running for splice) → `task.changed` + `run.changed`. Returns the HandoffPayload.
  - **fixture.ts**: scripted Dana — the same branches as `mockAssistant`, the same stream, the same
    real side effects. Cards are the enriched payloads (CARD-1/D1): roster with real agentIds/roles/
    avatars, persona from the pool, workflow, reworkBudget, criteria, leadDefaults; `fixtureBrief`
    is the deterministic offline brief. A re-proposal after "chat about this" supersedes (CARD-4).
  - **stream.ts / transitions.ts** (pure, unit-tested): the forced-first-call policy and the
    proposal state transitions.
  - **index.ts**: `createAssistant({writer, team, db, publish, mode?, recordingKey?, modelFor?,
    createInbox?})`. Live turns: `streamText` on `model(dana.agent.model, {thinking: "off", meter:
    {agentId: "dana", step: "chat"}})`, temperature 0.2, ≤6 steps; `record_disposition` forced on
    step 0; the turn is retried once if no disposition ever lands (lines are held back until it
    does). `search_registry` is internal and never streamed. `propose_*` rows are stored when the
    call completes, and the enriched payload (proposalId, supersedes) is what streams.
    `handoff_to_team` executes server-side; its args and result both carry the real HandoffPayload.
    `postResultsMessage` appends the `post_results` message and returns `{messageId}`.
- **`apps/server/src/routes/chat.ts`**: `POST /api/chat` NDJSON (`{content: Part[]}` cumulative
  snapshots), `fixture: true` / `x-fabric-fixture: 1` / `DANA_MODE=fixture` select scripted Dana;
  `GET /api/sessions/:id/messages` → `SessionMessages` (results messages included).
- **`services/runtime.ts`** wires `createAssistant` with `db`, `publish → hub.publishApp`,
  `mode: env.DANA_MODE`, `recordingKey: env.DEMO_RECORDING_KEY`. **`services/finalize.ts`** now
  publishes `session.message` with the real message id from `postResultsMessage`.
- **Unit tests** (`packages/agents/src/__tests__/assistant.test.ts`, 14): thread-diff (new user
  message, replayed/duplicate/foreign decisions ignored), model-message mapping, proposal
  transitions (approved/declined/discuss, replayed decisions, superseding), forced first call
  (`prepareStep` wire-level via MockLanguageModelV4: forced on step 0, auto after; retry-once).
- **`scripts/check-chat.ts`** + `npm run check:chat [--live] [--times N]`: seeds demo, starts its
  own server, walks every branch with DB + registry + app-stream assertions, re-seeding between
  phases; live mode replays the happy path N times sequentially with per-turn latency.

## Next
- UI-CHAT (step 5) renders the enriched cards and the `post_results` part on the real stream.
- TEAM (step 7) replaces the `startTeamRun` stub; the run Dana leaves behind is already spliceable.

## Blocked (on whom)
- None. TOOLS `createInbox` and TEAM `startTeamRun` are stubs, caught and logged per §7.0.

## Requests (contract / path / decision)
- **No `contracts:` commits** — nothing needed adding; the frozen types covered everything
  (TeamProposal/SpecialistProposal/HandoffPayload fields, ChatRequest.fixture, AppEvents).
- **Path notes (allowed by §7.0, for review):** `packages/db/src/{provision.ts,index.ts}` (the
  shared creation path + export), `apps/server/src/services/{sim,runtime,finalize}.ts` (sim now uses
  provisionTeam; runtime/finalize wiring), root `package.json` (+`check:chat`),
  `packages/agents/package.json` (@fabric/fixtures moved dev→runtime dep) + lockfile.

## Deviations
- **`postResultsMessage` returns `{messageId}`** (the §4.6 interface said void; DATA's status
  already asked for this). Additive; finalize uses it for `session.message`.
- **`handoff_to_team`'s args AND result are the HandoffPayload** — the brief said "the result is a
  HandoffPayload", ARCH §15/mock said args. Setting both means either consumer works.
- **Live-turn robustness beyond the plan** (all hit during `--live` runs): a forced-call violation
  (vLLM ignores `tool_choice`), a hallucinated tool name outside `activeTools`, and a duplicated
  card/handoff call each invalidate the turn and retry it once; `compileBrief` failing on the lane
  falls back to the deterministic brief (ARCH §11). `activeTools` is re-asserted every step — a
  step-level `prepareStep` return overrides the top-level option (wire-level unit test pins it).
- **The post-approval progression is tool-guarded, not just prompted**: after a team approval the
  turn's active tools are the specialist card; after the specialist approval, the handoff.
- **Decline/discuss fixture turns carry a disposition too** (the mock's don't) — every turn records
  one (CHAT-13); `handle_directly`/`clarify` with the considered options.
- **Fixture mode's brief is deterministic** (`fixtureBrief`), not an LLM call, so scripted Dana works
  with the lane down. Same shape as compileBrief's output (objective/constraints/criteria/
  preferences/stayed + tokens via the same counter).
- **Team approval creates only what the card's roster names** (plus existing agents): the fixture
  definition includes Sana, but she joins on her own card's approval. Sim still materializes all
  five in one go — that's the post-approval world it stands for.
- **`direct` reply line drops the mock's "(Mock reply: the backend isn't connected yet…)" note** —
  false server-side. Mock's `mockContext.agent !== "Dana"` branch is web-only (server chat is
  Dana-only in phase 1).
- **The generic-fallback brief uses a 3 h time budget** (`BUDGET_TIME_S`), matching the recorded
  loop's scale; real budgets come with TEAM's enforcement.
- **A turn whose model output has no record_disposition after one retry streams nothing and logs a
  warning** rather than fabricating a disposition. Unreachable in practice with the forced toolChoice.
- **`sessions.status` flips to `input` while a proposal waits, `unread` otherwise**; `updated` is a
  coarse relative label ("now", "12m") like the seeded rows.

## Notes for UI-CHAT
- **Request**: `POST /api/chat {sessionId, messages, fixture?}` where `messages` is the thread as
  your runtime holds it: `[{role: "user"|"assistant", content: ChatPart[]}]` (text and tool-call
  parts, `content` may also be a plain string for user turns). Send the whole thread; the server
  diffs it against its own copy and takes only (a) a NEW user message that lands last, (b)
  `{decision}` results on the `propose_*` calls IT stored. After `addResult`, re-send the thread
  with the result stamped on the assistant part — see `decide()` in `scripts/check-chat.ts`.
- **Stream**: NDJSON, one `{content: ChatPart[]}` per line, cumulative snapshots (replace, don't
  append). Every turn starts with a `record_disposition` tool-call (result `{recorded: true}`),
  then one text part, then optionally one trailing tool-call. `search_registry` never appears.
  Human tools (`propose_team`, `propose_specialist`) stream WITHOUT `result` and end the turn.
- **Enriched cards**: both `propose_*` args carry `proposalId`, and `supersedes` (the old
  `toolCallId`) on a re-proposal — collapse the old card, point at the new one. Team args:
  `roster[{agentId, name, role, status, avatar}]`, `workflow[{label, agentIds, gate?}]`,
  `reworkBudget`, `criteria[]`, `leadDefaults[{label, value, why}]`. Specialist args add
  `persona {id, name, role, avatar}`. Decided cards reappear in history with
  `result {decision}` set.
- **`handoff_to_team`**: args and result are the same `HandoffPayload` — `runId`, `taskId`,
  `teamName`, `summary`, `members[{name, role, agentId, state}]` (the first two workflow stages'
  members, gerund states). Use `taskId`/`runId` for "View loop".
- **`post_results` part** (appended by finalize, restored from history): args = the `ResultsPayload`
  (`reportId, runId, taskId, title, summary, rows`), `result {posted: true}`, preceded by the text
  "I got the results here.". It arrives live via `session.message {sessionId, messageId}` on
  `/api/stream` (single `event: app` name) — `messageId` is the real message id; refetch
  `GET /api/sessions/:id/messages` and show it.
- **Thread rules**: the server creates the sessions row on first POST (title from the first message;
  `projectId` null → tasks go to Engram) and emits `registry.changed`. History:
  `GET /api/sessions/:id/messages` → `{sessionId, messages: ThreadMessage[]}` — restore the thread
  from it on mount (IA-5).
- **Fixture switch**: per request `fixture: true` or header `x-fabric-fixture: 1` (your hotkey), or
  globally `DANA_MODE=fixture`. Same stream, same side effects — a fixture-approved team/handoff is
  indistinguishable from a live one in the registry.
- **Card data note**: the streamed `propose_team` args are the STORED payload — `proposalId` and
  `supersedes` are always present on what you render.

## How to verify
```bash
npm i && npm run typecheck && npm test && npm run build -w web   # all green
git diff main -- apps/web                                        # empty: mock mode untouched
npm run check:chat                                               # fixture, every branch (~100 s)
npm run check:chat -- --live --times 5                           # Spark, sequential, 5/5
npm run check:data                                               # DATA e2e unchanged (56.5 s)
# by hand: seed demo, run the server on that branch, then
curl -N -X POST localhost:8787/api/chat -H 'content-type: application/json' \
  -d '{"sessionId":"demo1","fixture":true,"messages":[{"role":"user","content":[{"type":"text","text":"I want to test an idea: graft an n-gram / Engram lookup table onto a much smaller open model to boost its capability. The table could live on NAND instead of RAM."}]}]}'
npm run seed -- --profile demo --branch demo                     # leave demo clean afterwards
```
Last runs (Oct 3, evening): fixture `check:chat` PASSED 100.2 s (all asserts, every branch); live
5/5 (table below); `check:data` 56.5 s / 20 asserts; suites 18 + 42 + 21; `git diff main -- apps/web`
empty.

## Live results (`--live --times 5`, Spark `qwen3.8-flash-next`, thinking off, temp 0.2)
**5/5, PASSED in 565.1 s** (branch demo, sequential, re-seeded between passes). Per-turn latency
(POST → last NDJSON line):

| pass | idea | approve-team | approve-specialist | total |
|---|---|---|---|---|
| 1 | 30.8 s | 16.1 s | 40.9 s | 89.3 s |
| 2 | 33.9 s | 17.8 s | 22.1 s | 75.5 s |
| 3 | 30.7 s | 17.9 s | 19.5 s | 69.7 s |
| 4 | 26.5 s | 17.5 s | 37.8 s | 83.4 s |
| 5 | 35.0 s | 17.1 s | 40.0 s | 93.7 s |

Fixture-mode turns for scale: idea 3.8 s · approve-team 4.3 s · approve-specialist 5.4 s. The live
idea and specialist turns are slower because they add a `search_registry` step and (for the
handoff) the `compileBrief` call, on a shared lane that was loaded during the run. Phrasing varied
between passes; assertions are on tool names, order and DB state only, per the brief.
