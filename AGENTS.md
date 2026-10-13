# Fabric

TypeScript monorepo on npm workspaces. What we're building is in `docs/`; start with `docs/ARCHITECTURE.md`. The code is still the hackathon build, and `docs/ARCHITECTURE.md` §12 maps what each part becomes.

| Path | What | Instructions |
|---|---|---|
| `apps/web` | Vite + React Router SPA, also wrapped by Electron | `apps/web/AGENTS.md` |
| `apps/server` | HTTP API (Hono) | — |
| `apps/mobile` | Expo companion app, outside the workspaces with its own lockfile | `apps/mobile/AGENTS.md` |
| `packages/*` | `agents`, `contracts`, `db`, `fixtures`, `integrations` | — |

A directory's `AGENTS.md` applies to everything under it, on top of this file. Read it before changing files there.

From the repo root:
- `npm run dev` starts the server and the web dev server together.
- The PR gate (CI `verify`): `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, `npm run build-storybook -w web`, `npx playwright install --with-deps chromium` (once per machine), `npm run test-storybook -w web`. `npm run lint` runs as its own CI job. Storybook details: `docs/STORYBOOK.md`.

---

# Software factory

The factory plan (roles, budgets, ladder) lives at `/home/ty/fabric-factory-plan.md`. Linear — team `Anyone-ai` (key `ANY`), fabric specs project — is the source of truth for WHAT. Kanban board `fabric` carries the work queue. Git + PRs carry results. Binding rules for all factory roles: never edit source files outside your harness; never put secrets in cards or prompts; verdicts are parsed, never paraphrased.

## Triage (profile `fab-triage`) — Linear → kanban sync

Triggered two ways: the `linear-factory` webhook (Linear `Issue` events on team `ANY` involving the `factory-ready` label → Hermes route on profile `fab-triage`; payload is a trigger only, never the truth) and the 2-minute `factory-linear-sync` cron, which stays as reconciliation for missed deliveries (a cheap Linear probe gates it, so the agent runs only when the set of `factory-ready` issues changes). Either way the agent re-reads Linear via MCP and compares spec hashes. Procedure:

1. List issues in team `Anyone-ai` labeled `factory-ready`, excluding Completed/Canceled.
2. For each: check the `fabric` board for a live card. Create with `--idempotency-key <LINEAR-ID>` (e.g. `ANY-42`) — the key dedupes; never create a second card for the same issue.
3. **GATE:** if the issue lacks testable acceptance criteria (commands + expected output, or observable behavior), do not invent them. Do not create a card. Comment on the issue requesting criteria and report the bounce in your run output.
4. Card: `hermes kanban --board fabric create "<ANY-N>: <title>" --body-file <snapshot> --idempotency-key <ANY-N> --workspace worktree --assignee fab-builder-a`. The body is a verbatim snapshot of the spec at sync time (description + acceptance criteria + file pointers + Linear URL). Mid-flight spec edits do NOT mutate in-flight cards — if a synced issue changed materially, flag it in your output instead. **Always assign the coder lane (`fab-builder-a`) at create time** — the dispatcher only claims Ready cards with an assignee, so an unassigned card stalls forever. Rework/fixer routing reassigns later (ladder: fab-builder-a → fab-l1 → fab-l2).
   Then create the **review card** (same run, always — this makes skipping review impossible: the card sits in todo until the coder card completes, however the coder finishes): `hermes kanban --board fabric create "REVIEW <ANY-N>: <title>" --parent <coder-card-id> --assignee fab-reviewer --workspace worktree --idempotency-key <ANY-N>-review`. Body first line: `REVIEW_OF: <coder-card-id>`, then the review contract: read-only (no tracked-file edits, no push, no requesting review on this card); get the diff from the coder card's completion metadata (commit/branch/lane_checkout) or the PR on the public repo; verify the diff stays inside the declared file scope, touches no protected paths (`.github/`, `docs/adr/`, any `AGENTS.md` or `CLAUDE.md` at any depth); re-run the acceptance gates from a clean `npm ci` — never trust the implementer's claims; every story/test assertion must be able to fail (no tautologies); on a card marked `TDD: required`, also apply the test-first checks below and reject a PR that fails any of them; GitHub CI (`verify`, `lint`) green on the PR head is environment proof — double-check local failures before calling them blocking. Completion contract (parsed by scripts, never paraphrased): summary MUST start with exactly `VERDICT: APPROVE` or `VERDICT: REJECT`, and completion metadata MUST include `{"verdict": "<same VERDICT line>", "reviewed_sha": "<full PR head sha>"}` and MUST NOT set `commit`/`branch` keys (review cards are never published). APPROVE enables auto-merge; REJECT routes to the rework ladder. If the coder card already exists from an earlier sync (idempotency hit) and has no review child, create the review card then. **Never create a review card for kickback-ladder rework cards** — rework uses the same-card review loop (`request-review`/`request-changes`) on the rework card itself.
5. Dependencies: for each Linear `blocked by` relation on the issue, run `hermes kanban --board fabric link <parent-card-id> <child-card-id>` so the board's ordering mirrors Linear's. If the blocking issue has no card yet (unlabeled or not yet synced), skip it and re-check the relation on every run — create the link as soon as both cards exist.
6. Comment on the Linear issue with the card ID when synced. Only Ty closes Linear issues.
7. End every run with one line: `SYNC: created=N bounced=N skipped=N` (+ details). You never touch code and never ask questions — a missing decision is a bounce, not a clarification.

### Test-first cards (`TDD: required`)

A card whose spec says `TDD: required` lists its test cases with IDs (e.g. `R3.4`). Builders and reviewers both follow these rules:

- **Red commit first.** The PR's first commit adds the listed tests (plus test fixtures, and any test infrastructure the card names) and nothing else. At that commit the package's tests fail, and each listed case fails on an assertion or a missing export/module, never on a syntax error in the test file. Typecheck may fail at that commit.
- **Every listed case exists**, with its ID at the start of the test name. Adding cases is welcome. Dropping, merging or weakening a listed case is a REJECT.
- **Green at head** with the normal gates.
- **Reviewer:** check out the PR's first commit and confirm the red state case by case, then confirm green at head. Read the PR's commits on GitHub, not the squash. A single-commit PR is a REJECT. Where the card asks for a mutation score (`npm run mutate -w <pkg>`), run it and put the score in the verdict.
- A card may replace the red commit with an explicit "prove it can fail" rule (e.g. disabling a recovery mechanism must make the test fail); follow the card.

### Merge policy — auto-merge (default, since 2026-10-10)

- Terminal state after review: guardian seam **S4** (a no-agent script, never the read-only reviewer sandbox) runs `gh pr merge --auto --squash` once the PR head has a parsed `VERDICT: APPROVE` for that exact sha and the required checks (CI `verify`, `lint`) are green. S4 runs every 2 minutes in its own fast-lane cron as well as in the full guardian tick. No GitHub-side human approval is required.
- **Auto-merge is the default for every factory card.** No label gate anymore. Opt OUT by adding the `human-review` Linear label (triage embeds `auto-merge: no` in the card body) — then S4 holds the PR at APPROVED and logs it for Ty instead.
- **Hard overrides — never auto-merged, regardless of opt-out label:**
  - diff touches protected paths (`.github/`, `docs/adr/`, any `AGENTS.md` or `CLAUDE.md` at any depth)
  - any required check red, or the verdict is not exactly `APPROVE`
  - diff strays outside the file scope declared on the card

  (The ~1k changed-lines size guard was lifted by Ty on 2026-10-11: PR size no longer blocks auto-merge; the reviewer's full-diff APPROVE is the size gate.)
- Merges are squash merges, and the branch is deleted on merge.
- **Post-merge lifecycle (automated, no-agent `factory_merge_watch.py` cron every 2m):** when a factory PR merges, its Linear issue is set to Done (comment with the merged PR link), and in every **track** of its epic that has no open flagged child, the **next eligible sibling** is flagged `factory-ready` — eligible = open, not yet flagged, and not blocked by any open issue (in this epic or any other); ordered by priority then issue number. The merge also flags any issue in **another** epic that it was the last open blocker of, if that issue's track has no open flagged child. Ty keeps final authority: remove the flag or edit the spec before triage syncs it.
- **Tracks and concurrency.** A track is a `track:<name>` label on an epic's children; children without one share the default track. At most one open child per track carries `factory-ready`, so an epic with no track labels still runs as one chain. Spec writers put children on separate tracks only when their file scopes are disjoint, and express any cross-track ordering as `blocked by` relations. The board runs up to 4 cards at once (`kanban.max_in_progress`), at most 2 per profile; the model server keeps one stream free for Ty's own Hermes traffic.
- **Working alongside the factory (Ty's own PRs).** Ty may merge his own PRs to `main` at any time; the factory adapts. Before merging, run `python3 ~/.hermes/scripts/factory_overlap.py <PR>` — it compares the PR's files with every in-flight card's `File scope:` and every open `factory/*` PR. `CLEAR` = merge freely. `OVERLAP` = merging is still allowed but costs the factory PR a re-review or a conflict pass; alternatively wait for that card to land first. `main` is strict-protected, so every merge leaves open factory PRs BEHIND; guardian seam **S9** (10m) merges `main` into them via update-branch (merge, never rebase — the reviewed commit stays an ancestor):
  - incoming `main` files disjoint from the PR's files and no shared config (`.github/`, `.storybook/`, `package*.json`, tsconfig/vite/vitest/eslint config) → the review verdict carries forward to the new head (recorded in `~/.hermes/factory/branch-sync.json`); auto-merge proceeds once CI is green on it.
  - overlap or shared config → auto-merge is disabled before the update and a `REVIEW … (post-sync)` card is created for the new head.
  - conflict (`mergeable_state=dirty`) → a conflict-rework card on the current rung, **not charged to the rework budget** (max 2 free passes per branch, then blocked + notify). Red CI after a clean sync is still a normal, charged kickback.
  - S9 never syncs a branch while a rework/fixer card on it is in flight; fixers fetch the PR head from GitHub rather than trusting a stale lane copy.
- Ty's oversight: weekly deep-read of merged PRs (plan §0 v2.2 mitigations) and the hard overrides above stay in force.
