# SCH status — updated Sun Oct 4, ~13:30 PDT (branch `feat/schedule`, cut from `seq/team` @ a4d7705)

The Schedule feature, one pass end to end (plan: `docs/SCHEDULE-PLAN.md` on `seq/team`). 7 commits,
nothing merged or pushed. Gates at last run: workspace typecheck clean · server tests 31 (3
pre-existing lived-in parity failures from branch drift, see Deviations) · agents 65 · db 28
(writer-race times out — pre-existing on the shared branch, passes at a quiet moment) · mock-mode
browser checks all pass (`/tmp/sched-shots/`).

## Spikes
- None. croner v10 (zero deps, tz-aware) does both next-run iteration and the DST-correct window
  expansion; pinned by unit test across the Nov 1 2026 Los Angeles fall-back.

## Done
- **Contracts** (additive under contracts-v1): `src/schedule.ts` — Recurrence/Schedule/ScheduleFire/
  Occurrence, zod schemas bound with `satisfies z.ZodType<T>`, pure `toCron`/`describeRecurrence`,
  and the `schedule.changed` AppEvent member. Covered in `contract.test.ts`.
- **DB**: `schedules` + `schedule_fires` (unique `(schedule_id, scheduled_for)`), migration `0004`,
  `generate`/`migrate` scripts in `packages/db`, `src/schedules.ts` (list/get/insert/update/delete,
  `claimFire`/`finishFire`/`listFires` with the run joined in). Claim-race test: 10 concurrent
  claims, exactly one wins. Fixtures (`fixtures/src/schedules.ts`) + seed wiring: lived-in gets all
  three routines and their past fires (accepted/posted/blocked/skipped), demo keeps Dana's digest
  only (SEED-1: no Research Team leak).
- **Dana**: `Assistant.runScheduled` — one `generateText` with her system prompt + memories, Exa
  search as the only tool, reply inserted as a header part + text, thread touched unread;
  `DANA_MODE=fixture` returns the canned digest.
- **Server**: `routes/schedules.ts` (CRUD, run-now, skip, occurrences overlay), `services/
  schedule-fire.ts` (team jobs through the generalized `startTeamJob` — the dev route calls the same
  function; assistant jobs via runScheduled), `services/scheduler.ts` (30 s tick, 10-min catch-up,
  missed sweep bounded by createdAt, `SCHEDULER=off`), env flag + mount in `index.ts`.
- **Web**: api methods in http + mock (in-memory store, croner expansion identical to the server's),
  route/loader (`?week=`), `schedule.changed` revalidate, nav above Work; `components/calendar/
  mini-calendar.tsx` extracted from day-rail (Weave passes `weaveDayMarkers` through `marks`); page /
  week grid / occurrence sheet / editor with the Work board's glass panel and Segmented.

## Next
- Merge onto `seq/team` after the docs move lands there (this branch keeps docs at their committed
  root paths; the rename to `docs/` is staged-but-uncommitted on `seq/team`).
- Wire the mock's "Run now" team fire to a fake run that later flips to accepted, so the mock demo
  can show the running → accepted transition too.

## Blocked (on whom)
- None.

## Requests (contract / path / decision)
- The Neon AI Gateway rejects `claude-sonnet-5-5` right now (`llm:check` crashes at HEAD too);
  http-mode verification ran on `LLM_PROVIDER=spark`, the designed fallback. Whoever owns the gateway
  credits should re-check before the demo.

## Deviations
- Docs edits live at the committed root paths (`ARCHITECTURE.md`, `MOCKUP-GAPS.md`,
  `status/schedule.md`); `seq/team` has the rename to `docs/` staged, so the merge moves them.
- The lived-in parity suites fail on tasks/runs/registry on the shared branch (extra rows from
  `check:team` runs); reseeding lived-in fixes the registry row (sessions now carry the routines'
  threads, both sides updated) but tasks/runs parity needs the branch left alone or reseeded before
  the next gate run.
