# UI-CHAT status — updated Sun Oct 4, ~10:19 PDT (branch `seq/ui-chat`)

Step 5 of §7.0: UI-CHAT 1–6 plus the brief's decisions 1–7. 12 commits on `seq/ui-chat` (11 plus this
status file); nothing merged or pushed. Gates: typecheck · test (server 18 / agents 54 / db 21) ·
`build -w web` · `check:data` (55.5 s) · `check:chat` fixture (98.3 s) all green. Lint shows only the
existing `use-mobile.ts` error and the same 19 warnings as `main`.

## Spikes
- **S4 (with DANA): pass, no swap.** The NDJSON cumulative-snapshot stream (§4.3) plugs straight into
  assistant-ui's `useLocalRuntime`: each line becomes one yielded `{content}`, which replaces the
  message. The human-tool flow (`unstable_humanToolNames`, `addResult` + `startRun`) works unchanged
  against the server's thread diff. No AI SDK UI stream needed.

## Done
- **1. `httpAssistant`** (`lib/chat/http-assistant.ts`): a `ChatModelAdapter` that POSTs
  `{sessionId, messages, fixture?}` through `httpApi.chat` (`lib/api/http.ts`, dev-checked against
  the new `ChatStreamLineSchema`). It passes the abort signal, and each line replaces the content.
  After a decision the next run re-sends the thread with `{decision}` on the card's part.
  `VITE_API_MODE` picks it or `mockAssistant`. Direct and team chats with anyone but Dana keep the
  mock placeholder (see Deviations).
- **2. One source for the card data**: the enriched scripted payloads (proposalId, roster
  personas/roles/portraits, workflow, reworkBudget, criteria, leadDefaults, the Sana persona, and the
  handoff with taskId and Name · Role members) live in `@fabric/fixtures/chat`.
  - The server's `assistant/fixture.ts` builds its cards from those choices through `teamCard` /
    `specialistCard`.
  - `teams.ts` takes `LEAD_DEFAULTS` and the rework row from the same file.
  - `cards.test` pins that the server's cards on the demo seed **equal** the scripted payloads.
  - The web mock streams them as-is, so offline mode shows the live demo's cards.
- **3. Cards** (`components/chat/cards.tsx`); every optional field renders nothing when it's missing.
  - CARD-1: the team card shows purpose, Name · Role roster chips with portraits, a workflow strip
    (gate marked), done-when criteria, the rework budget and "Elliot's defaults · new lead".
  - NAME-1/2: the specialist card shows Sana's portrait and "Sana · Validator", with "Yes, create
    Sana". The handoff card shows members with portraits, roles and states.
  - CARD-3: an approved specialist shows the registry's `inbox` when there is one. None exists yet,
    so nothing shows.
  - CARD-4: a superseded card collapses to one line, "replaced by a revised proposal · See revision ↓",
    which scrolls to the re-proposal.
  - CARD-6: badges read Declined / Discussing, and a note says nothing was created.
  - The handoff's "View loop" goes to `/work/<taskId>?live=1`. On a live turn the card shows
    "Handing off…" until the payload lands, never `/runs/undefined`.
- **4. Results message (CHAT-14)**: `ResultsCard` renders `post_results` with the title, summary,
  valid rows, Open report (`/reports/<id>`) and View loop (`/work/<taskId>`). It arrives live:
  `root.tsx` hands `session.message` to the open thread (`lib/chat/events.ts`), which refetches
  `GET /api/sessions/:id/messages` and appends that message. It's restored from history on reload.
- **5. Thread identity (IA-5)**:
  - `/?session=<id>` names each thread, so reloads and title-bar tabs restore it.
  - A bare `/` (New thread, a new tab, Back to Dana) mints a fresh session, even when you're already
    on `/`.
  - The thread mounts once its history is loaded, and the runtime starts from it (`initialMessages`).
  - Sidebar rows open `/?session=<id>`.
- **6. Fixture hotkey (RUN-12)**: **Ctrl+Shift+F** arms scripted Dana for the next turn
  (`fixture: true`), shown as a dashed "Scripted next turn" pill in the composer. Pressing it again
  or clicking the pill disarms it; the next turn consumes it. Http mode only.
- **7. `VITE_DEMO=1` (D7)**: hides group chat, Full auto (composer and Settings), the
  voice-conversation button and the 1M context meter (tray, composer and session panel). "Runs on"
  is locked to the Sprite sandbox in the tray, the session panel and Settings.
- **Found while verifying, and fixed:**
  - A thread minted in the page stayed "known empty", so coming back to it skipped the history
    fetch.
  - The handoff card linked `/runs/undefined` during a live turn.
  - New threads sorted to the bottom of the sidebar.
  - The thread's sidebar row read "0 messages".
  - Background tabs fell back to "New thread".
  - The open thread's row said "n new replies".
  - A dead server showed "Failed to fetch".

