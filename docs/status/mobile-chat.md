# MOB-E status — updated Sun Oct 4 2026, 14:15 PDT

Branch `seq/mobile-chat` (3 commits), cut from **`seq/mobile-demo` @ 9c59afc** (MOB-D's tip), in the
worktree `../fabric-mob-e` — the root checkout is still the integrator's dirty `seq/team` tree.
Scope: MOBILE-PLAN §2 **M1** — SSE invalidation + the chat screen. Only `apps/mobile/**` and this
file were touched.

## Spikes
- **Where to cut from** — `seq/mobile` still sits at MOB-A (25249f6); the integrated A–D line lives
  on `seq/mobile-demo` (the merge of weave + work plus MOB-D). Cut there; cutting from literal
  `seq/mobile` would have dropped the Weave/Work/Report screens. Flag for the integrator.
- **expo/fetch under node** — fail (by design): `expo/fetch` ships TS source only (`src/winter/…`,
  Metro transpiles; `node_modules/expo/fetch.js` requires it and dies). So `lib/chat.ts` and
  `lib/stream.ts` take the fetch implementation as an argument — the app passes `expo/fetch`
  (imported statically in `app/chat.tsx`, which also installs the winter `TextDecoder` global),
  and `scripts/chat-smoke.mts` passes node's fetch through the exact same generators.
- **zod resolution in a lockfile-less worktree** — fail, then pass. With no root `node_modules`
  (hard rule: no root install), `packages/contracts` resolves `zod` by climbing out of the repo and
  finds a stray `~/node_modules/zod@3.25.76` (mobile pins 4.6.5) → cross-major type errors in
  contracts + `lib/api.ts`. Fix, local to this worktree and gitignored:
  `packages/contracts/node_modules/zod → ../../../apps/mobile/node_modules/zod`. Without it Metro
  would also have bundled both zod majors. Anyone re-creating this worktree needs the same symlink.
- **SSE frame format** — read from hono's `writeSSE` (dist/helper/streaming/sse.js):
  `event: <name>\ndata: <json>\n\n`, heartbeat `event: ping` every 15 s, `hello` on connect.
  `lib/stream.ts` parses both `\n\n` and `\r\n\r\n` terminators (hono writes `\n` only).
- **Which events a chat turn emits** — chat turns publish `registry.changed` (session creation +
  turn end, `packages/agents/src/assistant/index.ts`); `session.message` is finalize-only (the
  results message). So the chat screen refreshes on `session.message` for `c1` **or**
  `registry.changed` (desktop approvals stamp `{decision}` into the same history).

## Done
1. **`lib/stream.ts`** — SSE client for `GET /api/stream`: pure frame parser (`takeSseFrames`) +
   `createAppStream(fetchImpl, baseUrl)` connection manager (refcounted: first subscriber connects,
   last unsubscribes; exponential backoff 1 s→15 s capped, reset on any frame; 45 s heartbeat
   watchdog races `reader.read()`; `reconnect()` for foregrounding). `AppEventSchema` validates
   every `app` frame (dev-warn on mismatch, mirroring web `routes/root.tsx`); `ping`/`hello` only
   prove liveness. Hooks: `useAppEvents(filter, cb)` (refs, so callers pass fresh closures) and
   `useStreamStatus()`. The app-wide singleton lazy-imports `expo/fetch` + `AppState` (reconnect
   when foregrounded) so the module stays node-loadable for the smoke.
2. **`usePoll(fn, intervalMs?, matches?)`** — optional third arg: refetch on matching AppEvents,
   only while focused; the 3 s poll stays as the fallback. Weave passes `weave.changed`; Work
   passes `task.changed || run.changed`. Existing callers are unchanged (additive parameter).
3. **`lib/chat.ts`** — mirrors web `http.ts` `chatStream` + `http-assistant.ts` `toWire`:
   `ChatRequestSchema.parse` before the POST, NDJSON read via `TextDecoder` streaming mode, dev
   `ChatStreamLineSchema` warnings, the web's exact error copy. `DEMO_SESSION_ID = "c1"` (see
   Notes). Signature deviation: `chatStream(fetchImpl, body, signal?)` — fetch injected (spike 2).
4. **Chat screen** (`app/chat.tsx` + `components/chat/parts.tsx`): history via
   `httpApi.getSessionMessages("c1")`; send appends the user message optimistically, streams, and
   **replaces** the in-progress assistant message on every line (cumulative snapshots); after the
   turn it reloads history (the stored thread is authoritative — real ids, desktop decisions).
   Live refresh on `session.message`/`registry.changed` while idle; abort on unmount; composer with
   keyboard avoidance + auto-scroll. Parts: text as text, `record_disposition` as the chip (web's
   `DISPOSITION_LABEL` mirror + reason), `propose_team`/`propose_specialist`/`handoff_to_team` as
   READ-ONLY cards — "Approve on desktop" when pending, Approved/Declined/Discussing pill when the
   desktop decided; `post_results` renders a results card whose "Open report ›" pushes MOB-C's
   Report screen; unknown tools degrade to a mono chip. Entry: **✉ button** in both tab headers
   (`app/(tabs)/_layout.tsx`), stack route `chat` titled "Dana".
