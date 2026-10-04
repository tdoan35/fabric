# Fabric — Demo-day runbook (Oct 4)

The beat sheet stays in `DEMO-SCRIPT.md` §3. This file is what to run, what changed since the script
was written, and what to do when something breaks. Plan of record: `WORK-PLAN.md`.

## 1. Commands

| When | Command | What it does |
|---|---|---|
| Before every rehearsal and the demo | `npm run demo:reset` | Stops the demo server (and any team run still in flight), reseeds the `demo` branch to the pre-approval world |
| Then | `npm run demo:server` | The server on :8787 against `demo`. Reads `LLM_PROVIDER`, `DANA_MODE`, `FEATURE_AGENTMAIL` from `.env` (or the shell) |
| Then | `npm run demo:electron` | Builds and opens the app in Electron over `app://fabric`, http mode, demo build (D7) |
| Browser fallback | `npm run demo:web` | Same app on http://localhost:3000 |
| Offline fallback (L0) | `npm run demo:offline` | Electron, mock mode: no server, no network. The scripted chat and the recorded loop |
| Check the whole path | `npm run smoke` | Fixture Dana → two approvals → handoff → real live start (≥3 members by 45 s) → splice → finalize → report + Dana's results message. ~2 min. Starts its own server; reseeds before and after |

**One run at a time.** The Spark lane takes 8 requests; one research run holds 4. A rehearsal left
running keeps working in the background and slows the next one, so always `demo:reset` between runs.
Never run `smoke` or `check:*` while rehearsing.

## 2. At the venue (9:00–10:30)

- [ ] **Model provider.** Pick one and put it in `.env`, then restart `demo:server`:
  - `LLM_PROVIDER=spark` if the tailnet reaches the Spark lane from the venue (`curl -s "$SPARK_BASE_URL/models"` returns the model).
  - `LLM_PROVIDER=neon` if Neon's AI Gateway credits are on: fill `NEON_AI_GATEWAY_BASE_URL` / `_TOKEN`, check `GET /v1/models`, and update the three ids in `packages/agents/src/llm/index.ts` (`providerModelId`, `neon` case) and `NEON_PRICES` to the catalog's.
  - `LLM_PROVIDER=openrouter` as the backup. Raise the key's $5 cap first.
- [ ] **AgentMail for the demo.** `FEATURE_AGENTMAIL=on` creates Sana's inbox on approval and emails the report at finalize (to `OWNER_EMAIL`). Send one test email first, with the owner's OK. Leave it off for rehearsals if the 100/day budget matters.
- [ ] **Warm the Sprites.** They sleep when idle (first exec ~2.7 s cold). `npm run smoke` once warms both, and proves the path.
- [ ] `npm run smoke` passes. Then `npm run demo:reset`.
- [ ] Rehearse in Electron: `demo:reset` → `demo:server` → `demo:electron`.

## 3. Changed since DEMO-SCRIPT §3 was written

| Beat | Now |
|---|---|
| 1:35 Propose team | The card shows Elliot · Research Lead (new, with portrait), Megan, Jonah, Carlos; purpose, workflow, rework budget, criteria and Elliot's defaults (CARD-1). It's exactly what approval creates |
| 1:55 Propose specialist | The card names **Sana · Validator**; the button reads **"Yes, create Sana"**. With `FEATURE_AGENTMAIL=on` the approved card shows her real inbox (CARD-3) |
| 2:15 Handoff | Scripted Dana answers in ~5 s. **Live Dana: the handoff card takes ~18 s on Spark** (her text appears at ~6 s). Talk over it, or arm scripted Dana for that turn with **Ctrl+Shift+F** |
| 2:30 Live start | Real: four lanes start within ~2 s; Jonah's Sprite terminal by ~7 s; Megan's Exa lines by ~11 s. Badge `Live · now` |
| 3:15 Inspector | Context tab shows real section text. Dana's context reads **~0.4k tokens** (her measured base context), not 2,140. Tools tab: allowed / approval / blocked |
| 3:50 Fast-forward | Click at ~45 s. `Replay · 600×` in ~1 s. It pauses on Carlos's verdict: press **Play**; it pauses again on Accepted: press **Play** |
| 4:40 Results | Built (CHAT-14): back in the chat, Dana's "I got the results here" card arrives on its own, with **Open report** and **View loop**. The report carries an **Illustrative** label (D9) and a Setup section |
| 5:15 Org view | Built (ORG-1): the dashed Research → Product edge with its question and **Preview — not built** |
| 6:00 Close | Don't name **Mastra** (we call the AI SDK directly) or **Executor** (S6 failed; policies are our tool layer plus the Sprite's egress list, i.e. "behavioral scoping"). Name the Neon AI Gateway only if it served the demo |

## 4. When something breaks

| Symptom | Do this |
|---|---|
| Live Dana is slow or wrong on a turn | Ctrl+Shift+F, then resend: scripted Dana for that turn, same real side effects. Or start the server with `DANA_MODE=fixture` |
| The live start shows nothing after ~20 s | Fast-forward right away. The splice works with no live events (L1): the loop continues from the recording |
| Spark unreachable | `LLM_PROVIDER=openrouter` (or `neon`), restart `demo:server` |
| Server down, or no network | `npm run demo:offline` (L0): the same beats on the scripted chat and the recorded loop |
| Electron misbehaves | `npm run demo:web` and present from the browser (D12) |
| Everything | The fallback video |

## 5. Say this if asked

- The live start is real: real model calls, Exa searches, commands in two Fly Sprites, context snapshots. The splice joins it to a **recorded** run of the same task, labelled **Illustrative** (D9).
- The overlap trap in the recording is staged (D10): the corpus is set up so a naive first attempt is contaminated, and the validator's catch is real within that setup.
- The inspector shows the model that actually ran (e.g. `spark:qwen3.8-flash-next`), not the persona's intended model.
- Tool policies: blocked and approval-only tools are refused by our tool layer; the Sprites' network egress is enforced by Fly (only the package index and the model host).

## 6. Rehearsal timing (fill in)

| Run | Chat beats (0:45–2:30) | Live start + inspector | FF → results | Total | Notes |
|---|---|---|---|---|---|
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |
