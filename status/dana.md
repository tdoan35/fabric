# DANA status — updated Sun Oct 4, ~10:30 PDT (branch `seq/dana-fast`; step 4 on `seq/dana`)

Step 4 of §7.0: DANA steps 2–7 (assistant, thread, proposals, handoff, fixture mode, results
message). 14 commits, nothing merged or pushed. Gates: typecheck · test (server 18 / agents 42 /
db 21) · `build -w web` · `check:data` all green; `check:chat` fixture PASSED (~100 s, every
branch); `check:chat --live --times 5` **5/5** (numbers below).

**Follow-up `seq/dana-fast` (Oct 4, earlier): live-turn latency and card/creation consistency** — the
card is now filled server-side from the definition approval provisions, `search_registry` is off by
default, the prompt is trimmed, and the round trips in front of the model are cut. See **Latency**
at the end for the before/after tables.

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
    does). `search_registry` is internal, never streamed, and (since dana-fast) not in the default
    active tools. `propose_*` rows are stored when the call completes; the card that streams is the
    server-filled one (`teamCard`/`specialistCard`, see Latency) with proposalId and supersedes.
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
- **dana-fast path note:** `packages/db/src/provision.ts` — provisionTeam batches its agent
  existence check and its team_members insert (same rows, same idempotence; ~7–9 fewer round trips
  per approval). The file header already says DANA owns its intent. Still no `contracts:` commits.

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
  `result {decision}` set. Since dana-fast every field except name/purpose (and the roster/persona
  choice) is server-filled from the team's definition, so the card is exactly what approval
  creates; `leadDefaults` is present only when the lead is new (always, in the demo).
- **`handoff_to_team`**: args and result are the same `HandoffPayload` — `runId`, `taskId`,
  `teamName`, `summary`, `members[{name, role, agentId, state}]` (the first two workflow stages'
  members, gerund states). Use `taskId`/`runId` for "View loop". Live `summary` is the compiled
  brief's objective (since dana-fast); fixture mode keeps the scripted line.
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
npm run check:chat -- --live --times 3                           # Spark, sequential, 3/3 + timing table
npm run check:data                                               # DATA e2e unchanged (56.5 s)
# by hand: seed demo, run the server on that branch, then
curl -N -X POST localhost:8787/api/chat -H 'content-type: application/json' \
  -d '{"sessionId":"demo1","fixture":true,"messages":[{"role":"user","content":[{"type":"text","text":"I want to test an idea: graft an n-gram / Engram lookup table onto a much smaller open model to boost its capability. The table could live on NAND instead of RAM."}]}]}'
