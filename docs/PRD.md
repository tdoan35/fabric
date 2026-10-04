# Fabric — Hackathon PRD (Build Personal Agents Hack, Oct 4 2026)

| | |
|---|---|
| Status | Draft v0.2 — reconciled with the coded mockup on Oct 1 |
| Owner | Ty Thanh Doan (solo) |
| Derived from | `CONCEPT.md` (product model), sponsor doc research (Sept 29) |
| Companion docs | `ARCHITECTURE.md`, `DEMO-SCRIPT.md`, `MOCKUP-GAPS.md` (docs ↔ mockup gap register) |
| UI | Coded mockup in `apps/web` (Next.js, mock data, no backend) is the UI reference. `docs/design/fabric-screens.pen` is the earlier design pass. |
| Rules | Pre-building allowed (per owner; disclose on stage). ~5h15m of on-site hacking (10:30–1:00, 1:45–4:30). Submissions close 4:30 PM. Top 6 teams present. |

`CONCEPT.md` §2 (settled decisions) still binds. This PRD is the demo-thin slice of it. Anything marked **[UNVERIFIED]** rests on an assumption from docs that a spike must confirm. IDs in square brackets, such as [RUN-1], point to `MOCKUP-GAPS.md`.

---

## 1. One-line pitch

**Fabric is a personal assistant that manages capabilities instead of accumulating them.** It routes each request, proposes specialists and teams through conversation, hands off work with a minimal brief, and makes the whole organization inspectable.

Tagline (codename-level): *One assistant. A fabric of specialists.*

## 2. Why this fits the hackathon challenge

The challenge: "a personal agent that helps you with something in your personal life." The owner's real use case is running research experiments on ideas they think of (e.g. "can an n-gram/Engram lookup table make a small open model more capable, offloadable to NAND?"). The assistant takes that idea, builds a research team, and drives it. Framing for judges: *"I have ideas faster than I have time to test them. This is the assistant I delegate them to."*

## 3. Demo thesis

> Ask once → the assistant decides how to handle it → it proposes the right specialists/team and you approve → the team executes in parallel in sandboxes → you inspect exactly what each specialist saw → results come back as an artifact.

## 4. Users and jobs

- **Primary (demo):** the owner. A technical solo builder who tests ideas and wants delegation without babysitting.
- **Job to be done:** "When I have a research idea, hand it to a capable team, keep me in control of what gets created and what it can touch, and tell me when there's a result."

## 5. Scope

### 5.1 P0 — the demo does not exist without these

| # | Feature | Notes | Mockup (Oct 1) |
|---|---|---|---|
| P0-1 | **Assistant chat** with recorded routing **disposition** chip per turn (handle directly / propose team / propose specialist / delegate / clarify) | Assistant UI + Mastra agent. Disposition is a structured field emitted before the reply. | ✅ Chip on every turn (label, with the reason on hover). The assistant is the **Dana** persona. `considered[]` isn't shown [CHAT-13]. |
| P0-2 | **Proposal cards** with **Yes / No / Chat about this** for a team and a specialist | Team card shows roster with *existing* agents marked and *new* ones flagged. Specialist card shows purpose, tools, memory scope, restriction, lifecycle (one-line justification each). | ⚠️ Both cards work (**Build team** / **Yes, create Validator** / No / Chat about this). The team card lacks purpose, workflow, budget and the new lead's defaults [CARD-1]; after *Chat about this* there's no way to approve [CARD-4]. |
| P0-3 | **Handoff card** → deep link to Run view | "Task handed off" card inline in chat. | ✅ Card with member tiles and **View run** (`/runs/:id?live=1`). No Message lead or Pause (dropped from the `.pen`) [CARD-7]. |
| P0-4 | **Team workflow** (Mastra): Lead plan → parallel(Investigator, Coder setup, Validator prep) → implement → validate → Reviewer → accept or bounded rework | Rework budget visible as a counter (e.g. "rework 1/2"). | ⬜ Backend. The Teams → Workflow tab shows the stages but omits Synthesize [TEAM-3]. |
| P0-5 | **Run view** — dependency/handoff graph over time with per-member status, parallel lanes, streamed activity | Reads from `run_events` only. | ✅ Now the **loop view** (`/work/:task`): the team's workflow with the way back from review, member lanes with portraits and a drawn bounce arrow, budgets, the brief and its criteria. The live start zooms in on the first minute. Lanes still read precomputed segments [RUN-7]. |
| P0-6 | **Context inspector** — for any specialist run: actual assembled context (sections, source, token count) | Reads from `context_snapshots`. Headline feature. | ✅ Member panel → **Context** tab (sections, source, tokens, "Not loaded", assistant tokens) and **Tools** tab (policies, last denied). Snapshots exist for Coder and Validator only [RUN-6]; section text can't be opened [RUN-5]. |
| P0-7 | **Coder in a Sprite sandbox** with live terminal output | Fly Sprites. | ✅ (mock) Coder → Activity shows a terminal, the sandbox id and the egress line. |
| P0-8 | **Replay mode** — re-emit a *recorded real run* at up to 60× with a visible `Replay · Nx` badge and scrubber | Same Run view component as live. | ⚠️ Badge, scrubber with verdict/artifact markers, 1×/60×/600×, Fast-forward (`R`) at 600× pausing on each verdict: the bounce lands ~15 s after it [RUN-1 fixed]. Live is still simulated from the recording [RUN-2]. |
| P0-9 | **Results** — assistant posts "I got the results: [artifact]"; artifact opens as a report | Artifact comes from the recorded real run. | ⚠️ Report page ✅. Dana's results message ❌: results show only in the Run view [CHAT-14]. The numbers are illustrative [REP-2]. |
| P0-10 | **All model calls through Neon AI Gateway**; Postgres on Neon for all state | [UNVERIFIED: tool calling + usage fields on Gateway.] | ⬜ Backend. |

