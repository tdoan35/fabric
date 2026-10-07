# Fabric — Hackathon Architecture

| | |
|---|---|
| Status | Draft v0.2 — §3–§9 and §13 updated against the coded mockup (Oct 1); new §15 frontend contract |
| Scope | Demo-thin slice of `CONCEPT.md` §9. Hybrid-narrow build: Mastra as runtime; own thin router, brief compiler, context recorder; Neon for all state. |
| Legend | **[UNVERIFIED]** = assumed from docs, needs a spike. IDs in square brackets, such as [RUN-1], come from the retired gap register (`docs/MOCKUP-GAPS.md`, in git history before the post-hackathon cleanup). |

---

## 1. Design principles for this slice

1. **One source of truth: `run_events`.** The UI never talks to a workflow directly. Workers append events; the UI reads events. Live and replay are the same reader with a different clock.
2. **We record context assembly ourselves.** Mastra traces capture spans, tokens, cost estimates and tool calls, but the docs don't confirm they store exact prompts. The inspector reads our own `context_snapshots`.
3. **Every claim is enforced or labelled.** Isolation claims are backed by Sprite network policy and (if scoping works) Executor policy; otherwise the UI says "behavioral scoping".
4. **Cut without rewrite.** Each P1 item is an additive module behind an interface; removing it leaves the P0 path working.

## 2. System overview

```text
                ┌──────────────────────────────────────────────────────┐
                │ Web app (Next.js)                                     │
                │  Assistant UI chat ── tool-UI cards (proposal/handoff)│
                │  Run view (+inspector) · Report · Agent Studio · Teams│
                └──────────────┬───────────────────────▲───────────────┘
                     chat/approve│                      │ SSE: run_events (live | replay)
                ┌──────────────▼───────────────────────┴───────────────┐
                │ Server (TypeScript, Mastra embedded)                  │
                │  Main assistant agent  ── tools: search_registry,     │
                │      record_disposition, propose_team,                │
                │      propose_specialist, handoff_to_team              │
                │  Brief compiler · Context recorder                    │
                │  Team workflow (Mastra): lead → parallel → review →   │
                │      dountil(rework≤N)                                │
                │  Replay service (re-emits recorded events)            │
                └───┬─────────┬──────────┬───────────┬──────────┬──────┘
                    │         │          │           │          │
              Neon Postgres  Neon AI    Sprites     Executor   AgentMail
              (state,events, Gateway    (Coder      (tool      (inboxes,
               snapshots)    (LLM)      sandbox)    gateway)   report email)
                                            │
                                         Exa, (Kernel)
```

## 3. Stack decisions

| Layer | Choice | Why / note |
|---|---|---|
| Language | TypeScript end to end | Mastra, Assistant UI, `@fly/sprites`, `agentmail`, `exa-js` are all TS. |
| Web | Next.js 16.3 + React 19.2 + Assistant UI 0.15 + shadcn/ui 4 ("radix-nova", neutral) + Tailwind 4 + motion; Geist | **The coded mockup in `apps/web` is the UI reference**: mock data behind `src/lib/api` (§15). Cards render by tool name through `MessagePrimitive.Parts` (`tools.by_name`). Approval cards currently use assistant-ui human tool results; map them to Mastra approvals starting from `assistant-ui/mastra-hitl` (spike 4). Next 16 differs from older Next, so read `AGENTS.md` first. `docs/design/fabric-screens.pen` is the earlier design pass and is out of date. |
| Agent runtime | Mastra (agents, workflows, tool approval, observability) | `parallel`, `dountil`, `branch`, `suspend`/`resume`; agents as workflow steps. |
| DB | Neon Postgres (`@mastra/pg` for Mastra storage; own tables for Fabric) | One database. Registry is small enough to skip pgvector. |
| LLM | Neon AI Gateway via OpenAI-compatible endpoint or `@neon/ai-sdk-provider` | [UNVERIFIED: tool calling, `usage`, catalog.] See §12 spike 1. |
| Sandbox | Fly Sprites via `@fly/sprites` (`exec`, `spawn`, fs, checkpoints, network policy) | One pre-warmed Sprite with weights + corpus cached. Restore is destructive; don't rely on cloning checkpoints. |
| Search | Exa (`exa-js`), `fast`/`auto` for live start; `deep` only if latency allows (12–40 s) | |
| Email | AgentMail (`agentmail`), **websocket** for inbound (no public webhook needed) | Inbound is not in the demo path. |
| Tools | Executor (MCP endpoint / SDK) | [UNVERIFIED: per-agent scoping.] |

