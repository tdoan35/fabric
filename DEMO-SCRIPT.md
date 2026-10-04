# Fabric — Demo Script & Deck

| | |
|---|---|
| Status | Draft v0.2 — beats checked against the coded mockup (Oct 1) |
| Target length | ~6:30 (core must stand alone in 5:00 in case the slot is short) |
| Marker legend | 🟢 live · 🔁 replay (recorded real run) · 🖼 slide · ⚠️ the mockup can't play this as written yet (IDs → `MOCKUP-GAPS.md`) |

---

## 1. Storyline in one breath

I have research ideas faster than I can test them. Personal agents today become super-agents: everything piles onto one profile. Fabric keeps the assistant small and hands work to specialists and teams that I approve, watch, and inspect. Watch me hand off a real research idea.

## 2. Deck (4 slides + 1 architecture, ~90 s total)

| # | Slide | Content |
|---|---|---|
| 1 | **The super-agent problem** | One profile, skills + tools + memory + soul growing → context bloat, worse reasoning, higher cost. One line: *"Every new capability makes my assistant bigger."* |
| 2 | **Fabric** | *"One assistant. A fabric of specialists."* Manage capabilities, don't accumulate them. Three verbs: **route · delegate · inspect**. |
| — | *(live demo)* | |
| 3 | **How it's built** | Architecture diagram with sponsor logos on the real parts: Neon (Postgres + AI Gateway), Mastra (agents/workflows), Assistant UI (cards), Sprites (sandbox), Exa (search), AgentMail (inboxes), Executor (tools) [+ Kernel if built]. |
| 4 | **What's next** | Teams handing off to teams; scoped memory; routing evals; single-agent baseline comparison. |

## 3. Beat sheet

