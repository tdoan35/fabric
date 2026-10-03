# UI-WORK status — updated Sat Oct 3, 3:30 PM PDT (branch `seq/ui-work`)

Step 2 of §7.0. UI-WORK 1–9 landed in 6 commits (40aaf88…7ebd568); this session finished the step with
3 more (deps, reports-to-data, and the verification pass). Nothing merged or pushed.

## Spikes
- None assigned. S8 (live tail) verified from the UI side: `check:data` measures the SSE arrival
  (last run 592 ms, budget 1 s) and the loop view renders streamed events live (demo-flow asserts the
  clock grows between frames: 6 → 8 s).

## Done
- **1. `api`:** `lib/api/http.ts` next to `mock`, chosen by `VITE_API_MODE` (`lib/api/index.ts`);
  dev-mode responses validated against the `@fabric/contracts` zod schemas; recordings play the
  fixture bundle offline.
- **2. Registry store:** `lib/registry.ts` hydrates in the root loader from `GET /api/registry` and
  refetches on `registry.changed`; mock imports replaced by registry getters across Studio, Teams,
  Orgs, sidebar, TeamHero, Work, and the chat heroes. D7 hiding works on the demo seed.
- **3. Board/task refetch** on `task.changed` (root revalidate + registry store).
- **4. Live clock:** `useRunClock` ticks live runs from SSE (`/api/runs/:id/stream`), badge reads
  Live only on a live source; `?live=1` zooms the live start.
- **5. Fast-forward** calls `POST /splice {t}`, swaps in the returned run + merged log at 600× with
  its pauses, and calls `POST /finalize-splice` at the end (verified end-to-end twice today).
- **6. Inspector:** section `content` with `sectionText` fallback; `snapshot.sandbox` rendered.
- **7. Report:** Setup section, artifact links (stored ids → `GET /api/artifacts/:id`), and the
  "Illustrative" label from `report.kind`.
- **8. Org view:** dashed handoff edge with its question and "Preview — not built" (http mode).
- **9. Weave:** hydrates from `GET /api/weave`, appends on `weave.changed`; decisions stay client-side.
- **This session (finishing):**
  - `apps/server` pinned to `drizzle-orm ^0.45.3` (= `@fabric/db`); `sql` re-exported from
    `@fabric/db`; all server files import it from there. `npm ls drizzle-orm`: one version (0.45.3).
  - **Reports moved into data:** the 135M Setup rows live in the bundle's `report.setup`
    (`make-fixture-recording.ts`, `ngram-135m.json` regenerated); `importRecording` stamps artifact
    ids onto the report it inserts; `finalize` maps the copied report's artifacts to the recording's
    artifact rows; `GET /api/reports/:id` serves the stored row as-is (no read-time invention).
  - Electron + `app://fabric` verified in http mode; CORS verified from Node (below).

## Next
- UI-CHAT (step 3). Nothing pending on UI-WORK.

## Blocked (on whom)
- None.

## Requests (contract / path / decision)
- `contracts:` **2b198bd** — aggregate read-model schemas (`packages/contracts/src/read-models.ts`),
  additive; consumed by `lib/api/http.ts` dev checks.
- **POST /api/dev/sim** (40aaf88) — new dev-only route + `services/sim.ts`; the UI flows need a
  simulated live run until TEAM lands. Additive; guards on positive `speed`/`window`.
- **Path notes (allowed by §7.0, for review):** this step's finishing commits edit DATA-owned files:
  `apps/server/src/routes/reports.ts` (GET returns the stored report), `services/finalize.ts`
  (artifact-id mapping on the copied report), `packages/db/src/recordings.ts` + `index.ts` (import
  stamps ids; `sql` re-export), `packages/db/src/__tests__/bundle.test.ts` and
  `apps/server/src/__tests__/contract.test.ts` (assertions moved to stored ids + Setup rows),
  `packages/fixtures/src/recordings/ngram-135m.json` + `scripts/make-fixture-recording.ts`
  (Setup rows in the bundle), `apps/server/package.json` + lockfile (drizzle pin).