## 4. Data model (demo slice)

```text
agents(id, name, role, soul, skills[], tools[], model, permissions jsonb,
       status, created_from, is_seeded)
teams(id, name, purpose, lead_agent_id, operating_rules jsonb,
      completion_criteria jsonb, budgets jsonb, status)
team_members(team_id, agent_id, role_in_team)
proposals(id, kind team|specialist, payload jsonb, status pending|approved|declined,
          conversation_id, created_at)
runs(id, team_id, objective, brief jsonb, status, budget jsonb,
     recorded bool, started_at, ended_at)
run_events(run_id, seq, ts, type, actor_agent_id, payload jsonb)     -- append-only
context_snapshots(id, run_id, agent_id, step, assembled_at,
                  sections jsonb,   -- [{label, source, tokens, content_ref}]
                  total_tokens)
artifacts(id, run_id, kind, title, uri, evidence_summary, content jsonb)
dispositions(id, conversation_id, turn, disposition, considered jsonb, reason)
```

**Additions the mockup already renders (Oct 1).** `[DB]` = needed on the demo path; `[seed]` = a static seed is fine for the demo. In `agents`, `name` holds the persona (Jonah) and `role` holds the role (Coder).

```text
agents        + avatar, tagline, summary, personality, traits[],                    [DB: name, role, avatar; rest seed]
                workspace jsonb,    -- SOUL.md, IDENTITY.md, USER.md, loaded in this order every run
                connectors jsonb,   -- [{name, note, status: connected|available}]
                origin, author?, installs?, is_default
agent_memories(agent_id, text, source, created_at)                                  [seed; no write path in the demo]
memories(id mnemo:<table>:<origin>, scope personal|agent|team|run, scope_id, kind,
         text, source, importance, pinned, sensitive, event_at, created_at, forgotten_at,
         embedding vector(384), tsv tsvector generated + GIN)                       [DB: the Mnemosyne import]
                                      -- personal memory (CONCEPT §2.9). Import: scripts/import-mnemosyne.ts
                                      -- (read-only SQLite source, PII rules, bge-small embeddings). Recall:
                                      -- searchMemories weights 0.5·semantic + 0.3·lexical + 0.2·importance;
                                      -- Keep pins, Forget sets forgotten_at. Never seeded/truncated.
team_members  + duty                -- what this agent does on this team                 [DB]
teams         + tagline, origin,
                workflow jsonb,     -- [{label, agent_ids[], note, gate?}]; >1 agent = parallel; gate = review that can send work back to the lead
                criteria jsonb,     -- completion criteria as text
                rework_budget                                                        [DB]
organizations(id, name, head_agent_id)                                               [seed] [OPEN: ORG-3]
org_slots(org_id, key, team_id)            -- the mockup allows the same team twice ("copy 2")
org_handoffs(org_id, from_team_id, to_team_id, question, preview bool)               [seed]
projects(id, name)                                                                   [seed]
sessions(id, title, project_id?, agent_id, status unread|input|idle, pinned, archived, incognito,
         settings jsonb)            -- {approval_mode, model, effort, connectors[], run_target}   [seed, except the demo session]
context_snapshots + tools jsonb,    -- [{name, policy: allowed|approval|blocked}]
                    not_loaded text[], note                                          [DB]
reports(id, run_id, title, intro, summary, results jsonb, caveats text[],
        provenance jsonb, made_by text[], emailed bool)   -- or artifacts(kind='report', content)   [DB]
```

