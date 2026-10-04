# TEAM status — updated Sun Oct 4 (branch `seq/team`)

Step 7 of §7.0: TEAM 1–6 plus the brief's decisions 1–6. Commits on `seq/team`, nothing merged or
pushed. Gates: typecheck · test (server 18 / agents 63 / db 21 / integrations 11) · `build -w web` ·
`check:data` · `check:chat` · `check:tools` all green; `npm run check:team` PASSED; the UI check
passed with screenshots in `/tmp/fabric-team/shots/`.

## Spikes

- **S3 — pass, on the fallback by decision (plain async, no Mastra).** S1's verdict (plain AI SDK)
  plus the brief's decision 1 settled this before any Mastra probe was worth the lane time. The
  workflow is `Promise.all` over stage members, a sequential stage loop, and a bounded rework loop;
  cancellation is one `AbortController` per run plus `RunClosedError` exits. Verified live by
  `check:team` (parallel opening lanes, a forced bounce, forced exhaustion, a mid-flight splice).
  Notes for the record: no Mastra dependency was added; the AI SDK's `stopWhen: stepCountIs(n)` +
  step-level `prepareStep` re-asserting `activeTools` give the bounded tool loop DANA hardened, and
  `NoSuchToolError` marks the hallucinated-tool retry.

## Done