| Time | Beat | On screen | Say | Mode |
|---|---|---|---|---|
| 0:00–0:45 | Problem + thesis | Slides 1–2 | "My assistant should manage capabilities, not accumulate them." | 🖼 |
| 0:45–1:10 | **Handle directly** | New session with Dana. Click the first suggestion chip, "What's an n-gram, in one line?" (hover the row first: the chips rotate every 6 s). Chip `handle directly`; Dana answers in one line | "Delegation-first isn't delegation-always. Every turn gets a recorded routing decision." | 🟢 |
| 1:10–1:35 | The idea | Paste the experiment idea and send it. The chips disappear after the first message, so keep the idea on the clipboard | "Real idea I want to test: graft an n-gram/Engram lookup table onto a small open model — tables can live on NAND instead of RAM." | 🟢 |
| 1:35–1:55 | **Propose team** | Chip `propose team`. Card: *Research Team · proposed team*, with Research Lead · new, Investigator · existing, Coder · existing, Reviewer · existing, and **Build team / No / Chat about this** | "It won't silently create anything. It reuses my existing agents and proposes what's missing." Click **Build team**. | 🟢 |
| 1:55–2:15 | **Propose specialist** | Chip `propose specialist`. Card: *Validator · New specialist*, with Tools / Memory / Restriction / Lifecycle rows, each with a why. ⚠️ The card doesn't show the new inbox yet [CARD-3] | "Every default has a one-line justification. Minimal, not a clone of me." Click **Yes, create Validator**. Mention: it gets its own inbox (AgentMail). | 🟢 |
| 2:15–2:30 | **Handoff** | Chip `delegate team`. Dana: "Got it, the team is formed and your experiment is handed off. I'll ping you here and by email when there are results." Handoff card with four members working → **View loop** | "My assistant's context stays small; the team gets a brief, not my transcript." | 🟢 |
| 2:30–3:15 | **Loop view (live start)** | `Live` badge; the step bar shows Plan and Prepare in progress; lanes zoomed to the first minute: Elliot · Research Lead (Plan), Megan · Investigator (Survey, with Exa lines), Jonah · Coder (Setup, with the Sprite terminal), Sana · Validator (Prep checks); Carlos · Reviewer idle. The right panel shows the Brief: what the team got, what stayed with Dana, and 0 of 4 criteria met | "Parallel by design: research, environment setup, and independent validation prep overlap." | 🟢 |
| 3:15–3:50 | **Inspector** | Click Jonah's row → **Context** tab: sections with token counts (click one to see its text), "Dana: 2,140 tokens", and "Not loaded: your chat transcript · personal memory · other specialists' skills". Then the **Tools** tab: allowed / approval / blocked. "← Brief" goes back | "This is the actual context this run loaded, not the config. Assistant: ~N tokens. Coder: M. Nothing hidden." | 🟢 |
| 3:50–4:00 | **Fast-forward** | Click **Fast-forward** (or press `R`); badge `Replay · 600×`. Playback pauses on Carlos's verdict ~15 s later | "Real research takes hours. I'll fast-forward through a recorded run of this same task." | 🔁 |
| 4:00–4:40 | **Bounce + rework** | The step bar's Review turns amber and the way back reads "Sent back to Elliot · rework 1/2"; under it, Carlos's verdict ("Changes requested → back to Elliot"); the criterion "Held-out split never seen by the n-gram table" shows ✗. Press play: an amber arrow runs from Carlos's "Bounced" to Elliot's "Re-plan", then Jonah's dashed "Rework", Sana's "Re-check", and a pause on "Accepted" | "The Reviewer caught a problem and the team fixed it — autonomously, inside a bounded rework budget. If the budget runs out, it escalates to me." | 🔁 |
| 4:40–5:15 | **Results** | Dana: "I got the results here: [artifact]" → report card; email arrives (AgentMail). ⚠️ Today only the Run view's "Results are ready · Open report" card exists; Dana's chat message isn't built [CHAT-14]. The report shows the summary, held-out perplexity (valid / contaminated), caveats, provenance and "Also emailed to you via AgentMail" | "Outcome, evidence, artifacts — not the internal chatter." | 🔁 + 🟢 email |
| *(opt) inside 4:40–5:15* | **Phone — same results** *(cuttable)* | Phone mirrored on screen (QuickTime → Movie Recording over USB, or `scrcpy`): the **Weave** tab shows the finalize "Results ready" item; tap it → the native Report screen with the same numbers. Fresh state: seed `demo`, then sim → splice → finalize (commands in `docs/status/mobile.md`) | *"Same results, in my pocket. Dana pings me wherever I am, and the full trail stays on the desktop."* | 🟢 phone |
| 5:15–6:00 | **Org view (vision)** | Sidebar **Teams** → **Organizations**: Dana at the head; Research Team (led by Elliot) and Product Team (led by Diego, idle); Jonah under both, tagged `shared`; a dashed edge reading *"Can these results drive a real, value-driven product?"*, with a `Preview` label. ⚠️ The edge and label aren't built [ORG-1] — build them, or cut this beat to the closing sentence | "Teams can hand off to teams. This part isn't built yet — it's where this goes." | 🖼/🟢 static |
| 6:00–6:30 | Close | Slide 3 (architecture), then slide 4 | "Built on Neon, Mastra, Sprites, Exa, Assistant UI, AgentMail, Executor. Pre-built foundation, wired and polished today." | 🖼 |

**Cut rule (phone beat):** if M0 plus the network check aren't green by **14:00**, drop the phone beat — nothing else in the script depends on it (MOBILE-PLAN §5). Slide 4 gains the line *"Push notifications for asks"* only if the beat stays.

### If the slot is 5 minutes
Cut the org view to the closing sentence, skip the direct-answer beat (chip shown inside the first request), shorten the inspector to one click.

## 4. What's genuinely real (say this if asked)

- Assistant routing, proposals, team/agent creation, handoff: **live**.
- Run start (Exa, Sprite, parallel steps): **live**.
- Everything after the fast-forward: **replay of a recorded real run** of this task — same events, same artifacts, produced by this team before the event. Badge in UI.
- Org view team-to-team handoff: **not built**; labelled Preview.
- Until the backend lands, rehearsals run on the mockup's mock data. Its `Live` badge is simulated (the recording played at 1×), so never present the mockup as live [RUN-3].
- The phone beat is real: the Weave item comes from finalize and the report from the DB. But deciding a Weave item on the phone is **local-only** (no server decision endpoint yet), the same as the web today — say "seeded" if asked.

## 5. Pre-demo checklist