Cut from the demo: agent-scope/team-scope/run-scope memory tables (personal memory is live — the `memories` import above; the Studio Memory tab reads it), registry embeddings, capability tokens.

### Event types (`run_events.type`)
`run.started` · `step.started/finished/failed` · `agent.message` · `tool.call/result/denied` · `context.snapshot` · `handoff` · `review.verdict` · `rework.requested` · `budget.update` · `artifact.created` · `run.blocked` · `run.finished`

Mapping from the mockup: the mock writes narration as `tool.result {line, kind: "msg"}` and terminal output as `tool.result {line, kind: "term"}`. Emit narration as `agent.message` instead. The mock has no `step.failed`, `agent.message` or `run.blocked` events yet [RUN-8].

## 5. Routing and the main assistant

- The assistant is a single Mastra agent with a **small, fixed prompt** and five tools. It never sees specialists' skills or tool schemas — only compact registry descriptions from `search_registry` (a query over ~8 rows, not embeddings).
- **Disposition is the first tool call of each turn:** `record_disposition({disposition, considered[], reason})` → row in `dispositions`, chip in the UI.
- Dispositions: `handle_directly | delegate_agent | delegate_team | propose_team | propose_specialist | clarify`.
- No separate classifier (concept §4 anti-goal). Quality comes from the prompt + a handful of worked examples in the prompt, with fixtures as a demo fallback.
- In the UI the assistant is the **Dana** persona (executive assistant). Her tool list in the mockup is the five tools above.
- The `delegate_agent` disposition has no `handoff_to_agent` tool in this slice; single-agent handoff is out of scope [CARD-9].

### Proposal cards
- `propose_team` / `propose_specialist` are Mastra tools with `requireApproval: true`. When streaming, the `tool-call-approval` chunk renders as a card. The mockup renders cards by tool name through `MessagePrimitive.Parts` (§15), not `makeAssistantToolUI()`.
- **Yes** → `approveToolCall` → the tool executes (creates rows in `agents`/`teams`/`team_members`, provisions AgentMail inbox for a new specialist).
- **No** → `declineToolCall` with reason.
- **Chat about this** → decline with `reason: "discuss"`; the assistant is instructed to keep the proposal open and discuss. The proposal row stays `pending`. Once the discussion settles, Dana calls `propose_*` again with the revised payload, and the UI marks the earlier card superseded. (In the mock, the old card says "Discussing — proposal still pending" and loses its buttons, and nothing re-proposes [CARD-4].)
- Cards carry: purpose, roster with existing/new markers, tools, memory scope, restriction, lifecycle, one-line justification per default. The mock's team card shows only the roster: no purpose, workflow, budget, or defaults for the new lead [CARD-1]. The specialist card doesn't show the new inbox once it's created [CARD-3].
- UI contract: the args the cards render and the decision shape are in §15. `record_disposition` currently renders only `{disposition, reason}`; `considered[]` is stored but not shown [CHAT-13].
- [OPEN] Does `handoff_to_team` need its own approval? The mock hands off right after the Validator is approved, yet Dana's tool list marks the tool `approval` [CARD-8]. Recommendation: no — approving the team and specialist authorizes the handoff, and the handoff card shows the brief.

## 6. Delegation: brief compiler and team workflow

### Brief (input to a run)
```text
{ objective, constraints, relevant_user_preferences[], completion_criteria[],
  budget {rework: 2, time_s, tokens}, artifact_refs[] }
```
Compiled by a single LLM call with a strict output schema from (user request + team definition + a few personal preferences). It never includes the chat transcript. Recorded on `runs.brief`.

