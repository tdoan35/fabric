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
