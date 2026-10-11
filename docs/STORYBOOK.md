# Storybook (apps/web)

Storybook is the catalog of every user-observable state of the web app's components. It
mounts **production components only** — no story-local copies — against the seeded mock
world, with browser interaction tests and an accessibility gate. This document explains
how to run it, how the harness works, how to add and maintain stories, and where the
catalog's limits are.

## Commands

All Storybook commands run from the repo root unless noted. Node ≥ 20 (CI uses 22).

| Command | What it does |
| --- | --- |
| `npm ci` | Clean install (required before anything below). |
| `npm run build-storybook -w web` | Build the static catalog to `apps/web/storybook-static/` (gitignored). |
| `npm run storybook -w web` | Serve the workbench on `localhost:6006` for browsing. |
| `npm run test-storybook -w web` | Run every story's play function headless (Vitest project `storybook`, Chromium). |
| `npm run typecheck` / `npm test` / `npm run lint` / `npm run build` | The rest of the gate set; see below. |

The full acceptance gate for any change: `npm ci`, `npm run typecheck`, `npm test`,
`npm run lint`, `npm run build`, `npm run build-storybook -w web`,
`npm run test-storybook -w web`. `npm run lint` must run with `apps/web/storybook-static`
**absent** — the generated `sb-manager` chunks otherwise produce ~13 spurious
rule-not-found errors (pre-existing quirk; move the directory aside, lint, then rebuild).

## How the harness works (M1, ANY-8)

Everything lives in `apps/web/.storybook/`:

- **`preview.tsx`** — global setup. The `theme` toolbar global toggles the app's `.dark`
  class on `<html>`; there is exactly one theme implementation, and stories assert dark
  variants through `globals: { theme: "dark" }` (see `ui-tokens--surfaces-dark`,
  `schedule-schedule-screen--fixture-week-dark`, `work-report-screen--recorded-report-dark`).
  The a11y addon runs at `test: "error"` — browser story tests **fail** on accessibility
  violations. Do not downgrade globally; fix the story or scope a documented exception
  (see below).
- **`guard.ts`** — the mock-only network guard. On first harness use it replaces
  `window.fetch` / `EventSource` with sentinels that record the attempt and throw
  `NetworkGuardError`. Stories never touch a backend: any network reach is a loud
  failure, and `networkAttempts()` lets a play assert *no* call happened. A storybook
  session with `VITE_API_MODE=http` is a configuration mistake and errors at install.
- **`harness.tsx`** — `WithHarness`, an **opt-in** decorator (import it into a story
  file's `decorators`; it is deliberately not in `preview.tsx` so no story accidentally
  mounts the production root loader). Per mount it resets and reseeds every store from
  `@/testing/seed` (`resetAndSeedStores`), installs the network guard, and — when the
  story declares `parameters: { router: { routes, initialEntries? } } }` — renders the
  story inside a memory `RouterProvider`. Plays navigate via `storyRouter()`.

### Fixtures and data

- Domain data comes from `@fabric/fixtures` (typed). Component stories pass fixture
  arrays straight to the component's props — the same shapes the route loaders produce.
- Screen/route stories mount the **real route element + real loader** (`TaskPage` +
  `taskLoader`, `WorkPage` + `workLoader`, `ReportPage` + `reportLoader`,
  `SchedulePage` + `scheduleLoader`, chat via the real `ChatScreen`) inside the harness
  router; loaders resolve against the mock api under the network guard.
- Stores are the seeded singletons (`@/testing/seed`). For a state the standard seed
  cannot express, seed **additively at render time** (e.g. a `useState(() =>
  setRegistry(...))` stage after the harness reset) — never edit `seed.ts` or fixtures
  for one story.
- Time-sensitive UI pins the clock: route stories use `?week=`/date params, component
  stories take a `today`/props seam, sims are paused and scrubbed via marker buttons.
  Assertions on rendered times stay timezone-tolerant (state words/counts, not literal
  clock text) because times render in the viewer's zone by design.

### Chat specifics