### Workflow (Mastra)
```text
lead_plan
  → parallel(
      investigator_survey,     // Exa search → survey artifact
      coder_setup,             // Sprite: env + baseline harness
      validator_prep           // independent held-out checks
    )
  → lead_synthesize            // hypothesis + eval plan
  → coder_implement            // Sprite exec, streamed
  → validator_execute
  → reviewer                   // verdict: accept | request_changes
  → branch:
       accept  → finalize (artifact + notify)
       rework  → dountil(reviewer accepts OR reworks ≥ N) → lead_synthesize …
```
- Rework budget N = 2 in the recorded run; counter emitted via `budget.update`.
- Exhaustion emits `run.blocked` with evidence (implemented, but not shown in the demo).
- Each step is an agent invocation wrapped by the **context recorder**.
- The Teams → Workflow tab renders this plan as data (`teams.workflow`): Plan → Prepare (parallel) → Implement → Validate → Review (gate). The mock leaves out `lead_synthesize`, which needs adding [TEAM-3].
- The rework loop goes back through `validator_execute`. The mock timeline skips the Validator re-run after rework. The real recording must include it, because the team's criteria say the Validator reproduces the headline number [RUN-9].

## 7. Context assembly and introspection

```ts
assembleContext({ agentDef, brief, teamKnowledge?, artifactRefs, toolPolicies })
  → { messages, sections: [{label, source, tokens, contentRef}] }
```
- One function builds every specialist's context. It writes a `context_snapshots` row and emits `context.snapshot` before the model is called.
- Sections in the UI: **Identity/soul · Task brief · Tools & policy · User preferences · Artifact references · Team knowledge** (each with token count and source).
- Main assistant gets the same treatment, so the inspector can show "Assistant: N tokens" beside "Coder: M tokens".
- **Dana's recall (MEM).** Each live turn runs `recallForDana` in the same `Promise.all` as her other reads: the newest user text is embedded with `Xenova/bge-small-en-v1.5` (384-d, q8, `cls`, normalized; the embedder is a lazy singleton warmed at server boot, ~20–50 ms warm) and `searchMemories` scores her `personal/dana` rows with `0.5·(1−cosine) + 0.3·normalized ts_rank_cd + 0.2·importance` (+ pinned boost), `forgotten_at IS NULL`, sensitive rows never served. The top ≤ 6 items render as a `## What you remember about Ty` prompt section, and count into `runs.assistant_tokens`; the handoff records Dana's own `context_snapshots` row (its **Personal memory** row is labelled `Mnemosyne · N items`). Incognito threads skip recall entirely; a recall failure never blocks a turn. Specialists never see any of it — their snapshots keep listing personal memory under **not loaded**.
- Token counts: from Gateway `usage` if present; otherwise tokenizer estimates at assembly time, flagged as estimates.
- Where the sections come from in the mockup:
  - *Soul / identity* is the agent's `SOUL.md` plus `IDENTITY.md`.
  - *User preferences* is the specialist's **`USER.md`**: a short user profile that Dana curates per specialist ("Specialists get a compiled brief, not Dana's memory of you"), shown as "personal · N items" [AGT-3].
  - *Tools & policy* is labelled with "Executor" as its source.
- The snapshot also records each tool's policy (`allowed / approval / blocked`) and a **not loaded** list (e.g. "your chat transcript · personal memory · other specialists' skills"). The inspector shows both (§4 additions).
- The UI shows two different context numbers:
  - The assistant's **base context** per turn: ~2.1k tokens of profile plus registry descriptions, shown in the Run view header and the Context tab.
  - The **session context meter** in the composer: conversation growth against the model window, with a compaction marker at 80% of 1M. It's mock math today [CHAT-9].
- The inspector can't yet open a section's text (`content_ref`) [RUN-5].

## 8. Live vs replay

