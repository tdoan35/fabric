# MOB-A status — updated Sun Oct 4 2026, 12:40 PDT

Branch `seq/mobile` (5 commits), cut from `main` @ `4e29cf9`. Worked in the linked worktree
`../fabric-mobile` because the root checkout is on `seq/team` with uncommitted work. **SDK: Expo 57**
(`expo ~57.0.26`, `react 19.2.3`, `react-native 0.86.3`, TS ~6.0.3) — install the current Expo Go,
which ships SDK 57 support (MOBILE-PLAN §4: install it the night before).

## Spikes
- **npm climbs out of apps/mobile** — fail, then pass. `create-expo-app`'s install ran against the
  worktree root (it rewrote the root `package-lock.json`, +13957 lines, no local lockfile) whenever a
  root `node_modules/` exists above `apps/mobile`. Fix: move the root `node_modules` aside, install
  inside `apps/mobile` (creates its own lockfile + node_modules), restore. Documented in
  `apps/mobile/AGENTS.md`; root lockfile restored byte-identical (`git checkout --`).
- **`file:../../packages/contracts` in npm 11** — symlink, not copy. `node_modules/@fabric/contracts`
  is a symlink to `packages/contracts`, so contracts changes are picked up live; no Metro
  `watchFolders` config needed. Metro (SDK 57) resolves symlinks + transpiles the raw TS `src/index.ts`
  exports map with zero metro.config.js.
