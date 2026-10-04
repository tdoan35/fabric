# MOB-C status — updated Sun Oct 4 2026, 13:20 PDT

Branch `seq/mobile-work`, cut from `seq/mobile` @ `25249f6` (MOB-A's shared layer). Worktree
`../fabric-mob-c`. Owns `app/(tabs)/work.tsx`, `app/report/[id].tsx`, `components/work/**`; `lib/**`
and `components/ui/**` used as-is. Scope: MOBILE-PLAN §2 M0, the **Work** and **Report** rows.

## Spikes
None needed — MOB-A's spikes (contracts via `file:`, portraits, usePoll) covered the ground. Live
response shapes were re-verified against `@fabric/contracts` anyway (see How to verify).

## Done
1. **Work tab** (`app/(tabs)/work.tsx` + `components/work/{format,task-row}.tsx`):
   - `GET /api/tasks` and `GET /api/runs` in parallel through `httpApi` (zod-checked, same schemas
     as web's `http.ts`), one `usePoll` at the 3 s focus cadence + pull-to-refresh.
   - Tasks grouped by project, in server order; inside a project: running/blocked first, then most
     recent activity (startedAt / proposal.at), proposals last.
   - Each task shows its latest run (last entry of `runIds`): status pill (running→`run`,
     blocked→`warn`, accepted→`ok`, stopped→`muted`, per MOB-A's mapping), cost `$x / budget`
     (amber when over), `rework used/budget` (bounces counted the same way as web's `reworkOf`),
     `ETA <time>` when `etaS` is present on a running loop, and `loop N` past loop 1.
   - Recorded runs marked with a small `replay` pill; `preview` tasks keep the web's Preview tag.
   - Run row is tappable **only** when the latest run has a `reportId` → pushes `/report/<id>`;
     otherwise it shows a non-interactive "Open on desktop" hint (no dead button).
   - Tasks with no runs render the web's proposed-card content: "Proposed" pill + the proposal's
     purpose + "Waiting for your yes — decide in Weave or on desktop".
   - Empty state ("No tasks yet"), first-load spinner, and error states (full-screen when no data,
     inline `ErrorState` with retry under content when stale data exists — venue-network safe,
     matching `usePoll`'s keep-last-data contract).
2. **Report screen** (`app/report/[id].tsx` + `components/work/result-table.tsx`):
   - `GET /api/reports/:id` via `httpApi.getReport` (404 → `undefined`), plus `getRun(report.runId)`
     for the recorded check. One-shot fetch (a report is immutable; the 3 s poll is a Work-tab
     thing) with pull-to-refresh and retry for flaky networks.
   - Shows title (also in the nav bar), intro, Setup rows, Summary, the held-out-perplexity table
     (config · ppl · Δ · valid/**contaminated** — never colour alone), Caveats, Provenance rows,
     Made by (persona portraits via `avatar()`, slug text when no portrait), artifact **names
     only**, and "Also emailed to you via AgentMail" when `emailed`.
   - Honesty badge (DEMO-SCRIPT §4): `kind === "illustrative"` → "Illustrative"; otherwise
     `kind === "real"` or `run.recorded` → "Replay of a recorded run".
   - 404 renders a clean "Report not found" state; header keeps its back button.
3. Verified headlessly: `tsc --noEmit` clean, `expo export --platform ios` clean, `expo-doctor`
   21/21, root `npm run typecheck` exit 0, live `/api/tasks` `/api/runs` `/api/reports/report-ngram-1`
   parse with the exact app schemas (5/5/1 ✓, unknown id → 404), `apps/web` untouched, mock mode
   untouched.

## Next
- Nothing further in my slice. M0 leftovers live with MOB-B (Weave list + item) and the integrator
  (merge + on-device pass).

## Blocked (on whom)
- Nothing code-side. On-device demo checks need the owner (see How to verify).

## Requests (contract / path / decision)
1. **lib/api.ts (MOB-A, frozen)**: add `listProjects: () => request<Project[]>("/projects", z.array(ProjectSchema))`
   — the endpoint exists (web's `workLoader` uses it). Until then the Work tab groups by `projectId`
   and the group header shows the raw id (`engram`), not the project name. One-line additive change;
   I'll swap the header to `project.name` the moment it lands.
2. None to contracts or the server — M0 needed no changes (as the plan predicted).

## How to verify
Headless (all green on `seq/mobile-work` @ `0e99c09`):
```bash
cd ../fabric-mob-c/apps/mobile && npx tsc --noEmit          # clean
cd ../fabric-mob-c/apps/mobile && npx expo export --platform ios   # clean export to dist/
cd ../fabric-mob-c/apps/mobile && npx expo-doctor           # 21/21
cd ../fabric-mob-c && npm run typecheck                     # exit 0 (mobile not in workspaces)
# server on :8787 (it was already running; it listens on every interface):
curl -s localhost:8787/api/tasks | jq length                # 5
curl -s localhost:8787/api/runs | jq '.[].status'           # accepted/running/blocked mix
curl -s localhost:8787/api/reports/report-ngram-1 | jq .id  # report-ngram-1
# same schemas as the app (run from apps/mobile so @fabric/contracts resolves):
npx tsx -e 'import {TaskSchema,RunSchema,ReportSchema} from "@fabric/contracts";
const g=(p:string)=>fetch("http://127.0.0.1:8787/api"+p).then(r=>r.json());
void Promise.all([g("/tasks").then(t=>TaskSchema.array().parse(t).length),
                  g("/runs").then(r=>RunSchema.array().parse(r).length),
                  g("/reports/report-ngram-1").then(r=>ReportSchema.parse(r).id)])
  .then(([tasks,runs,report])=>console.log(`tasks ${tasks} ✓ runs ${runs} ✓ report ${report} ✓`))'
# → "tasks 5 ✓ runs 5 ✓ report report-ngram-1 ✓"
```
Still needs the owner's phone (Expo Go SDK 57, `EXPO_PUBLIC_API_URL` = hotspot/tailnet IP):
- Work tab: groups render ("engram · 5"), the 135M task shows Accepted + `replay` + `$0.42 / $1.00` +
  `rework 1/2`, NAND probe shows Blocked amber with rework 2/2 over budget, "race test" shows a live
  ETA within 3 s of a desktop handoff (plan §6 step 5), pull-to-refresh spins.
- Tapping the 135M run opens the Report screen; every other run shows "Open on desktop".
- Report screen: "Illustrative" pill on the seeded report; after a real Fast-forward + finalize the
  new report shows "Replay of a recorded run"; table reads valid/contaminated correctly on-device;
  a bogus id (e.g. long-press → open `/report/xyz`) shows the not-found state.
- Portrait faces render in "Made by" (webp check already proven by MOB-A's debug screen).

## Deviations
- **Report fetches once, not on the 3 s poll.** A finalized report is immutable; polling it is
  wasted requests on a venue network. Work keeps the plan's 3 s focus poll + pull-to-refresh.
- **Group headers show `projectId`** until the `listProjects` Request lands (endpoint exists; lib is
  frozen). Grouping/order logic already takes names if provided.
- **No stage dots / step labels on task rows.** Those come from the team workflow, which needs the
  registry (`/api/registry` isn't in mobile's M0 client); the loop view stays desktop. The row keeps
  the numbers the plan asks for: status, cost/budget, rework, ETA, loop count.
- **"Open on desktop" is a hint, not a button** — there is no desktop deep link yet; a dead button
  would be worse.
- **ETA renders as wall-clock time** (`ETA 3:42 PM`, computed from `startedAt + etaS`) like the web
  board, not as a duration.

## Notes for the next step
- Seed gives every row state in one screen: accepted+report (`run-ngram-1`/`report-ngram-1`,
  `recorded=true`, `kind="illustrative"`), running×2 (one with `etaS`, one at $0), blocked with
  rework budget exhausted, and a bare proposal (`product-bet`). Good fixtures for the on-device pass.
- Pill variants used: `run`/`warn`/`ok`/`muted` for run status, `replay` for recorded + proposed +
  the two report badges. Keep that mapping if Work grows states.
- `components/work/format.ts` holds the shared derivations (`reworkUsed` = bounce segments, `etaAt`,
  `latestRunOf`); Weave's detail screens can reuse them for run references.
- When `listProjects` lands: replace the header text in `app/(tabs)/work.tsx` (`group.projectId` →
  name lookup) and fetch projects inside the same `usePoll` Promise.all; no other change.
- The report screen sets the nav-bar title from the report (`Stack.Screen options`); long titles
  truncate natively.
- M1 thought: `ResultTable` renders straight off `ReportSchema["results"]`; if chat needs result
  cards later, reuse it instead of a second table.