- **Live:** workflow steps append to `run_events` as they happen. The web app subscribes via SSE that tails `run_events` by `(run_id, seq)`.
- **Replay:** a recorded run's events are re-emitted by the replay service with `ts` deltas divided by the speed factor (1×, 10×, 60×, or scrub-to-seq). The UI is identical except for the `Replay · Nx` badge and scrubber.
- **Recording** is just a normal live run flagged `recorded = true` after the fact; no special code path. Record it several times pre-event and keep the best (real) one.
- Replay includes streamed terminal chunks (`tool.result` payloads) so the Sprite peek animates plausibly.
- **Offline fallback:** the replay service and report need only Postgres data and static assets.
- **Speed vs run length [RUN-1].** The mockup offers 1×, 10×, 60× and scrub, and Fast-forward / `R` means 60×. The recording is 3h 12m, so a Fast-forward at t ≈ 1 min lands the Reviewer's request-changes verdict (t = 2h 35m) ~2.5 min later, and the end ~3.2 min later. The demo script allows ~10 s and ~50 s.
  - Fix: Fast-forward at **600×** with **auto-pause on each `review.verdict`**. The bounce then lands ~15 s after Fast-forward; resuming reaches the accept verdict ~4 s later.
  - Alternative: a "next event" key. Either way, keep 60× in the speed menu.
- **Live → recorded splice [RUN-2] — proposed; fills a gap.**
  - The handoff starts a new run (`recorded = false`), and its first ~45 s stream for real.
  - On Fast-forward, the Run view switches its event source to the recorded run of the same task (`recorded = true`) at the same elapsed `t`, keeps the URL on the live run, and badges `Replay · N×`. Both runs start with the same plan and parallel steps, so the lanes line up.
  - The results card and report link point to the recorded run's report.
  - Whether the live run keeps going in the background or is cancelled is decided at spike 8.
- **Badge honesty [RUN-3].** In the mockup, `?live=1` plays the recording at 1× with a `Live` badge ("live run (simulated)"), and any speed change or scrub flips it to `Replay`. With the backend, `Live` must show only while events come from a live run.
- **Lanes.** The mockup draws bars from precomputed `run.segments`. Derive them from `step.started/finished` instead, so the Run view still reads `run_events` only [RUN-7].

## 9. Isolation and tool enforcement

| Concern | Enforcement | Fallback if it fails |
|---|---|---|
| Coder can't reach arbitrary network | Sprite **network policy** (allow package index + model host only) | Label as "behavioral scoping" |
| Coder can't see credentials | Credentials never placed in the Sprite; tool calls go via server/Executor | Same |
| Tool scoping per specialist | Executor policies/keys per agent [UNVERIFIED] | Allowlist in our own tool layer; Executor for credentials and approvals |
| Personal memory not visible to specialists | Specialists get only the compiled brief | (inherent) |
| Approvals | Mastra tool approval for creation; Executor approval-gated tools | Mastra only |

The inspector shows each tool as `allowed / approval / blocked`, and one blocked call event (`tool.denied`) if enforcement works.

- **One tool registry.** Studio, the profile sheet and the inspector must use the same tool names. Today the mock calls the same capability `email.send` in the inspector and `agentmail.send` in Studio [DATA-6]. The demo set: `sprite.exec`, `workspace.write`, `artifacts.read`, `artifacts.write`, `exa.search`, `agentmail.send`, `network.fetch`, `team.assign`.
- **"Runs on" isn't part of this design.** The composer's selector (This machine / Sprite sandbox / Remote host; default This machine) has no enforcement behind it. Hide it for the demo, or default it to Sprite [CHAT-10].

## 10. Cost accounting

- Every model call goes through one wrapper that tags `{run_id, agent_id, step}` and writes token counts (from Gateway `usage` if returned, otherwise from Mastra telemetry) to `run_events`.
- Run cost = sum over events × per-model price table (kept in code; Gateway `models` endpoint returns null pricing per docs).
- Displayed as a chip in the Run view. No budget enforcement on cost in the demo; rework is the enforced bound.
- Gateway limit to remember: 200k TPM per account. Parallel steps use small models.

## 11. Failure and fallback paths

| Failure | Behavior |
|---|---|
| Model outputs malformed tool call | One bounded retry; then fixture proposal (same card UI) |
| Sprite unavailable | Live start switches to replay automatically; badge shows |
| Exa slow | Investigator step timeout → cached results from last recorded run (still labelled) |
| Gateway down | Provider fallback (env flag) for agent calls |
| AgentMail down | Skip email; chat message still delivers results |
| Everything down | Play the recorded video |

