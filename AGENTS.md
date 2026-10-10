# Fabric web

Vite + React Router (data router) single-page app. No server rendering — the backend is a separate service (see `docs/ARCHITECTURE.md`), reached only through `src/lib/api`. Keep it that way so the same build can ship to the web and inside Electron.

- Routes: `src/router.tsx`; route components live in `src/routes/`.
- Navigation: `Link` / `useLocation` / `useSearchParams` / `useParams` from `react-router`.
- Styles: Tailwind v4 via `@tailwindcss/vite`; theme tokens in `src/styles/globals.css`.
- UI primitives: shadcn (`components.json`), in `src/components/ui/`.
- Desktop: `electron/main.mjs` wraps the same build. `npm run electron:dev` (Vite + HMR inside Electron), `npm run electron:start` (built `dist/` over the `app://` protocol), `npm run electron:dist` (installer into `release/` via electron-builder). Renderer code must not assume Electron; desktop-only APIs go through `electron/preload.cjs`, read via `desktop` from `src/lib/desktop.ts` (undefined on the web). The window is frameless (macOS keeps traffic lights); `src/components/shell/title-bar.tsx` draws the bar, and layout offsets by `--titlebar-height` (0 on the web).

---

# Software factory

The factory plan (roles, budgets, ladder) lives at `/home/ty/fabric-factory-plan.md`. Linear — team `Anyone-ai` (key `ANY`), fabric specs project — is the source of truth for WHAT. Kanban board `fabric` carries the work queue. Git + PRs carry results. Binding rules for all factory roles: never edit source files outside your harness; never put secrets in cards or prompts; verdicts are parsed, never paraphrased.

## Triage (profile `fab-triage`) — Linear → kanban sync

Triggered two ways: the `linear-factory` webhook (Linear `Issue` events on team `ANY` involving the `factory-ready` label → Hermes route on profile `fab-triage`; payload is a trigger only, never the truth) and the 15-minute `factory-linear-sync` cron, which stays as reconciliation for missed deliveries. Either way the agent re-reads Linear via MCP and compares spec hashes. Procedure:

1. List issues in team `Anyone-ai` labeled `factory-ready`, excluding Completed/Canceled.
2. For each: check the `fabric` board for a live card. Create with `--idempotency-key <LINEAR-ID>` (e.g. `ANY-42`) — the key dedupes; never create a second card for the same issue.
3. **GATE:** if the issue lacks testable acceptance criteria (commands + expected output, or observable behavior), do not invent them. Do not create a card. Comment on the issue requesting criteria and report the bounce in your run output.
4. Card: `hermes kanban --board fabric create "<ANY-N>: <title>" --body-file <snapshot> --idempotency-key <ANY-N> --workspace worktree --assignee fab-builder-a`. The body is a verbatim snapshot of the spec at sync time (description + acceptance criteria + file pointers + Linear URL). Mid-flight spec edits do NOT mutate in-flight cards — if a synced issue changed materially, flag it in your output instead. **Always assign the coder lane (`fab-builder-a`) at create time** — the dispatcher only claims Ready cards with an assignee, so an unassigned card stalls forever. Rework/fixer routing reassigns later (ladder: fab-builder-a → fab-l1 → fab-l2).
5. Dependencies: for each Linear `blocked by` relation on the issue, run `hermes kanban --board fabric link <parent-card-id> <child-card-id>` so the board's ordering mirrors Linear's. If the blocking issue has no card yet (unlabeled or not yet synced), skip it and re-check the relation on every run — create the link as soon as both cards exist.
6. Comment on the Linear issue with the card ID when synced. Only Ty closes Linear issues.
7. End every run with one line: `SYNC: created=N bounced=N skipped=N` (+ details). You never touch code and never ask questions — a missing decision is a bounce, not a clarification.

### Merge policy — auto-merge (default, since 2026-10-10)

- Terminal state after review: the **reviewer driver** (profile `fab-reviewer`, never the read-only reviewer sandbox itself) parses `VERDICT: APPROVE` and runs `gh pr merge --auto --squash <PR>`. GitHub then merges the moment all required checks (CI `verify`, `lint`) pass. No GitHub-side human approval is required.
- **Auto-merge is the default for every factory card.** No label gate anymore. Opt OUT by adding the `human-review` Linear label (triage embeds `auto-merge: no` in the card body) — then the driver stops at APPROVED and pings Ty instead.
- **Hard overrides — never auto-merged, regardless of opt-out label:**
  - diff touches protected paths (`.github/`, `AGENTS.md`, `docs/adr/`)
  - diff > ~1k changed lines (plan §9 size guard)
  - any required check red, or the verdict is not exactly `APPROVE`
  - diff strays outside the file scope declared on the card
- On triggering auto-merge, the driver comments the PR link on the Linear issue. Merges are squash merges; the driver deletes the branch.
- **Post-merge lifecycle (automated, no-agent `factory_merge_watch.py` cron every 5m):** when a factory PR merges, its Linear issue is set to Done (comment with the merged PR link), and the **next eligible sibling** in the same epic is flagged `factory-ready` — eligible = open, not yet flagged, and not blocked by any open issue; ordered by priority then issue number. At most one open sibling carries `factory-ready` at a time. Ty keeps final authority: remove the flag or edit the spec before triage syncs it.
- Ty's oversight: weekly deep-read of merged PRs (plan §0 v2.2 mitigations) and the hard overrides above stay in force.