✅ in the mockup · ⚠️ partial · ❌ missing · ⬜ backend, not a UI item.

### 5.2 P1 — adds polish, cut in this order if time runs short (last listed cut first)

1. **AgentMail:** the Validator gets its own inbox on creation; the final report is also emailed (sent live at the end of the replay). Reply-by-email is *not* in scope. *Mockup: ⚠️ the report says "Also emailed to you via AgentMail", and Sana's inbox appears in Agent Studio, but not on the creation card [CARD-3].*
2. **Org view:** Research Team and a seeded (idle) Product Team side by side; the shared Coder (Jonah) drawn under each team with a `shared` tag, as in both the `.pen` and the mockup; dashed "hand off" edge with the question *"Can these results drive a real, value-driven product?"* and a `Preview — not built` label. *Mockup: ⚠️ under Teams → Organizations, Dana heads the org and teams hang off it by their leads, with the `shared` tag; the dashed edge and Preview label aren't rendered yet [ORG-1].*
3. **Context/cost chip:** main-assistant token count next to specialist counts (shows "manage, don't accumulate"); per-run cost from Gateway usage. *Mockup: ✅ in the Run view header (`$0.42`, `Assistant 2.1k tok`) and the Context tab. The composer also shows a session context meter, which is a different number [CHAT-9].*
4. **Executor:** tool calls for Investigator/Validator go through Executor; one visible allow/blocked call in the inspector. [UNVERIFIED: per-agent scoping.] *Mockup: ⚠️ the Tools tab shows allowed / approval / blocked and one denied `network.fetch`, but tool names differ between screens [DATA-6].*
5. **Agents roster screen** with a specialist detail page (soul, skills, tools, permissions). *Mockup: ✅ exceeded by Agent Studio: profiles, `SOUL.md` / `IDENTITY.md` / `USER.md`, skills, tools, connectors, memories, community profiles [AGT-1].*