Chat stories run inside the real assistant-ui runtime with the scripted mock adapter.
Tool-call parts are built to the same shape `session.ts`'s `toRuntimePart` produces;
decision plays emit on the tool-call part and assert the card reacts and
`networkAttempts()` stays empty. Note: the runtime derives tool-part status from the
assistant message status, so status stories set `ThreadMessageLike.status`.

## Writing and maintaining stories

- Story files are **co-located** with the component: `src/components/<area>/<thing>.stories.tsx`.
- Each file's header comment carries its **state → story inventory** (including explicit
  exclusions with reasons). Keep it accurate when you touch the component; the catalog
  reconciliation in M8 checked every inventory against the built `index.json`.
- Every play assertion must be able to fail. Prefer asserting observable DOM
  (roles, names, text, hrefs) over implementation details.
- Accessibility: with `test: "error"` the cheapest path is to fix the component (several
  M-cards landed one-line a11y fixes that way). If a violation is a genuine token-level
  exception (e.g. muted-foreground contrast), scope `parameters.a11y` to that story only,
  disable only the offending rule, and document the measured pair in a comment.
- Viewports: composed screens ship narrow **and** wide variants where layout changes
  (`shell-appshell--composed-shell-narrow/-wide`, `weave-screen--narrow-rail-sheet`,
  `schedule-schedule-screen--composed-narrow`, work screens, …). Assert behavior, not
  pixels — there are **no visual snapshots** by design.
- After adding/changing stories run the full gate list above; `npm run test-storybook
  -w web` is the arbiter. Two long-known local-load flakes rotate under parallel runs
  (see Limits) — a failure is real only if it reproduces in isolation.

## Coverage map (M8 reconciliation, 2026-10-11)

214 stories across 47 files; the built `index.json` matches the per-area catalogs
exactly. Primary areas and their composed-screen / theme / viewport coverage:

| Area | Composed screen stories | Dark | Narrow/wide |
| --- | --- | --- | --- |
| Shell + settings | `shell-appshell--composed-shell-*`, settings dialog stories | token-level + theme toggle play | composed narrow **and** wide (860×800 / 1600×1000) |
| Chat | `Chat/Thread` (+ heroes, composer, tool cards, browser cards) | via theme global; token dark asserted in `ui-tokens` | single-column fluid layout; shell-level narrow/wide |
| Weave | `weave-screen--*` | token-level | `wide-three-column` / `narrow-rail-sheet` explicit |
| Work (boards, task/loop, report) | `Work/Screen`, `Work/Task screen`, `Work/Report screen` | `recorded-report-dark` explicit | viewport variants on board/task/loop screens |
| Schedule | `Schedule/Schedule screen` | `fixture-week-dark` explicit | `composed-narrow` explicit; wide is the default route |
| Agent/team studio | `Studio/Screen`, `Studio/Teams view` | via theme global | two-pane layout covered by shell variants |

Dark is one implementation (the `.dark` token flip) — asserted with luminance/behavior
checks on representative screens and manually viewable for every story via the toolbar.

## Limits — what the catalog is *not*

- **No integration/E2E tests.** Stories exercise components and routes against the mock
  world only; the network guard *prevents* real backend calls. Server/contract suites
  live in their packages (`npm test`).
- **No Electron/desktop coverage.** Stories run as plain web pages. Title-bar behaviors
  that need `window.fabricDesktop` (menus, zoom, window controls) are inventoried in
  `title-bar.stories.tsx` as not-executable-here; the web render is asserted instead.
- **No visual snapshots, no hosted storybook.** The static build is a local artifact
  (`storybook-static/`, gitignored); nothing packages it — the SPA `dist/` and the
  electron-builder `files` list (`dist/**`, `electron/**`) contain no Storybook output.
- **Known local-load flakes** (green in isolation; CI is the arbiter): the weave
  narrow-rail-sheet tooltip/Escape race, and portal-exit timings in dialog-heavy suites
  (pinned at 3 s where observed). A full-suite failure that vanishes in isolation is
  this class, not a regression.
- **Clock/late-flake classes** are documented per-card in git history (M3–M7); the
  long-lived ones are the two above.
