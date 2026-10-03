# Fabric — Docs ↔ Mockup Gap Register

| | |
|---|---|
| Status | v1 — first reconciliation |
| Date | 2026-10-01 |
| Compared | `CONCEPT.md`, `PRD.md`, `ARCHITECTURE.md`, `DEMO-SCRIPT.md` ↔ the coded mockup in `apps/web` (Next.js, mock data, no backend) and the earlier Pencil pass `fabric-screens.pen` |
| Method | Read every file under `apps/web/src`; clicked through every route and every proposal-card branch in a browser; timed the replay; checked each doc section against it |

The coded mockup is now the UI reference. It is **ahead** of the docs in most places (personas, sessions, Agent Studio, Teams, Organizations) and **behind** them in a few demo-critical ones (results message, org handoff edge, replay timing). Each gap has a resolution:

- **Docs updated** — the mockup is the newer intent; the named doc section now matches it.
- **Build** — the docs still stand; the mockup doesn't do it yet.
- **Decide** — the mockup adds something with no agreed meaning, or something that conflicts with a settled decision. Logged as a proposed amendment in `CONCEPT.md` §13 and an open question in `PRD.md` §13.
- **Fix mock** — the mockup disagrees with itself.

The Demo column measures stage risk: **High** = a `DEMO-SCRIPT.md` beat can't be played as written · **Med** = visible on stage but survivable · **Low** = polish · **—** = not on the demo path.

---

## 0. Update — Oct 2: Work redesign

Work is now a board of tasks and their loops (CONCEPT §13 A-12): `/work` (by project, or by team) and `/work/:task` (the loop view); `/runs/:id` redirects. This closes or changes these entries:

| ID | Now |
|---|---|
| IA-2 | **Closed.** Work lists every task by project (Proposed · In progress · In review · Done) or by team (its own steps), with previous loops to replay. Breadcrumbs are links |
| RUN-1 | **Closed.** Speeds are 1× · 60× · 600×. Fast-forward runs at 600× and pauses on each verdict: from the live start, the bounce lands in ~15 s |
| RUN-5 | **Closed.** Each context section expands to show its text, rebuilt from the agent's workspace files, the brief and the tool policy |
| RUN-6 | **Closed** for the 135M loop: every member has a snapshot |
| RUN-9 | **Closed.** After the rework, Sana re-checks before Carlos accepts, and `eval-log.jsonl` is hers in both the events and the report |
| RUN-10, RUN-11 | **Closed.** Lanes and the inspector show "Name · Role" with portraits; the bounce is drawn as an arrow back to Elliot |
| NAME-1 | **Partly closed.** Work and the Report use personas from one registry (the role-based `mock/agents.ts` is gone). The chat cards still use roles |
| TEAM-3 | **Closed.** The Research workflow has a Synthesize step |
| REP-3 | **Closed.** "Made by" shows portraits |
| SEED-1 | **Unchanged**, and Work adds to it: the board shows the post-demo world (the 360M and NAND loops, Sana's email ask). The live start (`?live=1`) hides the task's current asks |
| — | **New mock data:** the 360M loop (running, two asks), the NAND probe (loop 1 stopped by you, loop 2 out of rework budget) and the Product handoff (proposed, Preview). Weave items carry a `taskId`; deciding in Weave moves the card |

## 1. Before Oct 4 — the short list

| # | ID | What | Why it matters |
|---|---|---|---|
| 1 | RUN-1 | ~~Fast-forward at 60× is too slow for the 3h 12m recording~~ Closed Oct 2 (§0) | — |
| 2 | CHAT-14 | Dana's "I got the results" message isn't in the chat | PRD P0-9; demo beat 4:40 |
| 3 | ORG-1 | Org view has no dashed Research → Product edge or "Preview" label | PRD P1-2; demo beat 5:15, and the rule that anything unbuilt is labelled |
| 4 | RUN-2 | Live → recorded switch is unspecified | The live run and the recording are different runs; the mock fakes both with one |
| 5 | SEED-1 | Static data shows the post-demo state | Research Team, Elliot and Sana already exist before you approve them |
| 6 | NAME-1 | Roles in the chat, Run view and Report; personas everywhere else | The "Validator" card becomes "Sana" in Studio with no explanation |
| 7 | CHAT-6/7/10 | Unsafe-looking options on screen | "Full auto — never ask", "Runs on: This machine" (the default), group chat |
| 8 | CARD-1 | Team card omits purpose, workflow, budget and the new lead's defaults | Weakens "every default has a justification" (CONCEPT §2.7) |

## 2. Decisions needed

| ID | Question | Recommendation |
|---|---|---|
| NAME-1/2 | How are agents displayed, and who names a newly created one? | "Jonah · Coder" everywhere, with a portrait where there's room. Dana proposes the name on the proposal card, so nothing is renamed after approval |
| CHAT-2 | Keep direct chat with specialists? | Keep it as an explicit user override, recorded as a disposition. The specialist sees its own `USER.md`, never Dana's memory (CONCEPT A-2) |
| CHAT-7 | What may "Full auto" skip? | Only in-sandbox actions. Creating agents or teams, and the human-authority gates, always ask (CONCEPT A-3). Hide it for the demo |
| CHAT-10 | What does "Runs on" control, and what's its default? | Where delegated execution runs. Default to Sprite; "This machine" needs explicit approval (CONCEPT A-7). Hide it for the demo |
| ORG-3 | Are organizations a primitive, and what is a team "copy"? | An org is a personal grouping plus reporting line. Drop copies until a copy means a separate team instance (CONCEPT A-4) |
| AGT-6 | Is the community catalog in scope, and how is installing reviewed? | Vision only for the demo. Later, installing renders a proposal card (CONCEPT A-5) |
| CHAT-6 | What is a "group chat"? | Remove it, or define it as a user-hosted multi-agent session that is not a team (CONCEPT A-6) |
| CHAT-9 | What does the context meter claim? | Show the base assistant context (~2.1k) separately from conversation history. No 1M window on stage unless it's real (CONCEPT A-10) |
| CHAT-8 | Which models does the picker offer? | Only models the Neon AI Gateway actually serves (spike 1) |
| CARD-8 | Does `handoff_to_team` need its own approval? | No — approving the team and specialist authorizes it. Fix Dana's tool list |
| AGT-3 | Specialist `USER.md` vs. per-run preferences in the brief | `USER.md` is the per-agent ceiling; the brief picks from it per run (CONCEPT A-9) |
| CHAT-5 | What does incognito skip? | Session history and memory writes. Dispositions and runs are still audited (CONCEPT A-8) |
| CHAT-3 | What does the Agents/Teams toggle do? | Teams mode should pick a team (or let Dana pick); today it only changes the copy |
| RUN-1 | Which replay control fixes the timing? | Fast-forward at 600× with auto-pause on each `review.verdict` (ARCHITECTURE §8) |

## 3. Screen inventory

| Route | Screen | Built | Contents |
|---|---|---|---|
| `/` | Assistant ("New session") | ✅ | Dana hero with agent switcher; Agents/Teams toggle; rotating suggestions; composer (attachments, dictation, approval mode, model + effort, voice); tray (project, connectors, context meter, run target); thread with disposition chips and proposal/handoff cards; right Session panel (desktop view, settings, context) |
| `/runs/[id]` (`?live=1`) | Run view + inspector | ✅ | Header badges; member lanes; replay controls; verdict banner; results card; member panel tabs Activity · Context · Tools |
| `/reports/[id]` | Report | ✅ | Summary, results table, caveats, provenance, made by, artifacts, emailed note |
| `/agents` (`?agent=<id>`) | Agent Studio | ✅ | Your profiles (9) and community profiles (5); expanded card: Profile (`SOUL.md` · `IDENTITY.md` · `USER.md`) · Capabilities (skills, tools, connectors) · Memory |
| `/teams` | Teams | ✅ | Your teams (2) and community teams (3); expanded team: Members · Workflow · Runs |
| `/teams` → Organizations | Org view | ⚠️ | "Ty's Lab": Dana at the head, teams by lead, `shared` tag, add/remove teams; no handoff edge |
| — | Work index | ❌ | The "Work" link opens the one run |
| `/weave` (`?item=<id>`) | Weave | ✅ | Added Oct 2, post-demo (CONCEPT A-11). Inbox of typed asks (approval, question, escalation, proposal, finding, result): cost-of-delay lines, one-click ✓/✗ for non-gated approvals only, snooze by time or event, undo. Center: Dana's brief and Pulse (lead updates with health and a diff block, event lines, memory Keep/Forget, policy changes; Highlights · Everything), or the open item. Right: presence rings, mini calendar, your day. Keyboard j/k/↵/a/e/s/esc. Mock clock Fri Oct 2, 11:20; run links stand in for the 360M run |
| shell | Sidebar | ✅ | Search (unwired), Weave (amber count of open asks), New session, Agent Studio, Teams, Work; Projects; Sessions with status dots and pin/archive/delete; collapsible and resizable; light/dark |

Unwired controls (no-ops): Search sessions, Start a group chat, voice conversation, Create agent, Create team, Create organization.

---

## 4. Register

### 4.1 Shell & navigation

| ID | Gap | Resolution | Demo |
|---|---|---|---|
| IA-1 | The docs define four areas — Assistant, Agents, Teams, Work (CONCEPT §8.2, PRD §8, `.pen`). The mockup's sidebar is Search · New session · Agent Studio · Teams (Teams ⇄ Organizations) · Work, plus Projects and Sessions. | Docs updated — CONCEPT §8.5, PRD §8 | — |
| IA-2 | Work should list active and completed runs, with blockers, approvals and an audit trail (CONCEPT §8.2). In the mockup, "Work" opens the single run at Replay 1×, and runs are listed per team instead. Breadcrumbs are plain text, not links. | Build (after the demo) | Low |
| IA-3 | Sessions and projects aren't in any doc. The mockup has a session history (a mock comment says "imported from ChatGPT history"), status dots (green = unread reply, pulsing amber = needs your input), pin / archive / delete (local state; delete has no confirmation), and projects as folders of sessions, with a project picker in the composer. | Docs updated — CONCEPT §3, ARCHITECTURE §4 (seed data for the demo) | — |
| IA-4 | CONCEPT §8.3.5 asks how approvals and blocked states interrupt the user. The mockup's answer is the pulsing amber "needs your input" dot, but nothing sets it from a real pending approval yet. | Docs updated — CONCEPT §8.5; Build the wiring | Low |
| IA-5 | "New session" doesn't clear the thread when you're already on `/`: the route is the same, so the state survives. Only "Back to Dana" or a page reload resets it. | Fix mock; DEMO-SCRIPT §5 says reload | Med |

### 4.2 Assistant chat

| ID | Gap | Resolution | Demo |
|---|---|---|---|
| CHAT-1 | The docs say "the assistant". The mockup gives it a persona: **Dana**, an executive assistant with an animated portrait, traits and the greeting "What's on your plate, Ty?". | Docs updated — CONCEPT §3, PRD §6–7, DEMO-SCRIPT | — |
| CHAT-2 | Hovering the hero reveals an agent switcher (Dana · Jonah · Megan · Carlos). Picking a specialist starts a **direct chat** ("Direct chat · Back to Dana"), which gives a placeholder reply. No doc covers this, and it bypasses routing (CONCEPT §2.1, §4) and the brief (§2.6, §6). | Decide — CONCEPT A-2 | — |
| CHAT-3 | The empty state has an **Agents / Teams** toggle. Teams mode only changes the heading ("Which team should take this on?") and the placeholder; it's still Dana, and there's no team picker. | Decide | — |
| CHAT-4 | Suggestion chips come from recent sessions: three per page, rotating every 6 s, pausing on hover, with a "Based on your session: …" tooltip. Specialists have their own sets. The first page is the demo path. The chips disappear after the first message, so the idea has to be pasted. | Docs updated — DEMO-SCRIPT §3, §5 | Med |
| CHAT-5 | **Incognito chat**: "Not saved to your sessions or used to shape your assistant." No doc covers it, and it touches memory scoping (CONCEPT §2.9). | Decide — CONCEPT A-8 | — |
| CHAT-6 | **Start a group chat** (+) is unwired. CONCEPT §2.5 says a team "is an operating model, not a group chat", and "group chat" has no defined meaning. | Decide — CONCEPT A-6; hide for the demo | Med |
| CHAT-7 | The composer has **approval modes**: Ask for approval (the default), Auto-approve edits ("ask only for new agents and teams") and Full auto ("never ask, inside the sandbox"). They're UI only. Unless it's scoped, Full auto conflicts with CONCEPT §2.2 and the human-authority gates in §10. | Decide — CONCEPT A-3; hide Full auto for the demo | Med |
| CHAT-8 | **Model and effort picker**: Fable 5.1 · Opus 5.5 · Sonnet 5.5 (default) · Haiku 4.5, with effort from Low to Extra high. The mock data gives each agent a model (Dana and Jonah Sonnet 5.5, Megan Haiku 4.5, Carlos Opus 5.5), but no screen shows it. ARCHITECTURE sends every call through the Neon AI Gateway, whose model catalog is unverified. | Decide — PRD §13; check in spike 1 | Low |
| CHAT-9 | The **context meter** shows the session's context as a percentage of a 1M window, with an "auto-compacts at 800k" marker (mock math: 2,140 + 1,800 per message). The docs only have a token chip (PRD P1-3) and say "the main assistant's context must stay bounded by design" (CONCEPT §10); they say nothing about compaction. | Docs updated — ARCHITECTURE §7 (two numbers); Decide — CONCEPT A-10 | Low |
| CHAT-10 | **Session settings**: project; connectors (Exa, AgentMail, Executor, Neon, Kernel); and **Runs on** — This machine (the default), Sprite sandbox or Remote host. They sit in the tray before the first message and in the right Session panel after it. No doc covers per-session connectors or execution targets; ARCHITECTURE §9 isolates per agent (the Coder runs in a Sprite). | Decide — CONCEPT A-7; hide "Runs on" or default it to Sprite for the demo | Med |
| CHAT-11 | The Session panel has a **Desktop** view: an embedded VNC or browser live view ("Appears here when an agent uses a computer or browser"). PRD P2 puts the Kernel live view in the Run view instead. | Docs updated — PRD §5.3 | — |
| CHAT-12 | The composer also has attachments (images, text), dictation (Web Speech) and a voice-conversation button (unwired). None is in the docs. | Docs updated — PRD §5.5 | — |
| CHAT-13 | The disposition chip shows the label, with the reason as a tooltip. `considered[]` (ARCHITECTURE §5) isn't shown anywhere. | Docs updated — ARCHITECTURE §15; Build later (Work audit trail) | Low |
| CHAT-14 | PRD P0-9 and demo beat 4:40 expect Dana to post "I got the results here: [artifact]" in the chat. The mockup shows "Results are ready · Open report" only inside the Run view, and the session never turns "unread". | Build (P0) | **High** |
| CHAT-15 | Only the chip question gets a real direct answer; any other question gets a placeholder. | Docs updated — DEMO-SCRIPT uses the chip | Low |

### 4.3 Proposal & handoff cards

| ID | Gap | Resolution | Demo |
|---|---|---|---|
| CARD-1 | The team card shows the name, "proposed team", a status badge, roster chips (new / existing) and **Build team / No / Chat about this**. It doesn't show the team's purpose (which is in the payload), a workflow preview, the rework budget or completion criteria (CONCEPT §7, ARCHITECTURE §5), or any defaults for the **new** Research Lead (CONCEPT §2.7). | Build | Med |
| CARD-2 | The specialist card's rows — Tools / Memory / Restriction / Lifecycle, each with a "why" — match PRD P0-2. It has no Model/harness or Skills row, which the CONCEPT §7 card has. | Docs updated — PRD §6; a model row is optional | Low |
| CARD-3 | Once approved, the Validator card just says "Approved". The `.pen` design showed "inbox validator@fabric.agentmail.to · Created", and demo beat 1:55 mentions the inbox. The addresses also disagree: the `.pen` has `validator@fabric.agentmail.to`, while Studio has `sana@fabric.mail` and `dana@fabric.mail`. | Build (P1-1); Fix mock (one address format) | Med |
| CARD-4 | After **Chat about this**, the card reads "Discussing — proposal still pending." but loses its buttons, and nothing re-proposes. | Docs updated — ARCHITECTURE §5 (Dana re-issues a revised card that supersedes the old one); Build | Low |
| CARD-5 | If you decline the Validator, Dana says "I'll hand off without a Validator. The Reviewer still checks the work." — but no handoff happens. The recording includes a Validator, so this branch has nothing to replay. | Docs updated — PRD §6 (only the approve path is demo-supported); Fix mock | Low |
| CARD-6 | A declined team card still shows "Needs approval". | Fix mock | Low |
| CARD-7 | The handoff card has a title, a "Running" badge, the brief note, four member tiles and **View run**. CONCEPT §8.2 and the `.pen` also had Message lead, Pause and a footer ("rework 0/2 · 4 completion criteria · your chat is not shared"). It still meets PRD P0-3. | Docs updated — PRD §5.1 (minimal card; Message lead stays P2) | — |
| CARD-8 | Dana's tool list (in the profile sheet and Studio) marks `handoff_to_team` as `approval`, but the flow hands off without asking. | Decide — ARCHITECTURE §5; Fix mock | Low |
| CARD-9 | The `delegate_agent` disposition exists, but there's no `handoff_to_agent` tool or card. CONCEPT §10.1's "coding handoff → Coder" path isn't in this slice. | Docs updated — ARCHITECTURE §5 | — |

### 4.4 Run view & inspector

| ID | Gap | Resolution | Demo |
|---|---|---|---|
| RUN-1 | The recording runs 3h 12m, and Fast-forward (button or `R`) plays it at 60×. Measured: 15 s of wall time covers 15 min of run time. Fast-forwarding at t ≈ 1 min puts the request-changes verdict (t = 2h 35m) ~2 min 34 s away and the end ~3 min 11 s away; the script allows ~10 s and ~50 s. | Build; Docs updated — ARCHITECTURE §8, DEMO-SCRIPT §3: 600× with auto-pause on each `review.verdict` puts the bounce ~15 s after Fast-forward | **High** |
| RUN-2 | The live → recorded switch is undefined. The handed-off run is a new run with a new id; the recording is a different run. In the mockup, `?live=1` simply plays the recording at 1× with a `Live` badge ("live run (simulated)"), and any speed change or scrub flips it to Replay. | Docs updated — ARCHITECTURE §8 (proposed splice); Build | **High** |
| RUN-3 | Once there's a backend, the `Live` badge must appear only for real events (PRD §11, "Was this real?"). | Docs updated — ARCHITECTURE §8 | Med |
| RUN-4 | PRD §8 describes the inspector as a side panel, and the `.pen` draws it as an overlay. In the mockup it's the right-hand member panel, with tabs **Activity · Context · Tools**. | Docs updated — PRD §8, DEMO-SCRIPT beat 3:15 | — |
| RUN-5 | The Context tab lists each section's label, source and token count, but you can't open the section text itself (`content_ref`; CONCEPT §6, "the actual system-prompt assembly"). | Build (P1) | Low |
| RUN-6 | Only the Coder (Setup, Implement) and Validator (Prep checks, Execute) have snapshots; the Lead, Investigator and Reviewer show "No context snapshot recorded". That still meets PRD §10 #4. | Docs updated — PRD §5.1 | — |
| RUN-7 | The lanes read precomputed `run.segments`, whereas ARCHITECTURE §1 says the Run view reads only `run_events`. The mock already emits `step.started/finished`. | Docs updated — ARCHITECTURE §8 (derive segments from step events) | — |
| RUN-8 | Narration lines are `tool.result {line, kind: "msg"}`, whereas ARCHITECTURE defines `agent.message`. The mock has no `step.failed`, `agent.message` or `run.blocked` events. | Docs updated — ARCHITECTURE §4 | — |
| RUN-9 | The mock timeline skips re-validation after rework: the Validator runs once (on attempt 1), and the Reviewer accepts attempt 2 directly. That contradicts the team's criterion "Validator reproduces the headline number" and the ARCHITECTURE §6 loop. Separately, `eval-log.jsonl` is created by the Coder in the events but credited to the Validator in the report. | Fix mock; the real recording must include the re-run | Med |
| RUN-10 | The lanes and member panel use role names with letter initials (see NAME-1). | Decide (NAME-1) | Med |
| RUN-11 | Demo beat 4:00 mentions an "arrow back to Research Lead", but the mockup draws no arrow. Instead it shows a "Reviewer → Research Lead · request changes" banner, an amber "Bounced" segment, then the Lead's "Re-plan" and a dashed Coder "Rework". | Docs updated — DEMO-SCRIPT | — |
| RUN-12 | `R` means fast-forward (60×, from the current point). DEMO-SCRIPT §6 calls it "switch to full replay", and it relies on a fixture-proposal hotkey that doesn't exist. | Docs updated — DEMO-SCRIPT §6; Build the fixture hotkey or drop it | Med |
| RUN-13 | The cost chip ($0.42) and assistant chip (2.1k tok) sit in the Run view header, and "Assistant: 2,140 tokens" appears in the Context tab — so PRD P1-3 is done in the mock. | Docs updated — PRD §5.2 | — |

### 4.5 Report

| ID | Gap | Resolution | Demo |
|---|---|---|---|
| REP-1 | PRD §8 asks for setup, baselines, results, caveats and a code-bundle link. The report has no Setup section (model, corpus, n, λ, split), and its artifacts are a plain list, not links. | Build | Med |
| REP-2 | The numbers are illustrative and unlabelled (ppl 34.2 / 19.8 / 30.9); the `.pen` marked them "Sample data (design)". PRD §7 requires the recorded run's real results. | Build — replace before the demo; label until then | Med |
| REP-3 | "Made by" shows initials R I C V R, so the Research Lead and the Reviewer are both "R". | Fix mock (portraits or names) | Low |
| REP-4 | The `.pen`'s top badges ("Accepted by Reviewer", "Recorded run") were dropped; provenance says "n-gram fusion · recorded" instead. | Docs updated — PRD §8 | — |

### 4.6 Agent Studio

| ID | Gap | Resolution | Demo |
|---|---|---|---|
| AGT-1 | PRD P1-5 asks for a roster with a specialist detail page (soul, skills, tools, permissions). Agent Studio goes further: a profiles carousel (Dana is the default) and community profiles. An expanded card has three tabs. **Profile** shows `SOUL.md` · `IDENTITY.md` · `USER.md`, "loaded in this order at the start of every run", with token estimates. **Capabilities** shows skills, tools with their policy, and connectors. **Memory** shows memories with source and date, plus scope and typical context. | Docs updated — PRD §5.2, §8 | — |
| AGT-2 | An agent's identity is three markdown files rather than one `soul` field. The files are deliberately shown as raw markdown ("exactly what the agent loads") — the mockup's answer to CONCEPT §8.3.3's "readable, not raw YAML". | Docs updated — CONCEPT §3, ARCHITECTURE §4 | — |
| AGT-3 | A specialist's **`USER.md`** holds curated facts about the user — "Specialists get a compiled brief, not Dana's memory of you": name, timezone, wants, and when to escalate. A community agent's `USER.md` says "Dana fills in only what this role needs". The file feeds the inspector's "User preferences" section, a context channel no doc names. | Docs updated — ARCHITECTURE §7; Decide — CONCEPT A-9 | — |
| AGT-4 | Each agent has memories with provenance (e.g. Jonah's "135M baseline needs --bf16…", from Run #12). PRD §5.4 makes the memory-scope viewer a non-goal, and ARCHITECTURE cuts the memory tables. | Docs updated — PRD §5.4 (static mock, no write path); promotion rules still open (CONCEPT §12) | — |
| AGT-5 | Dana's memories cite "Calendar", and her `USER.md` mentions meetings and a morning digest. That implies a calendar connector no doc mentions. | Docs updated — flavour, out of scope | — |
| AGT-6 | **Community profiles** (Nadine, Yuki, Bea, Nikhil, Rosa) carry author handles and install counts, and "Add to your agents" moves one in with empty memory. No doc covers this: templates are [OPEN] in CONCEPT §3 and a PRD non-goal. | Decide — CONCEPT A-5 | — |
| AGT-7 | Model/harness is never displayed, though CONCEPT §3 and §7 make it part of an agent and of its proposal card. Several agents have no model in the data. | Build | Low |
| AGT-8 | Lifecycle appears only as origin pills ("Created in chat · today", "Seeded", "From @author"). There's no Active / Paused / Retired state and no "save as template" (CONCEPT §7, [OPEN]). | Docs updated — CONCEPT §8.5 | — |
| AGT-9 | **Create agent**, **Create team** and **Create organization** are unwired; creation happens in chat (CONCEPT §8.1.3). | Decide (recommend: open a Dana session pre-filled with "I need a new …") | Low |
| AGT-10 | The profile sheet's "Edit in Agent Studio" links to `/agents` instead of `/agents?agent=<id>`. | Fix mock | Low |
| AGT-11 | You can chat only with Dana, Jonah, Megan and Carlos — not with Elliot, Sana or the Product Team. | Decide with CHAT-2 | — |

### 4.7 Teams

| ID | Gap | Resolution | Demo |
|---|---|---|---|
| TEAM-1 | No PRD screen covers Teams (only CONCEPT §8.2 mentions it). The mockup lists your teams (Research — Active, "Created in chat · today"; Product — Idle, "Seeded") and community teams (Trip Crew, Launch Squad, Money Desk). An expanded team has three tabs. **Members** shows each agent's duty on this team, a Lead badge and "Also on …". **Workflow** shows the stages. **Runs** shows each run's status, a "Recorded · replay" badge and rework. | Docs updated — PRD §8 | — |
| TEAM-2 | The Workflow tab is the first concrete encoding of a team operating model: stages `{label, agentIds[] (more than one = parallel), note, gate?}`, plus `criteria[]` and `reworkBudget`. ARCHITECTURE left `operating_rules jsonb` undefined. Still missing: decision rights beyond the lead and the gate, time and cost budgets, and a team-knowledge view. | Docs updated — ARCHITECTURE §4 | — |
| TEAM-3 | The Research workflow runs Plan → Prepare (parallel) → Implement → Validate → Review, with no **Synthesize** step — yet ARCHITECTURE §6 and the run lanes both have one. | Fix mock | Low |
| TEAM-4 | Adding a community team "brings its members along, with empty memories". | Decide with AGT-6 | — |

### 4.8 Organizations

| ID | Gap | Resolution | Demo |
|---|---|---|---|
| ORG-1 | PRD P1-2 and demo beat 5:15 need a dashed Research → Product edge reading "Can these results drive a real, value-driven product?", with a "Preview — not built" label. The data exists (`organizations[0].handoffs`, `preview: true`), but nothing renders it. | Build | **High** |
| ORG-2 | PRD P1-2 says the shared Coder is "shown once, linked to both". Both the `.pen` and the mockup instead draw him under each team with a `shared` tag. | Docs updated — PRD §5.2 now follows the design | — |
| ORG-3 | **Organization** is a new primitive: a name, Dana at the head, and team slots. The same team can be added again as "copy 2"; teams can be added and removed (removing keeps the team); community teams can be added; and there can be several orgs. CONCEPT has no organization, and copies blur "agents are definitions; runs are instances" (§2.4). | Decide — CONCEPT A-4 | — |
| ORG-4 | Dana sits at the head, and leads report to her: Elliot's soul says "Reports to Dana, not to you directly", and Carlos's says "After that, escalate to Dana". That makes the escalation chain explicit: member → lead → Dana → you. | Docs updated — CONCEPT §13 (elaboration) | — |
| ORG-5 | The Org view lives under Teams, behind a Teams ⇄ Organizations switch, rather than on its own screen. | Docs updated — PRD §8 | — |

### 4.9 Naming & seed state

| ID | Gap | Resolution | Demo |
|---|---|---|---|
| NAME-1 | The chat cards, Run view lanes, inspector and Report use roles with initials (Research Lead, Investigator, Coder, Validator, Reviewer). Studio, Teams, Orgs and the profile sheet use personas with portraits (Elliot, Megan, Jonah, Sana, Carlos). Underneath are two mock agent sets with different ids: role ids in `mock/agents.ts` and persona ids in `mock/studio.ts`. | Decide the display rule; Fix mock (one registry) | Med |
| NAME-2 | Proposals name a role ("Validator"); after approval Studio shows "Sana · Validator · Created in chat · today". Nothing says who picks the persona name and avatar, or when. | Decide — CONCEPT A-1 | Med |
| SEED-1 | The static data is the post-demo state: the Research Team is Active, Elliot and Sana exist, the run exists, and "n-gram fusion experiment" sits under the Engram project. DEMO-SCRIPT §5 needs a clean seed with no Research Team and no Validator. | Build (pages read the creation state); Docs updated — PRD §7, DEMO-SCRIPT §5 | **High** if Teams or Studio is opened before approval |
| SEED-2 | Persona-to-role map for the seed: Jonah = Coder, Megan = Investigator and Carlos = Reviewer exist up front; Elliot = Research Lead and Sana = Validator are created live; the Product Team is Diego (lead), Lila, Jonah (shared) and Maya. | Docs updated — PRD §7 | — |

### 4.10 Integration seams

| ID | Gap | Resolution | Demo |
|---|---|---|---|
| DATA-1 | The `src/lib/api` seam covers agents, teams, run, run events, snapshots and report, and only the Run view and Report use it. Every other screen imports `src/lib/mock/*` directly. | Docs updated — ARCHITECTURE §15 | — |
| DATA-2 | The chat runs on assistant-ui's `useLocalRuntime` with a scripted adapter. `propose_team` and `propose_specialist` are human tools, resolved by `addResult({decision: approved \| declined \| discuss})` followed by `startRun`. ARCHITECTURE instead plans Mastra's `requireApproval` with `approveToolCall` / `declineToolCall`. | Docs updated — ARCHITECTURE §5, §15 (a contract both sides honor; spike 4 maps one to the other) | — |
| DATA-3 | The args the cards render: `record_disposition {disposition, reason}` (no `considered[]`), `propose_team {kind, name, purpose, roster[{agentId, name, status}]}`, `propose_specialist {kind, name, purpose, rows[{label, value, why}]}` and `handoff_to_team {runId, teamName, summary, members[{name, state}]}`. | Docs updated — ARCHITECTURE §15 | — |
| DATA-4 | The snapshot shape adds `tools[{name, policy}]`, `lastDenied`, `notLoaded` and `note`. | Docs updated — ARCHITECTURE §4 | — |
| DATA-5 | The report is structured data (summary, results rows, caveats, provenance, made-by, artifacts, emailed), not just `artifacts.content`. | Docs updated — ARCHITECTURE §4 | — |
| DATA-6 | Tool names disagree: the inspector says `email.send` (Coder: approval; Validator: blocked) while Studio says `agentmail.send` (Sana: approval). Jonah's Studio tools leave it out, and `team.assign` appears only in Studio. | Fix mock; Docs updated — ARCHITECTURE §9 (canonical list) | Low |
| DATA-7 | ARCHITECTURE §4's event list leaves out `run.blocked`, which §6 emits. | Docs updated | — |
| DATA-8 | The repo layout differs from the plan. The root isn't a git repo; `apps/web` is its own repo (one commit plus uncommitted work); there's no `packages/`. The docs sit at the root rather than in `docs/`, and there's an `assets/` folder and a `scripts/build-sprite.sh`. | Docs updated — ARCHITECTURE §13 | — |
| DATA-9 | The actual stack is Next 16.3.8 (per `apps/web/AGENTS.md`, its APIs differ from older Next), React 19.2, assistant-ui 0.15, shadcn 4 ("radix-nova", neutral), Tailwind 4 and motion 13. | Docs updated — ARCHITECTURE §3 | — |
| DATA-10 | The avatar pipeline: `scripts/build-sprite.sh` turns an MP4 into a WebP strip plus a still (12 fps, 192 px). Dana has a 73-frame idle loop; everyone else is a still, and reduced motion shows Dana's still too. | Docs updated — ARCHITECTURE §13 | — |

### 4.11 Visual direction & behaviour

| ID | Gap | Resolution | Demo |
|---|---|---|---|
| VIS-1 | CONCEPT §12 asked for 2–3 design directions; the mockup commits to one, calm consumer. That means an animated aurora background, translucent glass panels, dotted or grid inset panels, Geist, a 🧵 mark, pixel-art portraits, motion (the portrait flies from the hero to the top bar; cards expand in place), and light and dark themes. Semantic colours: run = blue, ok = green, warn = amber, replay = purple. | Docs updated — CONCEPT §8.5 | — |
| VIS-2 | The scripted chat types on timers, so it stalls while its tab is in the background (Chrome throttles timers there). This only affects the mock; real streaming isn't timer-driven. | Docs updated — DEMO-SCRIPT §5 | Low |

### 4.12 `.pen` vs mockup

`fabric-screens.pen` has 7 frames — Assistant — proposal, Assistant — handoff, Run view, Context inspector, Report, Org view and Components — and predates the coded mockup. Where they differ, the mockup wins, except for ORG-1 and CARD-3, where the `.pen` shows what still has to be built. The `.pen` has:

- **Nav:** Assistant / Agents / Teams / Work, with an "Assistant context · 2.1k tokens" chip in the Assistant header.
- **Handoff card:** View work · Message lead · Pause, plus a rework/criteria footer.
- **Specialist card:** shows the new inbox once created.
- **Inspector:** a separate panel, opened from "Open context inspector".
- **Report:** top badges ("Accepted by Reviewer", "Recorded run") and a "Sample data (design)" label.
- **Org view:** a "Preview · team-to-team handoff not built" banner and the dashed edge with its question. There's no assistant at the head, and the Coder appears under both teams ("shared · 2 teams").
- **Naming:** role names with initials everywhere.