### 5.3 P2 — only if there's slack
- Kernel browse tool for the Investigator, with live view embedded in the run view. (The mockup has a Desktop live-view slot in the chat's Session panel instead [CHAT-11].)
- "Message lead" (Mastra signals-style steering).
- Neon branch-per-run.

### 5.4 Explicit non-goals for the hackathon
- Live multi-minute experiment completion (the run *starts* live, the rest is replayed from a real recorded run).
- Budget-exhaustion escalation flow (mention verbally; the rework counter shows the bound).
- Memory-scope viewer, templates, registry embeddings, text/SMS, team-to-team handoff (shown as preview only), mobile. The mockup shows static per-agent memories and a community catalog of agents and teams; both stay vision-only, with no write path and no install backend [AGT-4, AGT-6].

### 5.5 In the mockup but not in this PRD

These are UI-only in `apps/web`. None is on the demo path unless the table says so. The decisions are in `MOCKUP-GAPS.md` §2.

| Feature | Where | Demo stance |
|---|---|---|
| Personas: the assistant **Dana** plus named specialists with portraits | Everywhere except the chat cards, Run view and Report | Use, but unify naming first [NAME-1] |
| Sessions and projects (history, status dots, pin / archive / delete, search) | Sidebar | Static backdrop; don't click search or delete |
| Smart suggestions (rotating chips drawn from recent sessions) | Empty chat | Use the first chip for beat 1 [CHAT-4] |
| Agent switcher and direct chat with a specialist | Chat hero | Off path; the replies are placeholders [CHAT-2] |
| Agents / Teams toggle | Chat hero | Off path; it only changes the copy [CHAT-3] |
| Incognito chat | Chat header | Off path [CHAT-5] |
| Group chat button | Chat header | Hide; unwired [CHAT-6] |
| Approval modes: Ask / Auto-approve edits / Full auto | Composer | Keep "Ask for approval"; hide Full auto [CHAT-7] |
| Model and reasoning-effort picker | Composer | Keep only if the Gateway serves those models [CHAT-8] |
| Session settings: project, connectors, Runs on | Tray / Session panel | Hide "Runs on" or default it to Sprite [CHAT-10] |
| Session context meter (1M window, compaction at 80%) | Composer / Session panel | Decide what it claims [CHAT-9] |
| Session panel with a Desktop live view | Right side of the chat | Idle placeholder; the P2 Kernel view would land here [CHAT-11] |
| Attachments, dictation, voice button | Composer | Off path; voice is unwired [CHAT-12] |
| Teams screen: per-team duties, workflow stages, criteria, runs | `/teams` | Optional "operating model" moment [TEAM-1] |
| Organizations: several orgs, team copies, add / remove teams | `/teams` → Organizations | Used for the Org view beat; copies need a decision [ORG-3] |
| Community profiles and teams (author, installs, add) | Agent Studio, Teams | Vision only [AGT-6] |

## 6. Key user flows (demo path)

### Flow A — Handle directly
User asks a conceptual question; in the mockup that's the first suggestion chip, "What's an n-gram, in one line?". The assistant (Dana) answers it herself. Chip: `handle directly`. Shows delegation-first ≠ delegation-always.

### Flow B — Propose team, then specialist
1. User pastes the experiment idea.
2. Dana (chip `propose team`): "That's an interesting idea — but I think it would go better if I built a research team for it." Card: **Research Team · proposed team**, with roster Research Lead · new, Investigator · existing, Coder · existing, Reviewer · existing, and buttons **Build team / No / Chat about this**.
3. Build team. Dana (chip `propose specialist`) adds that a Validator would improve the results. Card: **Validator · New specialist**, with Tools / Memory / Restriction / Lifecycle rows (each with a why) and buttons **Yes, create Validator / No / Chat about this**.
4. Yes. Dana (chip `delegate team`): "Got it, the team is formed and your experiment is handed off. I'll ping you here and by email when there are results." Handoff card → **View run**.

Rules: proposals never instantiate anything before approval. *Chat about this* returns to the conversation with the proposal still pending. Existing agents are offered first ("Coder · existing").

Branches as the mockup plays them:
- **No** on the team → Dana offers to just answer questions about the idea.
- **No** on the Validator → Dana says she'll hand off without one, but the mock never hands off, and the recording includes a Validator. Only the approve path is demo-supported [CARD-5].
- **Chat about this** → the card reads "Discussing — proposal still pending" and loses its buttons. After the discussion Dana should issue a revised card; that isn't built yet [CARD-4].

### Flow C — Run view (live start → replay)
1. **Live (~45 s):** Research Lead, Investigator (Exa), Coder (Sprite), Validator prep run in parallel with streamed activity. Click a lane → right panel with **Activity · Context · Tools** tabs.
2. **Fast-forward:** user hits FF; badge `Replay · 60×`. The recorded run shows the Reviewer bouncing the work back to the Lead and the rework counter incrementing, then acceptance. ⚠️ On the 3h 12m recording, 60× puts the bounce ~2.5 min away. It needs 600× with auto-pause on verdicts, or a scrub [RUN-1]. ARCHITECTURE §8 specifies how the live run hands over to the recording [RUN-2].

### Flow D — Result
Assistant: "I got the results here: [artifact]". Report card (recorded real results). Email arrives via AgentMail (P1). ⚠️ Mockup: only the Run view's "Results are ready · Open report" card exists; Dana's chat message isn't built [CHAT-14].

### Flow E — Vision
Under Teams → Organizations: Dana at the head; the Research and Product teams attached by their leads; Jonah tagged `shared` under both; a dashed handoff edge with a Preview label. ⚠️ The edge and label aren't built [ORG-1].

## 7. Seeded data

| Entity | Persona (mockup) | State before demo |
|---|---|---|
| Assistant profile | **Dana**, executive assistant (default) | Small; personal context only; compact registry descriptions |
| Agents (existing) | **Coder** = Jonah · **Investigator** = Megan · **Reviewer** = Carlos | Seeded |
| Agents (created live) | **Research Lead** = Elliot · **Validator** = Sana | Absent until approved |
| Teams | Research Team (lead Elliot) is created live. **Product Team** is seeded idle for the Org view: Diego (Product Lead), Lila (Market Analyst), Jonah (shared Coder), Maya (Designer) | Product Team only |
| Recorded run | — | One full real run of the experiment task (`runs.recorded = true`), incl. context snapshots and artifacts |

The recorded run must come from the *actual* team on the *actual* task at real scale — not hand-written results. The Reviewer bounce should be a real event in that run (re-run until representative, since this is pre-event and cheap).

⚠️ The mockup's static data shows the *post*-demo state: the Research Team is active ("Created in chat · today"), Elliot and Sana exist, and the run is listed. The real seed must hide all of these until approval, and Studio, Teams and Orgs must read the creation state [SEED-1]. The mock's report numbers are illustrative too [REP-2].

## 8. UI surfaces (coded mockup in `apps/web`)

The Pencil pass (`docs/design/fabric-screens.pen`) came first. The coded mockup has since moved past it and is now the reference; the routes below are the mockup's. `MOCKUP-GAPS.md` §4.12 lists what the `.pen` still shows that the mockup lacks.

| Screen | Route | Content (mockup) | Open gaps | Priority |
|---|---|---|---|---|
| Assistant | `/` ("New session") | Dana hero; suggestion chips; composer (approval mode, model, attachments, dictation); tray (project, connectors, context meter, run target); disposition chips; proposal and handoff cards; Session panel | Results message [CHAT-14]; team-card detail [CARD-1] | P0 |
| Loop view + inspector | `/work/:task` (`?loop=N`, `?live=1` for the live start); `/runs/:id` redirects there | Waiting-on-you strip (links to Weave); budgets (rework, time, Dana's context; cost hidden for now); workflow steps with the way back from review and the latest verdict; member lanes; play / scrub with markers / 1×·60×·600× / Fast-forward / restart or Go live; results card; artifacts. Right panel: **Brief** (objective, done-when criteria checked as evidence arrives, constraints, preferences, what stayed with Dana), or a member's **Activity · Context · Tools** with each context section's text | [RUN-2] | P0 |
| Report | `/reports/[id]` | Summary, held-out perplexity table (valid / contaminated), caveats, provenance, made by, artifacts, emailed note | No setup section or artifact links [REP-1]; numbers not real yet [REP-2] | P0 |
| Org view | `/teams` → Organizations | Dana at the head, teams by lead, `shared` tag, add / remove teams | Handoff edge and Preview label [ORG-1] | P1 |
| Agents | `/agents` (Agent Studio; `?agent=<id>`) | Profiles and community profiles; Profile · Capabilities · Memory tabs | Model/harness not shown [AGT-7] | P1 |
| Teams | `/teams` | Your teams and community teams; Members · Workflow · Runs tabs | Synthesize step missing [TEAM-3] | P1 |
| Work board | `/work` (`?project=`, `?view=teams&team=`) | Projects (default): swimlanes per project, columns Proposed · In progress · In review · Done; cards show the team, the current step, who's working, rework, spend, and amber flags that link to Weave. Teams: one team's workflow steps as columns, with members' state now. Previous loops below both, ready to replay. Decisions in Weave move the cards | — | P1 |

Design principles carried from the concept: calm by default, inspectable on demand; org view and run view are different graphs; conversation is the creation surface.

## 9. Sponsor usage

| Sponsor | Used for | In the demo | Priority |
|---|---|---|---|
| Neon Postgres | All state: agents, teams, runs, events, snapshots, artifacts | Inspector and replay read from it | P0 |
| Neon AI Gateway | All agent model calls; per-run token/cost | Cost/context chip | P0 (fallback: count tokens ourselves) |
| Mastra | Agents, team workflows, approvals, tracing | Whole backend | P0 |
| Assistant UI | Chat + tool-UI proposal/handoff cards | Assistant screen | P0 |
| Fly Sprites | Coder sandbox (network policy, streamed exec) | Terminal peek in run view | P0 |
| Exa | Investigator's search | Live start | P0 |
| AgentMail | Validator inbox; emailed report | End of replay | P1 |
| Executor | Tool gateway + approvals + credential isolation | Inspector shows tool policy | P1 |
| Kernel | Browse tool + live view | Optional | P2 |

## 10. Success criteria

1. A full dry run of the script (live start + replay) fits in ≤ 6:30, three times in a row.
2. The Assistant → proposal → handoff sequence works live with no manual DB edits.
3. The run's live portion shows ≥ 3 members working concurrently with streamed output.
4. The inspector answers "what did this specialist actually load?" for at least Coder and Validator.
5. Full-replay fallback works with the network off (except the model calls being skipped) — the whole Run view + report can play offline.
6. Every claimed sponsor use is real on screen, not narrated only.
7. From Fast-forward, the Reviewer bounce is on screen within ~15 s and results within ~60 s [RUN-1].
8. Before approval, no screen shows the Research Team, the Research Lead or the Validator [SEED-1].

## 11. Risks

| Risk | Mitigation |
|---|---|
| Neon Gateway lacks tool calling or usage data | Spike #1 this week. Fallback: route Mastra through Vercel AI SDK provider `@neon/ai-sdk-provider`; count tokens from Mastra telemetry. Second fallback: another provider for tool-calling agents, Gateway for the rest. |
| Live start fails (wifi, model, Sprite) | Same Run view runs entirely from replay; recorded video as second fallback. |
| Assistant proposals nondeterministic | Structured tool calls; low temperature; seeded conversation fixtures used as a fallback path with the same UI. |
| Executor can't scope per agent | Enforce allowlists in our tool layer; use Executor for credentials/approvals only. |
| Mastra Factory overlap seen as derivative | Position: Factory = fixed software pipeline; Fabric = conversational, personal, context-inspectable. Don't depend on Factory. |
| Solo scope creep | P1 cut order in §5.2. Freeze features Oct 3 evening. |
| "Was this real?" | Say on stage: run starts live; the rest is a recorded real run, fast-forwarded. Badge in UI. |
| Replay too slow: on a 3h 12m recording, 60× puts the bounce ~2.5 min after FF | Fast-forward at 600× with auto-pause on `review.verdict`, or scrub; rehearse it [RUN-1] |
| The live → replay switch shows a different run (ids, timing) | Splice as in ARCHITECTURE §8; rehearse the cut [RUN-2] |
| Roles on some screens, personas on others ("Validator" vs "Sana") | One display rule, "Sana · Validator" [NAME-1] |
| Visible options undercut the safety story ("Full auto — never ask", "Runs on: This machine", group chat) | Hide or lock them for the demo [CHAT-6/7/10] |
| The static post-demo state shows before approval | Seed data and pages read the creation state [SEED-1] |
| Illustrative report numbers are mistaken for real ones | Replace them with the recorded run's results; label them until then [REP-2] |

## 12. Timeline

**Pre-event (Sep 29 – Oct 3)**
- D1: spikes (see `ARCHITECTURE.md` §12).
- D2: schema, agents, team workflow, disposition + proposal tools.
- D3: UI from Pencil designs; Run view reads events. *(Status Oct 1: the coded mockup is done on mock data and has gone beyond the Pencil designs. The remaining UI work is the Build items in `MOCKUP-GAPS.md` §1. Backend wiring goes through `apps/web/src/lib/api` — see ARCHITECTURE §15.)*
- D4: record the real run; replay mode; inspector; report.
- D5: P1 items in cut order; slides; rehearsal; record fallback video.

**Day-of (Oct 4)**
- 9:00–10:30: setup, verify creds/credits at the venue, smoke-test live start.
- 10:30–4:30: finish P1, polish, rehearse, re-record fallback if anything changed, submit (check what the submission requires — open question).

## 13. Open questions

1. What does submission require (repo link, video, form)? Pre-built code disclosure format?
2. Is the Neon Gateway credit active on the owner's account/region?
3. Does Mastra Factory expose reusable libraries? (Low priority.)
4. Does the team card need the *Research Lead* to be new, or should a "lead" role be an existing generic agent? (Current plan: new.)
5. Product name: keep "Fabric" for the hackathon; brand decision deferred.
6. How agents are named and displayed, and when a new specialist gets its persona (the "Validator" proposal becomes "Sana") [NAME-1, NAME-2].
7. Direct chat with specialists, the Agents/Teams toggle, incognito and group chat: keep, define or hide? [CHAT-2, CHAT-3, CHAT-5, CHAT-6]
8. Approval modes and "Runs on": what may Full auto skip, and what is the default execution target? [CHAT-7, CHAT-10]
9. Organizations and team copies; the scope of the community catalog [ORG-3, AGT-6].
10. Which models the picker offers through the Neon Gateway, and what the context meter claims [CHAT-8, CHAT-9].

`MOCKUP-GAPS.md` §2 has a recommendation for each.