- **The seam table** (`packages/agents/src/team/labels.ts`), read off `ngram-135m.json` and pinned
  by unit test — per agent and stage:

  | pass | agent | step label | stage | kind |
  |---|---|---|---|---|
  | 1 | elliot | Plan | Plan | work |
  | 1 | megan | Survey | Prepare | work |
  | 1 | jonah | Setup | Prepare | work |
  | 1 | sana | Prep checks | Prepare | work |
  | 1 | elliot | Synthesize | Synthesize | work |
  | 1 | jonah | Implement | Implement | work |
  | 1 | sana | Validate | Validate | work |
  | 1 | carlos | Review → Bounced | Review | work → bounce |
  | 2 | elliot | Re-plan | Plan | work |
  | 2 | jonah | Rework | Implement | rework |
  | 2 | sana | Re-check | Validate | work |
  | 2 | carlos | Accepted | Review | work |

  Carlos's label depends on a verdict that doesn't exist when his step opens, so it opens as
  "Review" and a request_changes appends the recording's zero-length "Bounced" bounce segment
  (what the stepper's pass logic reads). The demo's splice lands at ~45 s, while only the
  Plan/Prepare labels above are open, so the seam never depends on his.
- **The engine** (`engine.ts`): data-driven over `teams.workflow` — `planPasses` splits opening
  (stage 0 ∥ stage 1, D11), mid (Synthesize → Implement → Validate) and rework (Re-plan → Rework →
  Re-check; the lead's stage stays `work`, non-lead stages run as `kind: "rework"`). The gate is a
  structured-output verdict; accept → `writer.end("accepted")` → finalizeRun; request_changes →
  `rework.requested {to, used, budget}` → the rework pass → review again; exhaustion →
  `run.blocked {reason}` + `end("blocked")` (no report, honestly).
- **Specialist steps** (`steps.ts`): `assembleContext` → `writer.saveSnapshot` BEFORE the model
  call; tools from `toolsFor(agent, {runId, step, writer, db})` plus `teamAssignTool` for the lead
  (under the provider-safe key `team_assign`, events canonical); `generateText` with
  `model(agent.model, {thinking, meter})`, thinking off on the live-start stages and low after;
  the model's step texts become short `agent.message` lines; `budget.update {costUsd:
  runCostUsd(runId)}` after every model call (plus `reworkUsed/reworkBudget` on bounces). Sana
  reports `criterion.checked {index, pass, note}` by index after her own re-check; Carlos's
  verdict call returns its checks in the same object.
- **Hardening** (DANA's pattern): `stopWhen: stepCountIs(8)`, `activeTools` re-asserted per step
  via `prepareStep`, one retry on a hallucinated tool (`NoSuchToolError` → a corrective message
  listing the real tools), a per-step timeout raced against the call — on timeout a labelled
  fallback narration ("<step>: no response within Ns — continuing with what's on file") and the run
  moves on, except Review, which blocks honestly rather than guessing. A model failure in one lane
  logs one line and the run continues. Exa's labelled cache fallback is TOOLS' (8 s → "(cached)").
- **Wiring and cancellation**: `createTeamRuntime({writer, db, publish})` in `services/runtime.ts`
  (additive deps). `startTeamRun(runId)` resolves once the opening `step.started` events are in —
  Dana's handoff turn doesn't wait for the run — and the workflow continues in the background.
  `cancelRun(runId)` (splice) flips the handle, aborts in-flight model calls, and stops scheduling;
  every step body exits quietly on `RunClosedError`/cancel; an in-flight `sprite.exec` finishes
  server-side and its events drop. A cancelled workflow never calls `writer.end` (a spliced run
  must stay closable by finalize-splice).
- **`POST /api/dev/team`** (non-production): `{objective?, toy?, forceBounce?, forceBlock?}` —
  provisions the research team like the sim, creates the task + run with a deterministic brief
  (reworkBudget 1 when forceBlock), and starts TEAM with the hooks. Never on by default.
- **`npm run check:team`** (`scripts/check-team.ts`): seeds demo, starts its own server, then —
  (1) the live start through fixture-Dana's handoff: the four opening `step.started` (labels
  pinned), ≥3 members open within 45 s, Megan's Exa line, Jonah's terminal line, snapshots with
  real section content for every started step; (2) `POST /splice` at ~45 s: no new events after
  splice_t while cancelled, the merged log derives with no missing lane and no stretch, and
  finalize-splice ends with exactly one added `run.finished`; (3) the toy run end to end (accepted,
  verdict, criteria, report, real sprite commands); (4) forced bounce (Rework segment of kind
  "rework", Re-check, then accept); (5) forced exhaustion (`run.blocked`, status blocked, two
  bounces on budget 1). Ends with the timing table and reseeds demo.
- **Unit tests** (9, `packages/agents/src/__tests__/team.test.ts`): the seam table equals the
  bundle per agent/stage/pass, the fallback label rule, the rework kind rule, `planPasses` on the
  real workflow (opening/mid/rework, ≥3 opening members, unflagged gates), `bounceOutcome` (budget
  2 → rework/rework/block; budget 1 → rework/block), and the step prompts (objective grounding,
  the 12-word narration ask, the reviewer's text on rework).

## Next

- OPS (step 9): the demo-day runbook can force a bounce or a block live via `POST /api/dev/team`
  (see Notes), and the timing table from check:team is the rehearsal baseline.

## Blocked (on whom)

- None.

## Requests (contract / path / decision)

- **No `contracts:` commits.** `TeamRuntime.startTeamRun(runId, opts?)` gained an optional
  options bag — the interface lives in `@fabric/agents/team` (my package), additive, and the
  §4.6 call shape `startTeamRun(runId)` still satisfies it.
- **Path notes (§7.0 allows these; for review):**
  - `apps/server/src/services/finalize.ts` — **one-line DATA fix**: the first-ever real finish
    crashed on `endedAt.toISOString` because pg returns `ended_at` as a string (only the splice
    path had been exercised). `new Date(run.ended_at)` now. Covered by check:team's toy run.
  - `apps/server/src/services/runtime.ts` (the TEAM wiring), `routes/dev.ts` +
    `services/dev-team.ts` (the dev route), root `package.json` (+`check:team`).

## Deviations

- **Carlos's step label**: opens as "Review" (the brief's list) and appends the recording's
  "Bounced" zero-length bounce segment on request_changes — his outcome isn't knowable at
  step.start, and the seam at 45 s never sees his lane. "Accepted" only exists in the recording's
  replay (post-splice), which is where the demo shows it.
- **Per-step timeouts are bounds, not pacing** (240 s Prepare/Plan … 120 s Review): the first live
  toy run cut Elliot mid-plan at 90 s, so the bounds were raised; the live demo window closes at
  the splice long before they matter.
- **Sana's criteria report is a second, structured call after her tool work** (thinking off), not
  part of her tool loop; Carlos's checks ride in his verdict object. Both write plain
  `criterion.checked` events by index.
- **Artifacts only through the artifacts tools**: Jonah and Sana have no `artifacts.write`, so
  their files stay in their Sprites (real, visible in terminals); the run's artifacts are Megan's
  survey, Elliot's plan/synthesis (workspace.write → artifact for sandbox-less agents).
- **`team.assign` is orchestration-confirmed, not scheduling**: the workflow is data-driven, so
  Elliot's call emits `handoff {to, step}` and returns `{assigned: true}` — the recording's
  elliot→jonah handoff line, without the model actually driving the DAG.
- **A fast live step bridges, not stretches**: if Jonah's Setup finishes before the splice (seen
  at 18 s), the merged log closes it at its real end and re-opens the recording's at splice_t —
  check:team asserts no missing lane and no stretch rather than one segment. The demo shows a
  hairline gap at 600×; the honest alternative (padding steps) was rejected.

## Notes for OPS

- **Demo-day knobs**: `POST /api/dev/team {toy|forceBounce|forceBlock}` (dev server only) forces
  the rework beats for rehearsal; `TEAM`'s timeouts live in `steps.ts` (`TIMEOUT_MS`); thinking
  levels in `THINKING` (off on Plan/Prepare for the 45 s window).
- **Timings to plan around (check:team's table)**: the four opening steps start ≤ ~2 s after the
  handoff turn; Exa's first line ~10–15 s; Jonah's terminal ~10–20 s; the fixture handoff turn
  itself ~5 s. Splice at 45 s as scripted.
- **Failure modes → fallbacks (L1)**: Spark lane down or slow → the labelled timeout narrations
  keep the run moving; a dead lane never crashes the run; review failing → honest `run.blocked`;
  everything down → Fast-forward immediately (D5 splice works from t≈5 s; lanes bridge) — the L1
  demo (UI-CHAT + the recording) is untouched by this step.
- **Reseed after any dev run**: `npm run seed -- --profile demo --branch demo` (check:team and the
  dev route both scratch the demo branch).

## How to verify

```bash
git checkout seq/team && npm i
npm run typecheck && npm test && npm run build -w web
npm run check:data && npm run check:chat && npm run check:tools   # unchanged
npm run check:team          # ~40 min, sequential on Spark, ends with the timing table
# the UI check (screenshots in /tmp/fabric-team/shots):
npm run seed -- --profile demo --branch demo
DANA_MODE=fixture /tmp/fabric-team/server.sh &                   # demo branch, never prints the URL
VITE_API_MODE=http npm run dev -w web &                          # :3000
/opt/google/chrome/chrome --headless=new --remote-debugging-port=9346 \
  --user-data-dir=/tmp/fabric-team/chrome-$(date +%s) about:blank &
cd /tmp/fabric-team && node ui-check.mjs demo && node ui-check.mjs toy
npm run seed -- --profile demo --branch demo                     # leave demo clean
```