npm run seed -- --profile demo --branch demo                     # leave demo clean afterwards
```
dana-fast runs (Oct 4, earlier): typecheck · test (18 / 52 / 21) · `build -w web` green;
`check:chat` fixture PASSED 98.2 s; live `--times 3` 3/3 (Latency below); `check:data` 55.3 s;
`git diff main -- apps/web` empty.
Step-4 runs (Oct 4, earlier): fixture `check:chat` PASSED 100.2 s (all asserts, every branch); live
5/5 (table below); `check:data` 56.5 s / 20 asserts; suites 18 + 42 + 21; `git diff main -- apps/web`
empty.

## Live results, before dana-fast (`--live --times 5`, Spark `qwen3.8-flash-next`, thinking off, temp 0.2)
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

## Latency (`seq/dana-fast`, Oct 4 earlier)

`npm run check:chat -- --live --times 3` on Spark (`qwen3.8-flash-next`, thinking off, temp 0.2),
sequential, branch demo. Times are from the POST to the first NDJSON line carrying each piece:
the disposition chip, the first text, the card (a `propose_*` part) or the handoff with its
result, and the end of the stream.

**Before** (`main` @ cec2967, check:chat's timing table added first; 3/3 PASSED in 388.1 s):

| pass | turn | disposition | text | card / handoff | done |
|---|---|---|---|---|---|
| 1 | idea | 6.1 s | 10.3 s | 29.0 s | 29.5 s |
| 1 | approve-team | 7.2 s | 8.5 s | 17.4 s | 18.0 s |
| 1 | approve-specialist | 8.0 s | 8.0 s | 41.5 s | 42.0 s |
| 2 | idea | 6.7 s | 11.5 s | 29.0 s | 29.5 s |
| 2 | approve-team | 13.8 s | — | 14.6 s | 15.1 s |
| 2 | approve-specialist | 7.0 s | 7.0 s | 18.4 s | 18.9 s |
| 3 | idea | 6.9 s | 11.1 s | 33.6 s | 34.2 s |
| 3 | approve-team | 16.7 s | — | 17.5 s | 18.1 s |
| 3 | approve-specialist | 7.7 s | 7.7 s | 44.1 s | 44.7 s |
| **median** | idea | 6.7 s | 11.1 s | **29.0 s** | 29.5 s |
| **median** | approve-team | 13.8 s | 8.5 s | 17.4 s | **18.0 s** |
| **median** | approve-specialist | 7.7 s | 7.7 s | **41.5 s** | 42.0 s |

**After** (final branch; 3/3 PASSED in 258.0 s, every assert including card == created team; no
retries or warnings in any turn — the server-notes column held only the TOOLS createInbox stub
lines, which the column now leaves out):

| pass | turn | disposition | text | card / handoff | done |
|---|---|---|---|---|---|
| 1 | idea | 5.2 s | 6.4 s | 10.5 s | 11.0 s |
| 1 | approve-team | 13.0 s | 13.0 s | 13.8 s | 14.3 s |
| 1 | approve-specialist | 6.1 s | 6.1 s | 18.3 s | 18.8 s |
| 2 | idea | 5.2 s | 6.4 s | 10.1 s | 10.7 s |
| 2 | approve-team | 7.5 s | 7.5 s | 7.9 s | 8.4 s |
| 2 | approve-specialist | 5.5 s | 5.5 s | 18.2 s | 18.7 s |
| 3 | idea | 5.1 s | 6.2 s | 10.2 s | 10.8 s |
| 3 | approve-team | 9.1 s | 9.1 s | 9.5 s | 10.0 s |
| 3 | approve-specialist | 8.7 s | 8.7 s | 14.4 s | 14.9 s |
| **median** | idea | 5.2 s | **6.4 s** | **10.2 s** | 10.8 s |
| **median** | approve-team | 9.1 s | 9.1 s | 9.5 s | **10.0 s** |
| **median** | approve-specialist | 6.1 s | 6.1 s | **18.2 s** | 18.7 s |

Medians across the three after-runs (each 3/3; the first predates the handoff-by-id fix):

| run | idea text / card | approve-team done | handoff card / done |
|---|---|---|---|
| after 1 | 6.5 / 10.4 s | 9.6 s | 17.7 / 18.2 s (one 37.4 s outlier: the id bug below) |
| after 2 | 6.6 / 10.7 s | 15.0 s (two slow single steps on the shared lane, no retry) | 17.0 / 17.6 s |
| after 3 | 6.4 / 10.2 s | 10.0 s | 18.2 / 18.7 s |

**Against the targets:** idea turn text ~8 s → **6.4 s**, card ~12 s → **10.2 s** (met in all 9
passes). Approval turn ~10 s → **10.0 s** median of the final run; 5 of 9 after-passes ≤ 10 s, the
other four 14–16 s. The one slow pass with the notes column was a single slow step and no retry
(the shared lane); the earlier three predate the column, so a retry there can't be ruled out. Its
probes ran 9.3–10.3 s (6 samples). Handoff turn ~15 s → **14.9–19.5 s, median
~18 s: not met.** Why, with the numbers (per-step probe, one handoff turn):
- ~1.1–1.5 s of Neon round trips before the model starts (the specialist approval: Sana's agent
  row, the member row, the org rows; then the turn's reads). Cut from 2.1–2.8 s; the rest is
  DATA's locked transactions in provisionTeam (~67 ms per round trip from here).
- One or two model steps: when the lane puts disposition + text + handoff in one response the
  call lands at ~8 s; when it splits them (forced disposition first, then text + handoff) a second
  first-token wait plus the args land it at ~11 s. This is the lane's choice per sample — 1 of 3
  final passes was single-step (14.9 s), 2 of 3 split (18.7–18.8 s).
- `compileBrief` (CTX, one structured-output call): **2.9–5.1 s** for 97–176 output tokens
  (measured 3× standalone). The task is now created alongside it; the run needs the brief.
- `startRun` (DATA's writer: locked transaction + `run.started` emit): ~0.9 s, ~13 round trips.
Pushing below ~15 s consistently would need the brief off the critical path (a CTX/ARCH
decision) or the approval provisioning overlapped with the first model step (≈1 s; it needs an
in-memory projection of the post-approval registry for the prompt — judged not worth the risk
here).

### Where the time went (probe, before)
Per model step on this lane: 1.3–2 s to first token, ~37 output tokens/s. The idea turn was step 0
(forced disposition: **2,974 prompt tokens**, 100–160 output tokens, a 60-token `reason`) → a
`search_registry` step (2.5–5 s) → text + `propose_team` with **740–800 output tokens** of
model-written workflow/criteria/leadDefaults (~21 s). Every turn also spent **2.0–2.8 s in
sequential Neon round trips** before the first model call (approval provisioning alone was ~23).
Inside a step the lane surfaces tool calls only when the response ends, so the disposition chip
appears when its step finishes.

Step 0 prompt tokens (lane-reported): idea 2,974 → **2,086–2,168**; approve-team 3,354–3,416 →
**2,536–2,555**; handoff 3,824–3,877 → **2,867–2,918**. The card's model-written args went from
1,884–2,711 chars to ~220–260 (name, purpose, four ids); the stored card is still the full
~1,600-char payload, server-filled.

### What changed (commits on `seq/dana-fast`)
1. **check:chat timing table** (first, so "before" is measured with it), later a server-notes
   column (retries, unusable input, failed tools per turn).
2. **db: provisionTeam batching** — one `id in (…)` lookup and one multi-row `team_members` insert;
   members-with-rows from that lookup plus what it created. Same rows; ~7–9 fewer round trips.
3. **The card is the team** (`teams.ts` `teamCard` / `specialistCard` / `resolveTeam`): the model
   supplies name, purpose and roster ids (specialist: name, purpose, persona id). Workflow, rework
   budget, criteria and lead defaults come from the definition approval provisions — the fixture's
   (LEAD_DEFAULTS for the Research Team; the rework row follows the budget) or a plan → work →
   review default for unknown teams (criteria, budget 2, generic lead defaults when the lead is
   new). The roster is normalized to what provisionTeam will create (ids or names resolved; anyone
   it can't create dropped; a matched team keeps its lead), and the matched team's canonical
   name/purpose go on the card. Approval re-resolves the stored card, so the payload equals the
   created team, and a re-proposal's budget carries through. Specialist rows come from the
   Validator role template, else the model's (optional), else two default rows. Fixture mode builds
   its cards with the same functions. Schemas accept the stored card's object shapes too (what the
   model sees in history); unusable card input retries the turn once.
4. **search_registry off by default** (kept as a tool, out of the default and post-approval
   activeTools, out of the prompt) and **the prompt trimmed** (see token numbers above). The
   worked examples still open with `record_disposition(…)`: a first trim dropped that and the lane
   skipped the forced call after an approval (twice in a row → an empty turn).
5. **Round trips in front of the model:** the registry view is one query (`readDanaView`), the
   pre-turn reads run in parallel, `recordDisposition` is one statement (was a 5-round-trip
   transaction between step 0 and step 1).
6. **Handoff:** the card's `summary` defaults to the compiled brief's objective (one field fewer for
   the model); team/Dana/project reads in parallel; the task is created while the brief compiles.
7. **Handoff outliers fixed** (found via the timing table; before and after, 1 in 3 live handoffs
   took 33–44 s): after approval the prompt shows "Research Team (research)" and the lane sometimes
   hands off to the id. The handoff now resolves a team by name or id, and a failed handoff part is
   dropped so the model's corrected call (which it makes in the next step) completes the turn
   instead of forcing a full retry.

### Deviations (dana-fast)
- **Canonical name/purpose on a matched team card**: the brief lists name/purpose as model-supplied;
  for a fixture-matched team the card shows the definition's name and purpose, because that is
  what approval creates (the model's "Engram Research Team" becomes the Research Team row).
- **Handoff `summary` is server-filled** (brief objective), and `handoff_to_team` no longer takes it
  — beyond the brief's list, for the handoff-turn target.
- **`provision.ts` touched** (packages/db, see Requests) and `getTeamByName` accepts ids.
- **`leadDefaults` only when the lead is new** (always true in the demo).
- **Handoff target not met** — numbers and causes above.
