# DATA status — updated Sat Oct 3, ~13:00 PDT (branch `seq/data`)

## Spikes
- **S0 — pass.** Drizzle migrations committed under `packages/db/drizzle/` (0000–0003), run with `DATABASE_URL_UNPOOLED` (`npm run seed` also migrates programmatically, so a fresh branch is one command). Timed on a brand-new branch (`s0-fresh`, deleted after): **demo 9.0 s**, **lived-in 9.5 s** (seed incl. recording import; ~11 s wall incl. tsx boot). Branches now on Neon: `production` (dev, lived-in seeded), `demo`, `recording`. No ws-* branches.
- **S8 — pass.** `npm run check:data` measures a sim-emitted event arriving on `/api/runs/:id/stream` from Node with `Origin: app://fabric`: **602 ms** after its due time in the last run (322 ms in the first); budget is 1 s. Delivery = hub push for same-process emits + a 400 ms DB poll that catches other processes (sim).

## Done
All 9 DATA steps (§5.3) plus the sim script:
1. **Schema/migrations** for §4.7 in `packages/db/src/schema.ts` (public schema; Mastra gets its own later). `started_at_text` (added): the source timestamp string for seeded/imported runs, so the API returns `"2026-09-29T13:04:00-07:00"` exactly like the mock. `seed_state` records which profile a branch holds.
2. **Seed** `npm run seed -- --profile demo|lived-in [--branch <name>]` — idempotent truncate+insert from `packages/fixtures/src/profiles/`; `--branch` resolves pooled+unpooled URLs via the neon CLI without printing them. Dana's `handoff_to_team` is seeded `allowed` (D3/CARD-8).
3. **RunWriter** (`packages/db/src/writer.ts`): `createTask` (mock slug rule), `startRun` (next loop n, `run-<task>-<n>`), `emit` (payload validated by the contract zod schemas; `seq` = advisory-lock + max+1 per run, safe under TEAM's parallel steps; `t` = seconds since `started_at`; `budget.update {costUsd}` accumulates monotonically), `saveSnapshot` (+`context.snapshot`), `saveArtifact` (+`artifact.created`), `end` → `onEnd` hook → `finalizeRun`.
4. **Read models** (`packages/db/src/read.ts`): registry/work/runs/snapshots/report/weave. `Run.segments` always derived from step events (`derive.ts`); **RUN-7 unit-tested**: the 135M bundle's derived segments equal its precomputed ones, all four mock loops equal theirs.
5. **SSE**: `/api/runs/:id/stream?after=` replays then tails (15 s `ping` heartbeat), `/api/stream` carries AppEvents; both fine from `Origin: app://fabric`. Hub wired through `createRunWriter`'s `onEvent` in `services/runtime.ts`.
6. **Recordings**: `packages/fixtures/src/recordings/ngram-135m.json` (kind `illustrative`, from the mock loop; regenerate with `npx tsx scripts/make-fixture-recording.ts`). `importRecording` is idempotent (recorded=true, no task unless attached, idHints preserve run/report/snapshot ids, seqHints preserve the mock's creation-order seqs); `scripts/export-recording.ts` exports any stored run for LAB.
7. **Splice** `POST /api/runs/:id/splice {t}`: finds the recording via the task's `recordingKey`, cancels the TEAM runtime (stub → one log line), stamps `spliced_from_run_id/splice_t` with a race-free guard; `GET events` returns live ≤ t then the recording > t re-stamped (its own `run.finished` dropped in favour of finalize's); `durationS`/`recording` set on the run.
8. **finalizeRun** idempotent (claim on `finalized_at`): status from the last verdict, report copied from the recording when spliced / synthesized after a real finish, `run.finished` emitted at the merged timeline end, Weave `result` item added, `postResultsMessage` called (DANA stub → one line) + `session.message` still emitted, `sendReportEmail` only when `FEATURE_AGENTMAIL=on` (stub → one line), then `task.changed`/`weave.changed`/`run.changed`.
9. **Registry** serves active rows only; `POST /api/projects {name, goal}` uses the mock's id rule and emits `registry.changed`.

**For UI-WORK:** `npm run sim -- [--speed N] [--window 60] [--session <id>|none] [--runfile <path>]` creates the task (recordingKey=DEMO_RECORDING_KEY), starts a run and replays the first 60 s of the bundle through RunWriter in real time (÷ speed), printing `sim: task … · run …` and leaving the run `running`. On a demo-seeded branch sim materializes the Research Team + Elliot/Sana first so the loop view renders like the mock — it is a dev tool, re-seed for the SEED-1 clean check. `npm run check:data` (defaults: branch `demo`, port 8890) is the full re-runnable e2e: seed → sim → SSE tail (S8) → splice → merged events → finalize ×2 → all §7.0 assertions.

## Next
- UI-WORK (step 2) builds the live tail + Fast-forward against `npm run sim` on the `demo` branch.
- `run.changed` is also emitted on splice/finalize, though §4.4 doesn't require it there.

## Blocked (on whom)
- None. DANA/TEAM/TOOLS stubs are called behind `NotImplementedError` guards that log one line and carry on.

## Requests (contract / path / decision)
- None needed. Everything fit the frozen contracts. (Additive-only, for review: none.)
- **Path notes (allowed by §7.0, listed for the integrator):** edited `packages/fixtures/package.json` (export map entries `./recordings`, `./profiles`), root `package.json` (scripts `sim`, `export-recording`, `check:data`), `packages/{db,server}/package.json` + tsconfig lib ES2024 (deps vitest/drizzle/pg, test scripts), `apps/server/src/services/runtime.ts` was already DATA-owned. No `contracts:` commits.

## Deviations
- **D3 in the data:** the seeded Dana has `handoff_to_team` policy `allowed` (CARD-8); the fixture still says `approval`. Lived-in parity tests apply that one transformation.
- **D9 labels:** the server sets `report.kind: "illustrative"` and `run.recording {key:"ngram-135m", kind:"illustrative"}` on the 135M loop; the mock has neither field. Deliberate (REP-2 / D5).
- **Running loops age honestly:** `durationS` for run360 is `now − startedAt` (contract: "where 'now' is"), so it grows past the mock's frozen m(135); finished loops match exactly. Tests assert ≥ for run360.
- **Segment order:** the 360M fixture groups segments per agent; derived segments are start-ordered. Compared order-insensitively for that loop (the 135M order matches exactly).
- **Splice drops the recording's own `run.finished`** from the merged tail; finalize's `run.finished` (with the live report id) is the single terminal event, at t = recording duration.
- **`stop`/`blocked` runs don't finalize a report** (a stop isn't a finish; `end("stopped")`/`end("blocked")` only claim finality). `RunWriter.end` on an already-finalized run is a no-op.
- **`assistant_tokens` on live runs** defaults to `brief.tokens` until CTX provides Dana's real base context (column exists; no contract impact).
- **`session.message`'s messageId** is `results-<reportId>` until DANA's `postResultsMessage` can return the real message id (interface returns void today — DANA should return the id; happy to wire it).
- **Binary artifacts** are stored base64 in the artifacts.content text column with `application/octet-stream`; the illustrative bundle's `.zip` is a text stub.
- **Imported recordings carry `team_id='research'`** (the bundle's team) even where the team doesn't exist (demo); they're only reachable via splice, never listed.

## Notes for UI-WORK
- Seed: `npm run seed` = lived-in on the .env branch (production). For the clean demo world: `npm run seed -- --profile demo --branch demo`, then point the server at that branch (`DATABASE_URL` from `neon connection-string --branch demo --pooled`; never commit it).
- `GET /api/runs` lists only tasked runs (the taskless recording is hidden); `/api/runs/:id/stream` sends `event: run` (JSON RunEvent) and `event: ping` every 15 s; `?after=<seq>` replays first. `/api/stream` AppEvents: `registry.changed · task.changed {taskId} · run.changed {runId} · weave.changed · session.message {sessionId, messageId}`.
- After splice, `GET events` re-stamps seqs (head keeps live seqs, tail continues); the last event after finalize is `run.finished {reportId}` — use `run.reportId` for links.
- `GET /api/artifacts/:id` returns the bytes with a proper content-type + `Content-Disposition` filename.
- Weave result items land as `result-<reportId>` with actions linking `/reports/<id>` and `/work/<taskId>`.
- `scripts/db-admin.ts` inspects/cleans stray rows on the .env branch (`--clean`).

## How to verify
```bash
npm i && npm run typecheck && npm test && npm run build -w web   # all green
npm run seed                       # lived-in on production (~10 s)
npm run seed -- --profile demo --branch demo
npm run sim                        # live run on the .env branch; prints `sim: task … · run …`
npm run check:data                 # full e2e on branch demo: S8 + splice + finalize + app events
npx tsx scripts/make-fixture-recording.ts   # regenerate the bundle if fixtures/src/run.ts changes
```
S8 last measured 602 ms (budget 1 s); S0 9.0 s demo / 9.5 s lived-in on a fresh branch. Contract suites: 18/18 server (validates every §4.2 GET against the zod schemas + lived-in mock parity), 14/14 db. Mock mode: no `apps/web` changes (`git diff main -- apps/web` empty), web build passes, `npm run dev` serves the mockup on :3000 with `/api/health` on :8787.