## How to verify
```bash
npm i && npm ls drizzle-orm                 # one version: 0.45.3
npm run typecheck && npm test               # all green (db 21, server 18; contract suite needs lived-in: npm run seed)
npm run build -w web                        # green
npm run lint -w web                         # only the pre-existing use-mobile.ts error (19 react-refresh warnings)
npm run check:data                          # e2e on demo: seed → sim → S8 → splice → finalize ×2 → app events (~55 s)
npm run seed -- --profile demo --branch demo
npm run dev -w @fabric/server               # server :8787
VITE_API_MODE=http npm run dev -w web       # web :3000, http mode
node /tmp/fabric-ui-work/demo-flow.mjs      # seed demo first; needs headless chrome on :9333
node /tmp/fabric-ui-work/splice-flow.mjs    # after prepare-splice.mjs put a tab on the live loop
node /tmp/fabric-ui-work/verify-cors.mjs    # CORS: registry, both SSE streams, splice preflight (Origin app://fabric)
VITE_API_MODE=http npm run electron:dev -w web -- --remote-debugging-port=9333
node /tmp/fabric-ui-work/verify-electron.mjs && node /tmp/fabric-ui-work/verify-report.mjs
node /tmp/fabric-ui-work/prepare-splice.mjs # seeds nothing; starts a sim and parks the tab on the live loop
npm run seed -- --profile demo --branch demo   # leave demo clean afterwards
```
Last runs: gates all green; `check:data` 54.4 s / 20 asserts; demo-flow `PASS: live clock 6 → 8;
artifact 200; Weave result visible`; splice-flow `PASS: live clock 4 → 6; artifact 200`. Electron
(http, `app://fabric` renderer): Work lists the board, the loop renders (`Replay · 60×` on a recorded
loop), the report shows Setup rows + stored artifact ids + the Illustrative chip, no console errors.
CORS: `app://fabric` allowed on GET `/api/registry`, `/api/stream` (`hello` then `event: app`),
`/api/runs/:id/stream` (`event: run`), and the `POST /splice` preflight (204).

## Deviations
- **Weave and `when()` use the real clock in http mode** (`weaveNow` in `components/weave/format.ts`,
  `when`/`whenFull` in `lib/work.ts`); **mock day markers are hidden in http mode**
  (`weaveDayMarkers()` returns `[]`). Mock mode keeps `WEAVE_NOW` and the fixture markers.
- **The org edge renders in http mode only** (`httpMode &&` guard in `teams-view.tsx`), so the mock
  registry stays unchanged; the edge comes from `registry.organizations[].handoffs`.
- **`?live=1` replays a recorded loop only in mock mode**; in http it zooms a *running* loop
  (`routes/task.tsx` picks `ClockStart`).
- **`POST /api/dev/sim` also materializes the org slot and edge** (inserts `org_slots`/`org_handoffs`
  for `ty-lab` when it creates the Research Team), so the org beat works on the clean demo seed.
- **Spliced-run report content now comes from data, not the route** — the Setup rows ship in the
  recording bundle and artifact ids are stamped at import/finalize (see Requests). The bundle is
  illustrative; LAB replaces the values with real ones later.
- **Demo-flow scratch notes (not repo code):** the reused headless profile restores old tabs whose
  open SSE streams exhaust Chromium's 6-connections-per-host cap on :8787 — new tabs then never open
  their app stream (symptom: no refresh after sim). Use a fresh `--user-data-dir`. Also fixed two
  `\"`-inside-single-quotes selector bugs in `/tmp/fabric-ui-work/demo-flow.mjs` (clock scrubber and
  artifact link); splice-flow already had them right.

## Notes for the next step (UI-CHAT)
- **Registry getters live in `lib/registry.ts`** — `useRegistry()` (re-renders on version bumps),
  plain getters `profileById, myProfiles, communityProfiles, studioTeams, communityTeams,
  organizations, projects, sessions, chatAgents, workTasks, workRuns`, and setters
  `setRegistry / setWorkData / setProjects`. The root loader hydrates; `registry.changed` refetches.
- **Chat components already on the getters:** `assistant-hero.tsx` (`myProfiles`),
  `assistant-thread.tsx` (`chatAgents`, `studioTeams`, `useRegistry`), `composer-bar.tsx`
  (`projects`), `team-hero.tsx` (`profileById`). Keep using them; don't re-import `lib/mock/*`.
- **`session.message {sessionId, messageId}` reaches `/api/stream`** (single `event: app` name, like
  the other AppEvents) — emitted by finalize after Dana's results message. Nothing consumes it yet;
  `routes/root.tsx` handles only registry/weave/task/run events. UI-CHAT should listen for it and
  refresh that thread (messageId is `results-<reportId>` until DANA returns real ids).
- The mock chat adapter/script stays the fallback; chat still renders scripted Dana in mock mode.

## Screenshots
- Mock before/after: `/tmp/fabric-ui-work/before/` vs `after/` (11 pages each). They differ only in
  animated avatars and the report's Illustrative label — layout and copy are unchanged.
- HTTP against production (lived-in): `/tmp/fabric-ui-work/http-production/` (9 pages).
- Demo seed flows (this session's passing runs): `/tmp/fabric-ui-work/demo/` — clean seed
  (`*-clean*.png`, 14:29) and the flow shots from 15:18–15:20: `studio-appeared`, `teams-appeared`,
  `orgs-appeared`, `board-appeared`, `live-loop`, `bounce`, `finalized`, `report`, `weave-result`.
- Electron http run: `/tmp/fabric-ui-work/verify-electron/{work,loop,report}.png`.
- Earlier failure states kept for reference: `demo/org-failed.png`, `demo/teams-failed.png` (the
  stale-tab SSE cap described in Deviations).