5. **Debug screen** gained an "App stream" card: `live`/`connecting`/`reconnecting` (+ retry count)
   and the last AppEvent with its time — the on-device SSE check.
6. **Verification** (below): `tsc --noEmit` clean · `expo export --platform ios` clean (3.2 MB hbc) ·
   `expo-doctor` 21/21 · root `npm run typecheck` exit 0 · chat-smoke SMOKE OK (31 cumulative
   lines, turn shape, SSE events) · reconnect probe PROBE OK (drop → backoff growth → recovery).

## Next
- Integrator: review + merge `seq/mobile-chat` onto the mobile line (seq/mobile-demo's successor);
  note the cut-point deviation above. M1 is now feature-complete per MOBILE-PLAN §2; what remains
  there is on-device confirmation (below) and the owner's demo call.

## Blocked (on whom)
- Nothing code-side. On-device checks need the owner (Expo Go SDK 57 + a phone).

## Requests (contract / path / decision)
- None to contracts or the server — M1 needed no changes anywhere outside `apps/mobile` (as the
  plan predicted). The `lib/use-poll.ts` edit (additive optional param) is technically outside the
  "stream.ts / chat.ts / api.ts" allowlist but is required by the task itself ("make use-poll
  refetch on matching events"); noted in Deviations.
- FYI for whoever re-creates a mobile worktree: the zod symlink from Spikes (or any root-level
  `node_modules`) is required before `tsc`/Metro resolve contracts' zod consistently.

## How to verify
Headless (all green on `seq/mobile-chat` @ 423a91a; server commands parameterized — the root
checkout holds :8787 with its own server, so use 8788):
```bash
cd ~/Projects/fabric-mob-e/apps/mobile
npx tsc --noEmit                              # clean (typed routes include /chat)
npx expo export --platform ios                # clean; rm -rf dist afterwards
npx expo-doctor                               # 21/21
# server matching this branch's contracts (../fabric-mobile-demo has node_modules + .env):
cd ~/Projects/fabric-mobile-demo/apps/server && PORT=8788 ../../node_modules/.bin/tsx src/index.ts
cd ~/Projects/fabric-mob-e/apps/mobile
EXPO_PUBLIC_API_URL=http://localhost:8788 ../../fabric-mobile-demo/node_modules/.bin/tsx scripts/chat-smoke.mts
# → history c1 ok · 31 lines, part counts 2 → … → 3 · record_disposition(resolved) + text +
#   propose_team(pending) · card "Research Team — Elliot·Research Lead, …" · stream live ·
#   2 registry.changed events · SMOKE OK   (~55 s; writes one scratch session to the DB —
#   `m1-smoke-*`; the pre-demo reseed truncates it)
cd ~/Projects/fabric-mobile-demo && npm run typecheck    # exit 0 (workspaces; mobile not among them)
```
Reconnect behaviour was probed headlessly (throwaway script, since deleted): with the stream live,
killing the server → `reconnecting` with attempts 1→5 (1 s, 2 s, 4 s… backoff), restarting it →
`live` with attempts reset. TCP noticed the kill in ~10 s; a silently-dead socket is caught by the
45 s watchdog.

**expo/fetch streaming was NOT checked on a device — it is reasoned about only** (SDK 57 source
reading: `FetchResponse.body` is a WHATWG `ReadableStream`; winter installs `TextDecoder`). The
node smoke shares the parsing/manager logic but not expo/fetch itself.

Still needs the owner's phone (Expo Go SDK 57, `EXPO_PUBLIC_API_URL` set, `npm start`):
1. ⌘ → Debug: **App stream reads `live`**, Last event shows e.g. `weave.changed` with a time;
   kill the server → `reconnecting` (retry counter grows), restart → back to `live`.
2. Weave tab: with a desktop handoff/finalize running, the new item appears **immediately** (not on
   the 3 s poll); Work tab likewise on task/run changes.
3. ✉ → Chat: `c1` history from the desktop (or empty), send a message → Dana types in place
   (text grows, never duplicates), the turn ends on the propose card with "Approve on desktop".
4. Approve that card **on the desktop** → the phone's card flips to "Approved · Decided on
   desktop" without a reload; the handoff card appears; Work shows the new task.
5. Keyboard: composer stays above the keyboard; long threads auto-scroll; leaving mid-turn
   cancels cleanly (no ghost "typing…").

## Deviations
- Branch cut from `seq/mobile-demo` (MOB-D tip), not `seq/mobile` (still at MOB-A) — see Spikes.
- `lib/use-poll.ts` edited (additive optional `matches` param) though the allowlist named only
  stream.ts/chat.ts/api.ts; the task's own SSE-invalidation requirement needs it. `lib/api.ts`
  needed no change (MOB-A had already added `getSessionMessages`).
- Chat entry is a header button (✉), not a third tab — MOBILE-PLAN §3 lists `app/chat.tsx` as a
  pushed stack screen; the prompt allowed either. The tab bar keeps two tabs as in M0.
- `chatStream`'s first parameter is the fetch implementation (web: none) — the price of running
  the same generator headlessly; the screen always passes `expo/fetch`.
- The chat screen refreshes on `registry.changed` as well as `session.message` (web's useLiveResults
  listens to session.message only): desktop approvals only surface in history, and turns publish
  registry.changed, so this is what makes cross-device decisions visible. Skipped while busy.
- `post_results` renders a read-only card with an "Open report ›" link into the existing Report
  screen (not named in the prompt; it's the CHAT-14 results message the thread receives, and the
  screen already existed — small, cut it if unwanted).
- Smoke ran a **fixture** turn (`fixture: true`) — the server's `.env` has `LLM_PROVIDER=neon`
  (venue credits), and the fixture path exercises the same route, NDJSON contract and persistence
  without spending any. No live-LLM turn was run from this branch.
- Worktree-local, gitignored: `packages/contracts/node_modules/zod` symlink (Spikes). No root
  install was run; the root lockfile is untouched.

## Notes for the next step
- **Session choice, written down: `c1`.** The web mints `t-*` ids per thread
  (`apps/web/src/lib/chat/session.ts`) and the seed writes no chat rows, so the only session id
  the demo path uses end to end is `c1` — `scripts/check-chat.ts` turns + history read
  `/api/sessions/c1/messages`, and the handoff task points back at it. Any id works (the server
  creates the row on the first turn); `c1` keeps phone and desktop on one thread. Change it in one
  place: `DEMO_SESSION_ID` in `lib/chat.ts`.
- M2 hooks that are already in place: `components/weave/store.ts` `resolve()` for the decision
  endpoint; `components/chat/parts.tsx` `ProposalCard` is where an Approve/Decline button would go
  (it already renders the decided state from `result.decision`); the wire format for a decision is
  `{decision}` as the tool-call part's `result` on the next request (assistant/thread.ts).
- `useAppEvents` delivers only while the shared singleton has subscribers; screens that want
  always-on invalidation (a future push-notification layer) must hold a subscription themselves.
- The app-wide singleton never stops while a status listener is attached — the debug screen keeps
  the stream alive while open, which is exactly its job.
- Backoff caps at 15 s; a suspended phone also gets an immediate `reconnect()` on foreground via
  AppState (no-op while live). If the venue network drops idle connections faster than 15 s,
  the poll still covers every screen.

---

## Post-merge fix — f41abf1 (merged to main), from the owner's first Expo Go run

**Red-screen on launch in Expo Go:** `TypeError: Cannot read property 'default' of undefined` →
`PushNotificationIOS … native module that doesn't exist`. Cause: `lib/stream.ts`'s singleton used a
**dynamic `import("react-native")`** for `AppState`; Metro compiles dynamic imports to an async
require that runs `metroImportAll`, which eagerly evaluates every export getter of
react-native's index.js — including `PushNotificationIOS`, whose getter constructs a
`NativeEventEmitter` on a native module Expo Go doesn't ship. Any screen mounting `useAppEvents`
(both tabs, immediately) crashed. Fix:

- `lib/stream.ts` is now **pure** (no react/react-native/expo imports): parser + `createAppStream`
  only — still exactly what `scripts/chat-smoke.mts` drives under node.
- New `lib/app-stream.ts` holds the React layer (`appStream()` singleton, `useAppEvents`,
  `useStreamStatus`) with **static named imports** (`AppState` from react-native, `fetch` from
  expo/fetch) — named static imports only touch their own getters, never the whole namespace.
  The singleton is synchronous now (no async subscribe race). Importers repointed: `lib/use-poll.ts`,
  `app/chat.tsx`, `app/debug.tsx`.
- Drive-by: `app/+not-found.tsx` linked to `"/"`, which the dev-server-generated typed routes
  (`.expo/types`, regenerated by the owner's `npm start`) don't include — now links `/weave`
  (the initial screen). This is why `tsc` can newly fail after running Metro in this worktree.

Re-verified after the fix: `tsc --noEmit` clean · `expo export --platform ios` clean ·
`expo-doctor` 21/21 · chat-smoke SMOKE OK against a fresh 8788 server. Rule for M2: **no dynamic
`import()` of react-native or `react-native-*` packages in this app** — static named imports only.