### Verification (each step screenshotted, `/tmp/fabric-ui-chat/shots/`)
- **Mock mode** (`mock-flow.mjs`, PASS): handle directly → idea → enriched team card → Sana card →
  handoff → View loop on `/work/ngram-135m?live=1` (the recorded live start). `mock-0…5`.
- **Http, scripted Dana, fresh demo seed** (`http-flow.mjs http`, PASS, no console errors):
  1. Idea → team card (Elliot's portrait, CARD-1) → approve → Sana's card → approve → handoff.
     `http-1…3`
  2. Without a reload: the Research Team in Studio → Teams, and the task on the Engram board.
     `http-4`, `http-5`
  3. The sidebar thread → View loop → Live → Fast-forward → bounce → Play ×2 → finalized (`http-6…8`).
     A second page, open on the thread the whole time, got the results message without a reload
     (`http-9`). Back in the chat in the first page, it's there too (`http-10`).
  4. A reload restores the whole thread: both cards Approved, the handoff and the results.
     `http-11`, `http-12`
  5. `branches.mjs` (PASS): team declined, discussing, superseded with "See revision", the
     re-proposal approved, specialist declined, and the reload keeps all of it. `branch-1…6`
- **Http, live Dana on Spark** (`http-flow.mjs live --live`, PASS, the same asserts, task title from
  the API). `live-1…12`. Times are click → disposition chip → card visible, in the browser:

  | turn | chip | card |
  |---|---|---|
  | idea → team card | 4.4 s | 9.4 s |
  | approve team → specialist card | 8.4 s | 8.8 s |
  | approve specialist → handoff | 9.6 s | 17.4 s |

  Scripted, for scale: 1.6 / 2.6 s · 2.2 / 3.2 s · 2.0 / 4.4 s. The first live attempt failed my
  assert on `/runs/undefined` (fixed above); the second failed on the scripted task title (script
  fixed); the third passed.
- **Hotkey** against the live server (`hotkey.mjs`, PASS): arm, disarm, re-arm. The next turn is
  the fixture's exact line and card in 2.6 s, then the pill clears. `hotkey-1`, `hotkey-2`
- **Electron** (`VITE_API_MODE=http npm run electron:dev -w web -- --remote-debugging-port=9341`;
  `electron-flow.mjs`, PASS, Electron 44.5.1): the same beats through finalize, results back in the
  chat, and a reload. `electron-1…5`. Title-bar tabs (`electron-tabs2.mjs`, PASS): a new tab is a fresh
  session, both tabs are labelled by their threads, and each restores its own. `electron-6…8`
- **`VITE_DEMO=1`** (`demo-gate.mjs`, PASS): group chat, voice and the meter are gone, Full auto is
  absent in both pickers, and Runs on is Sprite (locked) in the tray, the panel and Settings.
  `demo-1…4`
- **Edges** (`edge.mjs`): a direct chat with Jonah gives the placeholder (`edge-direct-chat`). The
  server dying mid-session shows "Can't reach the server…" under the message (`edge-server-down`).

## Next
- TOOLS (step 6): `createInbox` and the inbox on the approved card (see Notes).

## Blocked (on whom)
- None.

## Requests (contract / path / decision)
- **`contracts:` 36a4d7c**: zod schemas `ChatPartSchema`, `ChatStreamLineSchema`,
  `ThreadMessageSchema` and `SessionMessagesSchema`. Additive, pinned to the existing interfaces
  with `satisfies`, and used by the web's dev checks.
- **Path notes (§7.0 allows these; please review):**
  - `packages/fixtures/src/chat.ts`: the enriched payloads (FND/shared).
  - DANA's `packages/agents/src/assistant/`:
    - `fixture.ts` and `teams.ts` build from the shared payloads.
    - `store.ts`: a new thread gets `ord = min − 1`, so it sorts first.
    - `index.ts`: `registry.changed` after each turn, one line.
    - `__tests__/cards.test.ts`: two tests.
  - UI-WORK's files:
    - `lib/api/http.ts`: `chat`, `getSessionMessages`, the unreachable-server message.
    - `routes/home.tsx`: session in the URL, the history gate.
    - `routes/root.tsx`: `session.message` → the open thread, plus a registry refresh.
    - `components/shell/app-shell.tsx`: session links; the open thread reads as read.
    - `components/shell/tabs.tsx`: background tabs labelled by their session.

## How to verify
```bash
git checkout seq/ui-chat && npm i
npm run typecheck && npm test && npm run build -w web && npm run lint   # lint: only use-mobile.ts
npm run check:data && npm run check:chat                                # both reseed demo
# http mode, scripted Dana (server.sh never prints the connection string):
npm run seed -- --profile demo --branch demo
/tmp/fabric-ui-chat/server.sh fixture        # DATABASE_URL from `neon connection-string … --branch demo --pooled`
VITE_API_MODE=http npm run dev -w web        # :3000
/opt/google/chrome/chrome --headless=new --remote-debugging-port=9340 --user-data-dir=/tmp/fabric-ui-chat/chrome-$(date +%s) about:blank &
cd /tmp/fabric-ui-chat
node http-flow.mjs http                      # reseed before each run
node branches.mjs branch                     # reseed first
VITE_PORT=3002 VITE_API_MODE=mock npm run dev -w web            # another terminal; then:
node mock-flow.mjs                                               # mock mode
VITE_PORT=3002 VITE_API_MODE=mock VITE_DEMO=1 npm run dev -w web # restart it as the demo build; then:
node demo-gate.mjs
# live: restart with `server.sh live`, reseed, then
node http-flow.mjs live --live && node hotkey.mjs   # reseed between them
# Electron: stop the :3000 web first (CORS allows :3000 and app://fabric only)
VITE_API_MODE=http npm run electron:dev -w web -- --remote-debugging-port=9341
node electron-flow.mjs                        # then open a second tab via the + and run electron-tabs2.mjs
npm run seed -- --profile demo --branch demo  # leave demo clean
```
By hand: open `/`, send the idea, Build team, Yes create Sana, View loop, Fast-forward (pause twice)
and come back through the sidebar thread. Results are there; reload keeps everything. Ctrl+Shift+F
before a turn forces scripted Dana.

## Deviations
- **Non-Dana chats keep the mock placeholder in http mode.** Phase 1 has no server for direct chats
  (Jonah, Megan, Carlos) or team-lead chats (Product Team → Diego). They aren't stored, so a reload
  or tab switch loses them.
- **Seeded thread rows have no stored messages.** Opening one (`/?session=s3` and so on) shows an
  empty thread. Typing in it would store the turn under that seeded id.
- **IA-5 applies in mock mode too**, with one code path. The gap says "Fix mock": New thread resets
  on `/` in both modes. Mock threads get a `?session=` id but have nothing to restore, and sidebar
  rows there now open an empty thread rather than leaving the current one on screen.
- **"Yes, create Sana"**, not "Yes, create Validator": D1 names the persona on the card.
  DEMO-SCRIPT §3 1:55 still says Validator (OPS).
- **The results card's "View loop"** goes to `/work/<taskId>` (the loop has finished), without `?live=1`.
- **The rework budget shows once**, in the team section, using the server's "Rework budget" row and
  its why. The lead's defaults list Tools / Memory / Model.
- **The team card's workflow shows Sana** in Prepare and Validate, with her pool portrait, although
  she isn't on the roster yet. The server's definition includes her, and she joins on her own card.
  Approved cards stay expanded, as in the mockup.
- **D7 "voice"** hides the voice-conversation button only; dictation (the mic) works and stays. When
  the composer is empty there, it shows the disabled send button. CHAT-9's "show base context
  separately" isn't done: the meter is just hidden, per the brief.
- **The hotkey is Ctrl+Shift+F** on every platform (not ⌘ on macOS). It's a page-wide flag, http mode
  only.
- **Live append edge**: the results message is appended at the thread's tail even if a turn is
  running at that moment (not exercised).
- **Server touches beyond the brief** (see Requests): new threads sort first and `registry.changed`
  fires per turn. Without them, the thread you come back to after the loop sat at the bottom of the
  sidebar and read "0 messages".

## Notes for the next step
- **TOOLS / CARD-3**: the card shows `registry.agents[].inbox` for the approved persona, but nothing
  serves it yet. `agents` has no inbox column and `read.ts` doesn't map `StudioProfile.inbox`. When
  `createInbox` lands, store the address (DATA's column), map it in the registry read and emit
  `registry.changed`; the card picks it up with no UI change.
- **Card data has one source**: change the scripted cards in `@fabric/fixtures/chat`. `cards.test`
  fails if the server's `teamCard`/`specialistCard` drift from them on the demo seed.
- **Session ids** are `t-<base36 time>-<4 chars>`, minted by the web. The server creates the row on
  the first POST and sorts it first. `/?session=` is the only thread state in the URL.
- **TEAM (step 7)**: the handoff card already handles a slow result (pending state). A real live loop
  changes nothing in the chat. The results message still comes from finalize →
  `postResultsMessage` → `session.message`.
- **Headless checks**: `/tmp/fabric-ui-chat/cdp.mjs` closes every page at the start of each script
  (`closeAll`), because stale tabs' SSE streams hit the 6-connections-per-host cap. It writes
  `shots/timeout.png` on any timeout. For Electron, pass `attach: true` and don't `closeAll`, since
  that would close the app window.