## 12. Spikes (this week) — each ends in pass/fail + notes

| # | Spike | Pass criteria | If fail |
|---|---|---|---|
| 1 | **Neon Gateway** from Mastra | Tool calling works; streaming works; `usage` present; catalog lists a fast tool-capable model; credit active | Use `@neon/ai-sdk-provider`; else other provider for tool-calling agents; token counting ourselves |
| 2 | **Sprites** from Node | `createSprite`, `spawn` with streamed stdout, write/read file, checkpoint, set network policy, measured cold start | Fall back to Sprite CLI over `child_process` |
| 3 | **Mastra workflow** | `parallel` + `dountil` + `suspend`/`resume` + Postgres persistence + `.stream()` events → `run_events` | Simplify to sequential steps with manual parallelism via `Promise.all` in a step |
| 4 | **Assistant UI cards** | Run `mastra-hitl`; convert approval → Yes/No/Chat card | Custom React cards outside tool-UI |
| 5 | **AgentMail** | Create inbox, send, receive via websocket | Send-only |
| 6 | **Executor** | Allow / approve / block one tool; per-agent scoping via separate keys | Own allowlist |
| 7 | **Exa** | `fast` search returns highlights in < 2 s; `deep` latency measured | Cache |
| 8 | **Replay** | Record a toy run; replay at 60× through the same UI component | — (must pass) |
| 9 | (P2) Kernel, Neon branch-per-run | — | Drop |

## 13. Repo layout

```text
fabric/
  AGENTS.md CLAUDE.md          # agent conventions; CLAUDE.md points at AGENTS.md
  docs/
    CONCEPT.md ARCHITECTURE.md MOBILE-PLAN.md SCHEDULE-PLAN.md SERVICES.md
    design/fabric-screens.pen  # earlier Pencil design pass
  assets/                      # source art: agent PNGs, Dana's idle MP4
  scripts/                     # dev, check:*, llm:check, memory import, Sprite setup, build-sprite.sh
  apps/web/                    # Vite + React Router SPA, also shipped inside Electron (electron/)
    src/routes/                # home · weave · work · task · run · report · agents · schedule
    src/lib/api/               # the only path to the server (mock or http, VITE_API_MODE)
    public/agents, public/dana # WebP portraits; Dana's idle and working strips
  apps/server/                 # Hono on Node: routes/ (HTTP + SSE), services/ (runtime, scheduler, splice)
  apps/mobile/                 # Expo companion app; not an npm workspace (own lockfile)
  packages/
    contracts/                 # zod schemas + types shared by web, server and mobile
    db/                        # Drizzle schema, migrations (drizzle/), RunWriter, seed
    fixtures/                  # mock data, seed profiles, recorded loops
    agents/                    # Dana (assistant/), team runtime, context/brief, llm providers, memory
    integrations/              # tools and policies: Sprites, Exa, AgentMail, Dana's browser
```

## 14. Known unknowns to close before Oct 4

- Gateway tool calling / usage (spike 1) — biggest risk.
- Whether Mastra `.stream()` events map cleanly onto our event types or need a translator.
- Exact Sprite egress policy syntax and what the model host needs.
- Whether Executor Cloud free tier is enough for the demo workspace.
- Mastra Factory reuse (skip unless spare time).
- Whether the Neon Gateway serves the models the composer offers (Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 4.5) — part of spike 1 [CHAT-8].

## 15. Frontend contract (from the mockup)

The mockup in `apps/web` defines what the backend has to feed. Today everything is mock data.

**The seam.** `src/lib/api` exposes `listAgents`, `listTeams`, `getRun`, `getRunEvents`, `getSnapshots` and `getReport`, all mocked with a 120 ms delay. Only the Run view and Report use it; every other screen imports `src/lib/mock/*` directly [DATA-1].