**Night before**
- [ ] Expo Go installed on the demo phone and its **SDK matches the project** (SDK 57) — a mismatch blocks the app from loading (MOBILE-PLAN §4)
- [ ] Recorded run exists, verified: contains a real Reviewer bounce, artifact, context snapshots
- [ ] Fallback video recorded (full script, screen + voice)
- [ ] Seed script restores clean state in one command (agents, Product Team, no Research Team/Validator yet)
- [ ] Gateway credit, Sprite, Exa, AgentMail keys verified; low-balance check
- [ ] Sprite pre-warmed, weights + corpus cached; network policy applied
- [ ] The seed hides the Research Team, Elliot (Research Lead), Sana (Validator) and the n-gram run until they're approved. The mockup's static data shows them already created [SEED-1]
- [ ] The report shows the recorded run's real numbers, not the mock's [REP-2]
- [ ] The demo build hides or locks the "Full auto" approval mode, "Runs on", group chat and the no-op buttons (search, voice, Create agent / team / organization) [CHAT-6, CHAT-7, CHAT-10, AGT-9]
- [x] Fast-forward lands the bounce within ~15 s (600× with auto-pause) [RUN-1]

**Before presenting**
- [ ] Reset DB to seed; confirm Research Team/Validator absent
- [ ] Reload the page to reset the chat. "New session" doesn't clear the thread while you're already on `/` [IA-5]
- [ ] Composer reads "Ask for approval"
- [ ] Idea prompt on the clipboard (the suggestion chips are gone after the first message)
- [ ] Smoke-test: direct answer + one proposal card end-to-end
- [ ] Browser zoomed, notifications off, second window with fallback video ready
- [ ] Phone on the **laptop hotspot or the tailnet**, and `EXPO_PUBLIC_API_URL` in `apps/mobile/.env` set to that IP (restart `npm start` after changing it; `expo start --tunnel` tunnels Metro only, never the API)
- [ ] **Mirroring tested** (QuickTime → Movie Recording over USB for iPhone, `scrcpy` for Android) with the phone beat run twice in a row
- [ ] Hotspot available as network fallback
- [ ] Email inbox visible in a tab. Switch back to Fabric before Dana replies: the mock's scripted typing stalls in a background tab [VIS-2]

## 6. Failure playbook

| Failure | Response |
|---|---|
| Proposal card doesn't appear | Trigger fixture proposal (hotkey); same UI; carry on. ⚠️ The mockup has no fixture hotkey yet: build one, or reload and resend [RUN-12] |
| Live run start stalls (>10 s) | Press `R` (Fast-forward → Replay from the current point; ↺ restarts from 0); say "network's slow, here's the recorded run" |
| Inspector empty | Open the recorded run's inspector (snapshots are in DB) |
| Email doesn't arrive | Skip; the chat message already delivered results |
| Total failure | Play fallback video; narrate live |

## 7. Anticipated judge questions

| Question | Answer |
|---|---|
| "Is this just Mastra Factory?" | Factory is a fixed software pipeline for issues. Fabric is a personal assistant that builds teams by conversation and shows exactly what each specialist loaded. |
| "Why not one big agent?" | Context bloat is the failure mode. The assistant stays small; specialists get minimal briefs. Handoffs add cost, so we track it — baseline comparison is next. |
| "What stops a specialist doing something risky?" | Creation needs approval; the Coder runs in a Sprite with an egress policy; tools go through a gateway with per-tool policy [confirm after spike]. |
| "Was the experiment real?" | The recorded run is the team's real output on this task; the badge marks replay. |
| "How does routing decide?" | The assistant's own judgment plus a compact registry — recorded per turn, so it can be evaluated. No classifier yet, by design. |
| "Why Neon?" | Postgres holds all state and the run event log; the Gateway serves every model call. |
| "Who are Dana, Jonah, Sana…?" | Dana is my assistant. The others are specialists, each a separate profile with its own soul, tools and memory — open Agent Studio to show their `SOUL.md`. |

## 8. Rehearsal plan
- Rehearse the exact script 3× against the live stack, once with the network off (replay only).
- Time each beat; the live-start beat must not exceed 45 s.
- Practice the one-sentence "what's real" disclosure until it takes < 10 s.