- **Portraits** — pass. The web's `apps/web/public/agents/*.webp` are plain 384×384 WebP stills; WebP
  is in Metro's default assetExts and renders on iOS 14+/Android. Copied to
  `apps/mobile/assets/portraits/` (14 files incl. dana's idle still); `lib/avatar.ts` `avatar(agentId)`
  requires them statically. Dana's animated strip (`happy-idle-strip.webp`, 14016×192) stays web-only.
- **@fabric/fixtures in RN** — yes, imports cleanly: no `node:` modules anywhere in
  `packages/fixtures/src`, and its only non-relative import is `@fabric/contracts` (already proven in
  Metro). Mock mode was **not** built (per scope).

## Done
1. `apps/mobile` scaffolded (`create-expo-app --template tabs`), demo screens/components/fonts
   removed, own `package-lock.json`, **not** in the root workspaces. Root `npm run typecheck` exit 0
   (all 7 workspaces; `mobile` not in the run) and `npm run build` (web) passes in the worktree.
   `apps/web` is untouched on this branch — mock mode is untouched by construction.
2. `@fabric/contracts` wired (`file:` dep + symlink). Proof: `expo export --platform ios` bundles
   1333 modules incl. contracts runtime (zod schema keys present in the Hermes bundle); live
   `:8787` payloads validate against the exact schemas the app uses (runs 5 ✓ tasks 5 ✓ weave 8 ✓,
   unknown run → 404 → undefined). Nothing in contracts failed to resolve in RN.
3. `lib/api.ts` — `httpApi` with `getWeave`, `listTasks`, `listRuns`, `getRun`, `getReport`,
   `getSessionMessages`; mirrors `apps/web/src/lib/api/http.ts` (same schemas, dev-only
   `safeParse` warnings, 404 → `undefined`). `apiBase` from `EXPO_PUBLIC_API_URL`;
   `.env.example` added; `.env` ignored (root + local .gitignore).
4. `lib/use-poll.ts` — `usePoll(fn, 3000)`: immediate fetch, ticks while focused (`useFocusEffect`),
   stops on blur, keeps last `data` on error; returns `{data, error, loading, refresh}`.
5. `lib/theme.ts` — dark-first tokens from `globals.css` (oklch → computed sRGB hex; status families
   verbatim) + radius scale. `components/ui/`: Screen, Card, Pill, Row, ErrorState, EmptyState.
6. Navigation: tabs **Weave · Work**; stack `app/weave/[id].tsx`, `app/report/[id].tsx` — placeholders
   labelled MOB-B / MOB-C.
7. Hidden debug screen `app/debug.tsx` (⌘ button in either tab header): API base, `/api/runs` count
   via `usePoll`, raw `RunSchema.parse` result, and a webp portrait row.
8. `npx tsc --noEmit` clean; `npx expo export --platform ios` clean; `npx expo-doctor` 21/21.

## Next
- MOB-B (Weave list + item) and MOB-C (Work + Report) per the split below; then §6 steps 7–8.

## Blocked (on whom)
- Nothing code-side. On-device checks need the owner (see How to verify).

## Requests (contract / path / decision)
- Integrator: merge `seq/mobile` into `main` (5 commits: plan copy, workspaces narrowing, scaffold,
  skeleton, shared layer). No changes requested anywhere else; contracts worked as-is.
- FYI: root `package.json` workspaces went `apps/*` → `apps/web`, `apps/server`, `packages/*`
  (MOBILE-PLAN §6 step 1 says to remove mobile from any workspace glob; this is the only root edit
  on the branch).

## How to verify
Headless (all run green on this branch, inside `apps/mobile` unless noted):
```bash
cd apps/mobile && npx tsc --noEmit            # clean
cd apps/mobile && npx expo export --platform ios   # 1333 modules, 37 assets (14 webp portraits)
cd apps/mobile && npx expo-doctor             # 21/21 checks passed
cd ../.. && npm run typecheck                 # exit 0; workspaces run, mobile not among them
cd ../.. && npm run build                     # web build ok (pre-existing chunk-size warning)
curl -s localhost:8787/api/health             # {"ok":true} (server must be running)
```
Still needs the owner's phone (Expo Go SDK 57):
- `cp apps/mobile/.env.example apps/mobile/.env`, set the hotspot/tailnet IP, `cd apps/mobile && npm start`.
- App loads with Weave/Work tabs; ⌘ → Debug shows the base URL, a `/api/runs` count > 0,
  `RunSchema.parse ok`, and Elliot's portrait rendering (webp check).
- Tab icons are unicode glyphs (✦/▦) — confirm they read OK on-device; status-bar/splash dark look.

## Deviations
- Worktree instead of the root checkout (root is dirty on `seq/team`); branch cut from `main` as instructed.
- First `create-expo-app` install hit the npm-climb trap (see Spikes); root lockfile restored, install redone locally.
- `docs/MOBILE-PLAN.md` + this file live under `docs/` although `main` still has the pre-restructure
  layout — matches the prompt and the (staged) restructure; merging is conflict-free either way.
- Kept the template's Expo MIT `LICENSE` and its `AGENTS.md` (extended with Fabric rules); kept
  `react-native-reanimated`/`worklets` deps (template defaults, currently unused).
- `app.json`: name "Fabric", dark splash/userInterfaceStyle (dark-first per plan §3).

## Notes for the next step
File ownership for the parallel agents:
- **MOB-B** owns `app/(tabs)/weave.tsx`, `app/weave/[id].tsx`, `components/weave/**`.
- **MOB-C** owns `app/(tabs)/work.tsx`, `app/report/[id].tsx`, `components/work/**`.
- `lib/**` and `components/ui/**` are **frozen after MOB-A**; changes go through Requests here.
  Shared building blocks: `httpApi` (lib/api.ts), `usePoll` (lib/use-poll.ts), `theme`/`dark`/`light`
  (lib/theme.ts), `avatar(agentId)` (lib/avatar.ts), and the `components/ui` barrel.
- Status-pill mapping that matches the web: running → `run`, blocked → `warn`, accepted → `ok`,
  stopped → `muted` (`Pill` variant); replay/badge contexts → `replay`.
- Route params: `useLocalSearchParams<{ id: string }>()`; navigation via `router.push("/weave/<id>")`
  and `/report/<reportId>` (routes are registered in `app/_layout.tsx`; typed routes are on).
- The debug screen (`app/debug.tsx`) is MOB-A's — keep it working; it's the §4 network check.
- `components/weave|work/**` dirs don't exist yet; create them.
- Remember the npm-climb trap before any `npm install` in `apps/mobile` (see AGENTS.md).

---

# MOB-D status — updated Sun Oct 4 2026, 13:30 PDT

Branch `seq/mobile-demo` (the integrator's `mobile-demo` merge of `seq/mobile` + MOB-B + MOB-C,
renamed to the prompt's name), worktree `../fabric-mobile-demo`. MOB-D commits sit on top of the
merge. Scope: demo-path dry run, end-to-end app consistency pass, demo-doc updates.

## Spikes
- **Port 8787** — busy: the root checkout (`seq/team`) has a server on :8787. MOB-D verified
  against its own server on `PORT=8788`; every command below parameterizes the port.
- **Shared Neon `production`** — mid-verification, another session reseeded `production` to
  `lived-in` and started a `run-verification-sweep-sun-oct-4-*` team run (visible via my own
  server). No conflict with the app code — the smoke passes in both worlds — but see Notes:
  demo day must seed `demo` **last**.

## Done
1. **Demo path proven headlessly, twice in a row from a fresh seed** (exact commands in How to
   verify): seed `demo` → `POST /api/dev/sim` (provisions Research Team/Elliot/Sana the same way a
   real approval does) → `POST /runs/:id/splice {t:45}` → `POST /runs/:id/finalize-splice` →
   `GET /api/weave` contains a `result` item *"Results are ready: …"* whose **Open report** action
   hrefs `/reports/report-run-n-gram-fusion-on-a-135m-model-1` → `GET /api/reports/:id` returns 200
   with the recording's report (3 result rows, made by elliot/megan/jonah/sana/carlos, kind
   `illustrative`). `scripts/check-team.ts` is `seq/team`-only (not on this branch); the dev route
   + sim + splice + finalize here is the same finalize path it drives.
2. **End-to-end app read (theme, error states, leftovers; no placeholders found) with five small
   fixes**:
   - `lib/api.ts`: added **`getRegistry`** and **`listProjects`**, mirroring web's `httpApi` names
     and schemas — closes MOB-B's and MOB-C's Requests against the frozen lib.
   - `components/weave/people.ts`: the local `/api/registry` fetch workaround is gone; it calls
     `httpApi.getRegistry()` now. Cache/hook/slug-fallback unchanged.
   - `app/(tabs)/work.tsx`: fetches projects inside the same `usePoll` Promise.all (a failed
     `/projects` fetch degrades to id headers, never blocks the tab); group headers show project
     names ("Engram on small models") instead of raw `engram` — the swap MOB-C asked to make.
   - `app/report/[id].tsx`: the "Held-out perplexity" section is hidden when `report.results` is
     empty (a synthesized real-finish report has `[]`), consistent with the other sections'
     presence guards — no empty bordered table.
   - `app/(tabs)/weave.tsx`: RefreshControl spinner tint aligned to `theme.colors.run` (was
     `mutedForeground`; every other screen uses `run`).
3. **DEMO-SCRIPT.md** (allowed this step): §3 optional 4:40 phone beat — *"Phone — same results"*
   marked *(cuttable)* with the **14:00 cut rule**; §4 real-or-seeded line (item/report real,
   phone decisions local-only — "seeded" if asked); §5 checklist lines (Expo Go installed + SDK
   matches · phone on hotspot/tailnet · `EXPO_PUBLIC_API_URL` set · mirroring tested, beat run
   twice). MOBILE-PLAN §5's slide-4 line ("Push notifications for asks") is attached to the cut
   rule: only if the beat stays.
4. **docs/status/mobile-doc-edits.md**: exact drop-in text for CONCEPT §10 (companion bullet) and
   the WORK-PLAN §6 **MOBILE** row, for the owner to apply.
5. **Headless verification green** (below): `tsc --noEmit` clean · `expo export --platform ios`
   clean · `expo-doctor` 21/21 · root `npm run typecheck` exit 0 · `weave-smoke` SMOKE OK (8 items,
   all 6 kinds — re-run against both the `demo` and the `lived-in` world) · a probe through the
   app's own `httpApi`: getRegistry (9 agents) / listProjects / listTasks / listRuns /
   getReport(`report-ngram-1`) / 404→`undefined` all ✓ on the live server.

## Next
- Owner: apply `docs/status/mobile-doc-edits.md`, then the on-device pass (checklist below).
- Integrator: merge `seq/mobile-demo`; at merge time MOB-B's/MOB-C's `lib/api.ts` Requests in
  `docs/status/mobile-weave.md` / `mobile-work.md` are resolved (say so when ticking them).

## Blocked (on whom)
- Nothing code-side. The on-device pass needs the owner (Expo Go SDK 57 + a phone).

## Requests (contract / path / decision)
- None new. The two open `lib/api.ts` Requests from MOB-B/MOB-C are implemented on this branch
  (both were pre-approved one-liners in their status files; consumers swapped, no screen changes).
- Ops: whoever runs the venue dry-run — reseed `demo` immediately before the demo (the exact
  command is in How to verify); `production` is currently `lived-in` with someone else's runs.

## How to verify
Headless demo path — fresh state, deterministic ids, proven twice in a row (server reads `.env`;
run from the worktree root):
```bash
cd ~/Projects/fabric-mobile-demo
npm run seed -- --profile demo        # FRESH DEMO STATE (~20 s): truncate + demo world + ngram-135m recording
PORT=8787 npm run dev:server          # skip PORT= if :8787 is free (MOB-D used 8788; check lsof -iTCP:8787)
# 1 · the live loop (first run provisions the team, like a real approval):
curl -s -X POST localhost:8787/api/dev/sim -H 'content-type: application/json' -d '{"speed":60,"window":30}'
#    → {"taskId":"n-gram-fusion-on-a-135m-model","runId":"run-n-gram-fusion-on-a-135m-model-1"} · wait ~3 s
# 2 · Fast-forward equivalent (t=45 is what the web/check:team splice at):
curl -s -X POST localhost:8787/api/runs/run-n-gram-fusion-on-a-135m-model-1/splice -H 'content-type: application/json' -d '{"t":45}'
#    → 200, run.recording {key ngram-135m, spliceT 45}
# 3 · finalize (idempotent):
curl -s -X POST localhost:8787/api/runs/run-n-gram-fusion-on-a-135m-model-1/finalize-splice
#    → {"reportId":"report-run-n-gram-fusion-on-a-135m-model-1"}
# 4 · the beat's data (what the phone shows):
curl -s localhost:8787/api/weave | python3 -c 'import json,sys; [print(i["title"], "→", a.get("href")) for i in json.load(sys.stdin)["items"] if i["kind"]=="result" for a in i["actions"]]'
#    → Results are ready: Does an n-gram lookup table improve a much smaller open model? → /reports/report-run-…-1
curl -s -o /dev/null -w '%{http_code}\n' localhost:8787/api/reports/report-run-n-gram-fusion-on-a-135m-model-1   # 200
```
Second take: re-run from `npm run seed` (ids recreate identically). The phone beat needs no more.

Headless app checks (inside `apps/mobile`):
```bash
npx tsc --noEmit                              # clean
npx expo export --platform ios                # clean; rm -rf dist after
npx expo-doctor                               # 21/21
EXPO_PUBLIC_API_URL=http://localhost:8787 ../../node_modules/.bin/tsx scripts/weave-smoke.mts
# → SMOKE OK — 8 items, all 6 kinds
cd ../.. && npm run typecheck                 # exit 0 (mobile not in the workspaces run)
```

### On-device checklist (owner, Expo Go SDK 57) — expected result at each step
Setup once: `cp apps/mobile/.env.example apps/mobile/.env`, set `EXPO_PUBLIC_API_URL` to the
hotspot/tailnet IP, `cd apps/mobile && npm start`, open in Expo Go. Run the headless demo path
above first so the beat's data exists.
1. **App opens** → dark Weave list, Weave · Work tabs, no red screen. *If it hangs: Expo Go SDK
   mismatch (checklist §5 line) or wrong `EXPO_PUBLIC_API_URL` (⌘ → Debug shows the base).*
2. **⌘ (top-right) → Debug** → API base is the phone-reachable IP, `GET /api/runs` shows a count,
   `RunSchema.parse` reads `ok — N runs parse clean`, Elliot's portrait renders (webp proof).
3. **Weave tab** → items grouped Approval · Question · Escalation · Proposal · Finding · Result,
   names like "Jonah · Coder", unread dots on fresh items; pull-to-refresh spins blue and content
   stays. With `demo` seeded: ~8 items; the **Result** group holds *"Results are ready: …"*.
4. **Tap an approval** (`fetch-shard`) → detail with preview rows + gated note; tap **Allow once**
   → banner "✓ Allowed once"; back → the row is dimmed with the ok outcome line and **stays
   resolved** across polls and pull-to-refresh.
5. **Tap the Result item → "Open report"** → native Report screen in one tap: title, Setup rows,
   Summary, the 3-row Held-out perplexity table (`valid`/`contaminated` reads correctly), Caveats,
   Provenance, Made by faces, artifact names, "Also emailed…" — same numbers as the web's report
   card. Badge reads **Illustrative** (seeded) or **Replay of a recorded run** (fresh finalize).
6. **Work tab** → groups titled by project **name** (e.g. "Engram on small models · 1"); the 135M
   task shows Accepted + `replay` + `$x / $1.00` + `rework 1/2` + "Report ›"; the NAND probe shows
   Blocked amber with rework 2/2 and "Open on desktop"; proposals show the Waiting-for-your-yes
   line. Pull-to-refresh works.
7. **The live beat**: start `POST /api/dev/sim` on the laptop → the new task appears in Work within
   ~3 s as Running; after splice + finalize, the Weave Result item appears; tapping it opens the
   new report (`report-run-…-1`). Run the whole beat twice (DEMO-SCRIPT §5 line).
8. **Kill the server** → Weave keeps its list with an inline "Couldn't load — … Try again"
   (or the full error card if nothing had loaded); restart the server → data returns without
   losing resolved states.
9. **Deep-link 404**: open `fabric://report/xyz` (or any bogus report id) → clean "Report not
   found" state with the back button.
10. **Mirroring**: QuickTime → Movie Recording (iPhone over USB) shows the Weave tab legibly; the
    beat is performable entirely on the mirrored screen.

## Deviations
- Verified on `PORT=8788` (another worktree's server holds :8787); commands above show both.
- `scripts/check-team.ts` doesn't exist on this branch (it's `seq/team`); used the dev route's sim
  + splice + finalize-splice — the same services and the same finalize path check-team drives.
- Closed MOB-B's and MOB-C's `lib/api.ts` Requests (getRegistry, listProjects) instead of leaving
  them open — both were explicitly pre-approved one-liners in their status files, and their
  prescribed consumer swaps are in. This is beyond pure consistency fixes; flagging for review.
- Report screen: hid the results section on empty results rather than rendering an empty table.
- DEMO-SCRIPT slide-4 "Push notifications for asks" is written as conditional on the beat staying,
  rather than added to slide 4 unconditionally (MOBILE-PLAN §5 asks for it; the cut rule must be
  able to retract it).

## Notes for the next step
- The former workarounds are gone: `people.ts` is the only registry consumer (module cache),
  Work headers degrade to project ids if `/api/projects` fails. `lib/api.ts` now mirrors web's
  httpApi for every M0 endpoint + registry/projects; chat/SSE remain M1.
- `components/weave/store.ts` `resolve()` is still the local-only decision point — the M2 server
  endpoint plugs in exactly there (MOB-B's note, still true).
- Fresh demo state = the `npm run seed -- --profile demo` command above. It truncates everything,
  including other sessions' data on `production` — coordinate before running it (today another
  session's lived-in data appeared mid-verification).
- The merged screens' poll cadence is 3 s while focused; Report intentionally fetches once (MOB-C
  deviation) — don't "fix" that back to polling.
- npm-climb trap before any `npm install` in `apps/mobile` (`apps/mobile/AGENTS.md`).
