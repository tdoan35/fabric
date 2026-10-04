# MOB-B status — updated Sun Oct 4 2026, 13:25 PDT

Branch `seq/mobile-weave` (3 commits), cut from `seq/mobile` @ `25249f6` in the worktree
`../fabric-mob-b`. MOBILE-PLAN §6 step 4 (Weave list + item detail). Only `apps/mobile/**` and
this file were touched.

## Spikes
- **`usePoll` + module store interplay** — pass. `usePoll` replaces `data` every 3 s tick; the
  resolved/read state lives in a module-level store (`components/weave/store.ts`,
  `useSyncExternalStore`), so polls merge over it and never clear it. Same pattern as the web's
  `lib/weave-store.ts`.
- **Loose read-model schema strips rich fields** — noted, worked around. `WeaveSnapshotSchema`
  (read-models.ts) validates only `{id, kind, agentId, project, title, brief, at, why,
  actions[{id,label}]}`; the live payload carries full `InboxItem`s (DB rows served verbatim).
  Screens type off `@fabric/contracts` (the authoritative types, as web does); the smoke script
  asserts rich fields with its own schema (no unchecked casts).

## Done
1. **Weave list** (`app/(tabs)/weave.tsx`): `SectionList` grouped by kind — approval · question ·
   escalation · proposal · finding · result — newest first inside each group; sections hidden when
   empty. Rows (components/weave/inbox-row.tsx): unread dot (clears on open, survives polling),
   portrait (initial fallback), "Name · Role", `age(at)`, 2-line title (semibold while unread,
   dimmed when resolved), the `blocking` cost-of-delay line in warn ("Blocks Implement · Jonah,
   12 min") or the resolved `effect.outcome` in ok. Pull-to-refresh + the 3 s focus poll
   (`usePoll`), empty state ("Nothing is waiting on you…") and error state (ErrorState + retry,
   only when there is no data; errors keep the last list otherwise).
2. **Weave item** (`app/weave/[id].tsx` + components/weave/item-detail.tsx): own 3 s focus poll,
   `markRead` on open, not-found state. Header: portrait, Name · Role, kind Pill, time + ago,
   project/run chips, title; blocking banner. Bodies per kind: approval (tool, policy pill
   [allowed→ok, approval→warn, blocked→destructive], policyNote, preview rows, excerpt, `gated`
   note), escalation (body, rework-budget segments `used / total spent`, history with faces),
   question (question + context bullets), proposal (purpose, roster chips with lead status,
   "Goes to / Stays with me"), finding (source card, relevance, challenges quote), result (opens
   its report — the payload is the Report screen). Then "Why you're seeing this."
3. **Actions** from `actions[]`: options with `detail` render as tappable cards (label +
   tradeoff); plain actions as buttons (primary filled / outline / ghost, matching web variants).
   Resolving is **local only** (no server endpoint): `store.resolve` records the action and the
   item shows `effect.outcome` (+time) in a resolved banner and in the list row. An `href` that
   matches `/reports/:id` pushes `/report/:id` (MOB-C's screen); any other href renders the
   button disabled with an "Open on desktop" note (seed hits: `seed-count/chat → /`,
   `handoff-product/chat → /`, `report-135m/run → /work/ngram-135m`).
4. **Demo beat (§5)**: the finalize "Results ready" item renders in the Result group (ok tone),
   "Open report" opens `/report/report-ngram-1` in one tap. Verified by the live smoke (below).
5. **Support** (components/weave/): `group.ts` (KIND_META tones mirroring web's KIND map,
   groupByKind, hrefTarget), `format.ts` (age/ago/waited/fmtTime on the real clock — no
   WEAVE_NOW on mobile), `store.ts` (resolved/read module store), `people.ts` (see Requests),
   `face.tsx` (portrait/initial).
6. Verification: `npx tsc --noEmit` clean · `npx expo export --platform ios` clean ·
   `npx expo-doctor` 21/21 · live smoke against `:8787` (server from `../fabric-mobile`,
   seq/mobile base): `WeaveSnapshotSchema: ok`, 8 items, all 6 kinds grouped, approvals
   newest-first, every resolving action has `effect.outcome`, hrefs classified as above · root
   `npm run typecheck` exit 0 (run in `../fabric-mobile`; my branch adds nothing outside
   `apps/mobile`).

## Next
- Integrator: merge `seq/mobile-weave` onto `seq/mobile` (then `main`). MOB-C builds
  `app/report/[id].tsx` — the demo beat taps straight into it.

## Blocked (on whom)
- Nothing code-side. On-device checks need the owner (below).

## Requests (contract / path / decision)
- **lib/api.ts (MOB-A/frozen): add `getRegistry: () => request<Registry>("/registry",
  RegistrySchema)`**, mirroring web's httpApi. Workaround in place: components/weave/people.ts
  fetches `/api/registry` locally (same schema, dev-warn, module cache, slug fallback). If the
  function lands, people.ts shrinks to cache+hook over `httpApi.getRegistry`; no screen changes.
- FYI: my screens keep the whole `usePoll(getWeave)` snapshot per screen (list + detail both
  poll); no change requested — M1's SSE invalidation replaces this anyway.

## How to verify
Headless (all green on this branch; server first if needed — see note):
```bash
cd ../fabric-mob-b/apps/mobile
npx tsc --noEmit                          # clean
npx expo export --platform ios            # clean; bundle builds incl. components/weave
npx expo-doctor                           # 21/21
# live smoke (server running on :8787, MOB-A's approach: run ../fabric-mobile/apps/server):
curl -s localhost:8787/api/weave | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["items"]), "items")'   # 8 items
# parse/render smoke (all 6 kinds through the app's own grouping/href/format logic):
../../fabric-mobile/node_modules/.bin/tsx scripts/weave-smoke.mts
# → "SMOKE OK — 8 items, all 6 kinds"
```
Still needs the owner's phone (Expo Go SDK 57, `EXPO_PUBLIC_API_URL` set, `npm start`):
- Weave tab shows 8 items in 6 kind groups with unread dots; pull-to-refresh spins; kill the
  server → error card with Try again; restart → list returns without losing resolved states.
- Tap `fetch-shard` → detail with preview table + gated note; pick "Allow once" → banner
  "✓ Allowed once"; back → row shows the ok outcome line and stays resolved across polls.
- Tap the Result item ("Results are ready: n-gram fusion on a 135M model") → "Open report" →
  report screen with matching numbers; "View loop" is disabled with the Open-on-desktop note.
- "Discuss in chat" (question + proposal) renders disabled; names read "Jonah · Coder" etc.

## Deviations
- List groups **by kind** (per prompt + MOBILE-PLAN §2), not by needs-you/for-you like the web
  inbox; within a group rows sort newest-first. Unread/ask emphasis comes from the dot + weight.
- No snooze/undo/toast/pulse/presence — desktop-only in M0 scope; the store keeps only
  resolved/read state.
- Result detail intentionally renders no report summary/table (web's ResultBody fetches the
  report); reading happens on the Report screen (MOB-C). Detail scope per prompt: why + actions.
- Registry names fetched in components/weave/people.ts because lib/api.ts is frozen without
  getRegistry (see Requests). Registry failure degrades to persona slugs — the list never blocks.
- Server for curl ran from `../fabric-mobile` (seq/mobile, has .env + node_modules); my worktree
  never got a root `npm install`, per the hard rule.

## Notes for the next step
- `app/report/[id].tsx` (MOB-C) gets `reportId` via `useLocalSearchParams` from
  `/report/${target.reportId}` (hrefTarget in components/weave/group.ts is the single classifier
  — reuse it if Work needs report links too).
- components/weave/store.ts is the place a real decision endpoint (M2) plugs in: swap
  `resolve()` to POST and keep the optimistic record.
- people.ts caches for the process lifetime; if MOB-C needs names/roles, reuse `usePeople()`,
  `personLabel`, `personName` — do not refetch.
- KIND_META tones (group.ts) are the kind→Pill mapping; Work pills use MOB-A's status mapping.
- Metro resolves `@fabric/contracts` via the `file:` symlink; contracts changes need no config.
- Remember the npm-climb trap before any `npm install` in `apps/mobile` (apps/mobile/AGENTS.md).
