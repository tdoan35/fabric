# Fabric — Mobile Companion Plan

| | |
|---|---|
| Status | Draft v0.1, Sun Oct 4 2026 |
| Owner | Ty Thanh Doan |
| Workstream | **MOB**: branch `seq/mobile`. Owns `apps/mobile/` and `docs/status/mobile.md` |
| Horizon | **Today:** M0 (and M1 if there's time), demoable through Expo Go. **Phase 2:** M2 (dev build, push notifications, auth, real decisions) |
| Still binding | `CONCEPT.md` §2 · WORK-PLAN §0 rule 5 ("don't break mock mode") · `DEMO-SCRIPT.md` §3 beats |

## TL;DR

- The phone is a **companion**, not a port. It's where **asks and results reach you away from the desk**: Weave, a quick look at Work, and reports. Studio, Orgs, loop lanes and the inspector stay on desktop.
- **Expo Go + expo-router**, running against the current server. **M0 needs no server changes.**
- `apps/mobile` stays **out of the npm workspaces** today, so Expo's pinned React can't disturb web or Electron on demo day.
- It reuses `@fabric/contracts` (whose only dependency is zod) and the same zod schemas as `apps/web/src/lib/api/http.ts`.
- **The biggest risk is the venue network, not the code.** Use a laptop hotspot or the tailnet.
- Optional demo beat at 4:40 ("Results"): the real "results ready" Weave item on the phone, which opens the report. **Cut it if M0 isn't solid by 14:00.**

---

## 1. Why, and what's in and out

CONCEPT §8.1 says the product is calm by default: the organization sits one tap behind the conversation. In the demo, Dana says *"I'll ping you here and by email when there are results."* The phone is the natural "here" when you're away from the desk.

CONCEPT §10 lists "Mobile-first" as a non-goal. This plan doesn't challenge that: desktop stays primary. The proposed amendment is in §8.

| In (companion) | Out (desktop only) |
|---|---|
| Weave inbox: asks, results, findings | Agent Studio (definitions, workspace files) |
| Work: tasks and runs at a glance (status, cost, rework) | Organizations / org chart |
| Report reading | Loop lanes over time, replay, Fast-forward |
| Chat with Dana (M1) | Context inspector |
| Push notifications for asks (M2) | Creating or editing a team or agent outside chat |

---

## 2. Screens by tier

### M0: must-have today (~2–3 h)

The app is a tab bar (expo-router `(tabs)`) with **Weave · Work** tabs and a pushed **Report** screen.

| Screen | Data | Shows | Interactions |
|---|---|---|---|
| **Weave** (list) | `GET /api/weave` → `WeaveSnapshotSchema` | Items grouped by kind (approval · question · escalation · proposal · finding · result), with an unread dot, the agent persona, the one-line `title`, the `blocking` cost-of-delay line, and `at` | Pull to refresh. Tap an item to open its detail |
| **Weave item** | the same snapshot | `why`, `preview` rows (approval), `budget.used/total` (escalation), the action buttons from `actions[]` | Actions resolve **locally only**, the same as web today (there's no server decision endpoint yet). An `href` action that points at a report opens the Report screen; other `href`s show "Open on desktop" |
| **Work** | `GET /api/tasks`, `GET /api/runs` | Tasks grouped by project, each with its latest run: status pill (running / blocked / accepted / stopped), `costUsd` / `budget.costUsd`, rework used / `reworkBudget`, `etaS` | Pull to refresh. Tap an accepted run to open its report (`reportId`) |
| **Report** | `GET /api/reports/:id` → `ReportSchema` | Title, intro, summary, results table (config · ppl · delta · valid), caveats, provenance, made by, "Also emailed" | Read only |

**Freshness:** a `usePoll(fn, 3000)` hook that runs while the screen is focused (`useFocusEffect`), plus pull-to-refresh. SSE comes in M1.

### M1: stretch for today, optional in the demo

- **Chat with Dana:** a minimal thread screen.
  - Sending: `POST /api/chat` with `ChatRequestSchema` (`{sessionId, messages}`).
  - Receiving: NDJSON is read with **`expo/fetch`** (streaming response body). Each line is a cumulative `ChatStreamLine` snapshot, so replace the message on every line.
  - Rendering: text parts as text. A `record_disposition` tool-call as a chip. `propose_*` / `handoff_to_team` as **read-only cards** with "Open on desktop".
  - History: `GET /api/sessions/:id/messages`.
  - **Why approvals aren't in M1:** `messages` is "the thread as the web runtime holds it" (assistant-ui's format, including human tool results `{decision}`). Rebuilding that on RN is real work, so approving from the phone is M2.
- **Live invalidation:** subscribe to `GET /api/stream` (SSE of `AppEvent`: `weave.changed`, `run.changed`, `task.changed`, …), parse `event:`/`data:` lines from a streaming `expo/fetch` body, and refetch the affected screen. Fall back to polling if the stream drops.

### M2: Phase 2 (after Oct 4)

- **Dev build (EAS) instead of Expo Go.** Expo Go can't receive remote push notifications, so the app moves to an `expo-dev-client` build at this point.
- **Push:** `expo-notifications`, with an additive server route `POST /api/push-tokens` and table `push_tokens(token, platform, created_at)`. A sender (Expo Push API) triggers on new Weave asks and `run.blocked`, following CONCEPT §8.3.5 "urgency without anxiety": approvals, escalations and results only, never progress.
- **Real decisions:** `POST /api/weave/items/:id/decision`, shared with the web. This depends on WORK-PLAN §6 **WEAVE** retiring the `DECISIONS` map.
- **Approve proposals from the phone:** an RN thread runtime that holds the same message shape as the web, or a server-side decision endpoint for human tools.
- **Reachability and auth:** server deployed to Fly plus single-user auth (WORK-PLAN §6 **DESKTOP**). Until then the phone only works on the same network or the tailnet.
- Join the npm workspaces once React versions are aligned.

---

## 3. Architecture

```text
apps/mobile (Expo Go, expo-router, TS)
  app/(tabs)/weave.tsx, work.tsx     app/weave/[id].tsx   app/report/[id].tsx   (M1: app/chat.tsx)
  lib/api.ts      ── mirrors httpApi in apps/web/src/lib/api/http.ts, validates with @fabric/contracts
  lib/use-poll.ts ── focus-aware polling        lib/theme.ts ── tokens copied from web globals.css
        │  fetch (expo/fetch for streaming)
        ▼
apps/server :8787  ── /api/weave · /api/tasks · /api/runs · /api/reports/:id · (M1) /api/chat · /api/stream
```

- **Packaging:** `apps/mobile` has its **own `package.json` and lockfile** and isn't listed in the root `workspaces`. Expo SDKs pin specific React and React Native versions, while web pins `react@19.2.8`, and hoisting both into one root `node_modules` today risks breaking web or Electron.
- **Contracts reuse:** `"@fabric/contracts": "file:../../packages/contracts"` (or a Metro `watchFolders` entry for `packages/contracts`). Its only dependency is zod, and its `exports` point at `src/index.ts`, which Metro transpiles. Check the `domain.ts` imports for anything web-only before relying on them.
- **API client:** one function per endpoint with the same names as `httpApi` (`getWeave`, `listTasks`, `listRuns`, `getReport`, `getSessionMessages`, `chatStream`). The base URL is `EXPO_PUBLIC_API_URL` (e.g. `http://192.168.x.x:8787`). Every response is validated with zod, the same as web, so contract drift shows up loudly.
- **Offline mode (optional):** `EXPO_PUBLIC_API_MODE=mock` serves `@fabric/fixtures` data, mirroring web's L0. Only do this if `packages/fixtures` imports cleanly in RN (no `node:` modules). Otherwise skip it; the web stays the L0 fallback.
- **Styling:** RN `StyleSheet` plus a `theme.ts` with the color tokens and radius from `apps/web/src/styles/globals.css`, dark first. Persona portraits come from the same assets as web, if they're plain images. No NativeWind or aurora effects today.
- **No server changes in M0.** Native fetch isn't subject to CORS, so `corsOrigins` in `apps/server/src/env.ts` doesn't matter to the phone.

---

## 4. Network at the venue (the riskiest part)

The phone has to reach the laptop's server on :8787. `serve()` in `apps/server/src/index.ts` doesn't set a hostname, so it listens on every interface.

| Option | Setup | Notes |
|---|---|---|
| **1. Laptop hotspot** (preferred) | Phone joins the Mac's hotspot (Internet Sharing); `EXPO_PUBLIC_API_URL=http://<hotspot IP>:8787` | Avoids venue Wi-Fi client isolation. Test it at home first |
| **2. Tailnet** | Phone on Tailscale (already used for Spark); use the laptop's `100.x` IP | Works across any network. The phone needs the Tailscale app logged in |
| **3. Tunnel to :8787** | cloudflared or ngrok → `https://….trycloudflare.com` | Public URL with no auth: shut it down after the demo |

- `expo start --tunnel` only tunnels **Metro**, not the API.
- Metro itself also needs the phone to reach the laptop (LAN or `--tunnel`).
- Install the Expo Go version that matches the project's SDK **the night before**. Expo Go only supports recent SDKs, and a mismatch blocks the app from loading.
- macOS firewall: allow incoming connections for `node`.

---

## 5. Demo fit

**Optional beat, 4:40–5:00 (Results).** On the laptop, the report card shows up. Then:

- **On screen:** the phone (mirrored with QuickTime → Movie Recording → iPhone over USB, or `scrcpy` for Android) shows the Weave tab with a new **"Results ready"** item from finalize. Tap it to open the native Report screen with the same numbers.
- **Say:** *"Same results, in my pocket. Dana pings me wherever I am, and the full trail stays on the desktop."*
- **Real or seeded:** real. The result item comes from finalize, and the report comes from the DB.
- **Cut rule:** if M0 plus the network check aren't green by **14:00**, drop the beat. Nothing else in the script depends on it.
- Add one line to slide 4 ("What's next"): *"Push notifications for asks."*

---

## 6. Build steps (sequential-mode handoff)

Each step ends with a **How to verify** check, written up in `docs/status/mobile.md` using the WORK-PLAN §7.6 template.

1. **Scaffold:** `npx create-expo-app@latest apps/mobile --template tabs`, then remove it from any workspace globs it touches.
   *Verify:* `npm run typecheck && npm run build` at the root still pass. The web runs in mock mode unchanged.
2. **Contracts:** add the `file:` dependency and a Metro config if needed. Import `RunSchema` in a screen.
   *Verify:* the app loads in Expo Go and `RunSchema.parse` runs.
3. **API client + `usePoll`:** add `lib/api.ts` and `lib/use-poll.ts`.
   *Verify:* a debug screen shows the `GET /api/runs` count from the phone over the chosen network (§4).
4. **Weave list and item detail.**
   *Verify:* items match `/weave` on web, and local resolve shows the `effect.outcome` label.
5. **Work tab.**
   *Verify:* start a handoff on desktop; the new task appears on the phone within 3 s with `running`.
6. **Report screen.**
   *Verify:* after Fast-forward and finalize, the result item opens the report and the numbers match web.
7. **Demo dry-run** on the venue setup (hotspot plus mirroring).
   *Verify:* the §5 beat runs twice in a row without errors.
8. **(M1) Chat, then SSE**, only if 1–7 are green with time to spare.

---

## 7. Risks and open questions

| Risk | Mitigation |
|---|---|
| React or RN version drift breaks the web | Separate lockfile, not a workspace (§3). Step 1 checks this |
| Venue Wi-Fi isolates clients | Hotspot or tailnet (§4), tested beforehand |
| Expo Go SDK mismatch | Use the SDK that current Expo Go ships. Install Expo Go the night before |
| `contracts` imports something RN can't resolve | Step 2 finds it early. Fall back to copying the few types needed |
| `expo/fetch` streaming quirks (M1) | M1 is optional. Polling covers live updates |
| Weave decisions on the phone aren't real | Same as web today. Say "seeded" if asked (DEMO-SCRIPT §4) |
| Tunnel exposes an unauthenticated server | Prefer the hotspot or tailnet. Kill the tunnel right after the demo |

**Open questions**
- Is there an iOS or Android device for the demo? This decides how the screen is mirrored.
- Do persona portraits ship as plain PNGs that RN can `require`, or as something web-only?
- Phase 2: should push go through Expo Push or straight to APNs/FCM? Expo Push is the default; revisit if self-hosting matters.

---

## 8. Proposed edits to other docs (for the owner to apply)

- **CONCEPT §10, non-goals:** keep "Mobile-first", and add *"A mobile **companion** (asks, status, results) is in scope; creation and inspection stay desktop."*
- **WORK-PLAN §6 table:** add a new row:

  | **MOBILE**: Companion app | Dev build (EAS), push notifications for asks / blocked runs / results, decisions from the phone, approving proposals from the phone, workspace merge | CONCEPT §8.3.5 | WEAVE, DESKTOP |

- **DEMO-SCRIPT §3:** the optional 4:40 phone beat in §5, marked cuttable.
- **DEMO-SCRIPT §5 checklist:** add "Expo Go installed and SDK matches · phone on hotspot or tailnet · mirroring tested".