| Need | Mock source today | Demo plan |
|---|---|---|
| Chat stream with tool calls | `mock/chat.ts` (scripted `ChatModelAdapter`) | Mastra agent stream → assistant-ui (spike 4) |
| Run events (live and replay) | `mock/run.ts` | SSE over `run_events` (§8) |
| Context snapshots | `mock/run.ts` | `context_snapshots` |
| Report | `mock/run.ts` | `reports` or `artifacts` |
| Which agents and teams exist yet | `mock/agents.ts`, `mock/studio.ts`, `mock/teams.ts` | DB: Studio, Teams and Orgs must hide the Research Team, Elliot and Sana until they're approved [SEED-1] |
| Profiles, workspace files, memories, community catalog | `mock/studio.ts` | Seed JSON |
| Team workflows, criteria, run lists; organizations | `mock/teams.ts` | Seed JSON, with run lists from the DB |
| Sessions, projects, suggestions, session settings | `mock/sessions.ts`, `mock/suggestions.ts`, local state | Seed JSON |

**Card contract** — for each tool, the args the UI renders and the result it expects:

| Tool | Args | Result |
|---|---|---|
| `record_disposition` | `{disposition, reason}` (`considered[]` isn't rendered yet) | `{recorded: true}` |
| `propose_team` | `{kind: "team", name, purpose, roster[{agentId, name, status: new\|existing}]}` | human: `{decision: approved\|declined\|discuss}` |
| `propose_specialist` | `{kind: "specialist", name, purpose, rows[{label, value, why}]}` | human: same as above |
| `handoff_to_team` | `{runId, teamName, summary, members[{name, state}]}` | `{ok: true}` |

How the approval cards resolve:
- The human tools are listed in `unstable_humanToolNames`.
- A card calls `addResult` and then `startRun`, because the local runtime doesn't resume on its own.
- With Mastra, map `approved` → `approveToolCall`, and `declined` / `discuss` → `declineToolCall` with reason `"declined"` / `"discuss"`.

**One agent id space.** The mock has two: role ids (`lead`, `coder`, …) in `mock/agents.ts` feed the chat and Run view, while persona ids (`elliot`, `jonah`, …) in `mock/studio.ts` feed Studio, Teams and Orgs. Use one id space and display agents as "Name · Role" [NAME-1].

## 16. Scheduler (routines, SCH)

Agents also work without being asked: `schedules` holds a routine (recurrence stored as the
picker's value, derived to cron; tz-aware through croner), and `schedule_fires` holds what
actually happened at a slot. Claiming a slot is `insert … on conflict do nothing returning` on the
unique `(schedule_id, scheduled_for)`, so the tick, "Run now", "Skip" and a second server process
racing all resolve to exactly one winner — firing is idempotent by construction, not by locking.

- **The tick** (`apps/server/src/services/scheduler.ts`, disabled with `SCHEDULER=off`): every 30 s,
  each enabled schedule's slots in `(now − 10 min, now]` fire — a late tick still catches up. Slots
  older than that, unclaimed while the server was down, are claimed `missed` and never run late; the
  sweep starts at the schedule's creation, not the beginning of time.
- **Two job kinds** (`services/schedule-fire.ts`): a **team** routine goes through the same starter
  the dev route uses (`startDevTeamRun` → `startTeamJob`) — brief from the routine's prompt plus the
  team's criteria, task titled "`<routine> · <date>`" in the Routines project, run handed to the
  team runtime — so `finalizeRun` posts the results into the routine's own thread unchanged. An
  **assistant** routine is one Dana turn (`Assistant.runScheduled`): read-only tools (Exa search),
  no proposals, no handoffs — a routine never starts work behind the user's back.
- **The page** (`/schedule`) reads `GET /schedules/occurrences?from&to`: cron expanded over the
  window with fires overlaid (a fire wins its slot; "Run now" shows off-pattern; a past slot with no
  fire renders nothing). `schedule.changed` on the SSE stream revalidates it. Google Calendar and
  drag-to-create stay out of scope; the occurrences endpoint is the seam outside events merge into.
