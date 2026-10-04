# Fabric — Work Plan

| | |
|---|---|
| Status | v1.2 — Sat Oct 3, 12:00 PM PDT. **Sequential mode** (§7.0): one agent at a time, reviewed and merged by the integrator before the next starts. Defaults D1–D12 confirmed by the owner |
| Owner | Ty Thanh Doan |
| Horizon | **Phase 1:** the Oct 4 demo path on a real backend. **Phase 2:** the rest of what the mockup shows |
| Ground truth | The coded mockup in `apps/web` (Vite + React Router + Electron), read in full on Oct 2. Where `PRD.md`, `ARCHITECTURE.md` or `MOCKUP-GAPS.md` disagree with the mockup, this plan wins until OPS refreshes them (§1) |
| Still binding | `CONCEPT.md` §2 (settled decisions) · `PRD.md` §5 (P0/P1) and §10 (success criteria) · `DEMO-SCRIPT.md` §3 (beats) |
| IDs | `[CHAT-14]`-style IDs point to `MOCKUP-GAPS.md`. Workstream codes (DATA, DANA, …) are defined in §5.3 |

## TL;DR

- **FND is done** (repo under git, monorepo, contracts frozen as `contracts-v1`). The workstreams in §5.3 now run **one at a time** in the order in §7.0. Each agent works on its own branch; the integrator reviews it and merges it before writing the next agent's prompt. (The parallel-worktree setup in §7.1–§7.5 is kept for reference.)
- No spikes have run yet. Each spike belongs to the workstream that needs its answer, and **Checkpoint A (Sat 16:00)** picks the demo level (§5.4) from the results.
- **Work becomes real**: the handoff creates a real task and a live loop on the board, and Fast-forward splices the loop into a recorded run. **Weave stays seeded**, plus one real "results ready" item.
- The mock api stays as **offline mode** and as the fallback that always works (L0). No workstream may break it.
- Phase 2 (§6) turns Weave, threads, Studio editing, policies and the desktop app into real features once the demo is done.

---

## 0. How to use this plan

**Agents**

1. Read §0–§4, then your workstream in §5.3, then the doc sections it lists. Nothing else is required reading.
2. Work only in the paths you own (§3.3). If you need a change somewhere else, write it under **Requests** in your status file and pick up other work meanwhile.
3. The contracts (§4) freeze at Checkpoint 0. If you need one changed, file a request. The integrator decides and changes `packages/contracts` themselves.
4. Keep `status/<code>.md` current (template in §7.6). It holds what's done, what's next, what's blocked, spike results and requests.
5. **Don't break mock mode.** `VITE_API_MODE=mock` must keep rendering today's mockup, because it's the L0 fallback and the offline mode.
6. Commit small, rebase on `main` at every checkpoint, and never commit `.env`.

**Integrator** (you, or a lead session in the root checkout): merges at each checkpoint in the order given in §7.3, answers requests and runs the checkpoint checks in §5.5.

**In sequential mode (§7.0)**, items 2, 3 and 6 above change as described there.

---

## 1. Ground truth: where the docs have gone stale

| Topic | Docs say | The mockup today | Fix in |
|---|---|---|---|
| Web stack | Next.js 16 (`src/app`) — ARCH §2, §3, §13; PRD header | Vite 8 + React Router 8 data router: loaders in `src/router.tsx`, route components in `src/routes/`. SPA, no server rendering. `apps/web/AGENTS.md` is current | ARCH §2–3, §13; PRD header; DATA-9 |
| Desktop | — | The same build runs in a frameless **Electron** shell: `electron/main.mjs`, origin `app://fabric`, custom title bar, saved zoom. `npm run electron:dev / electron:start / electron:dist`; an AppImage is in `release/` | ARCH §3, §13 |
| Shell | Search · New session · Agent Studio · Teams · Work | Sidebar: **New thread · Weave** (amber count of open asks) **· Agent Studio · Work**. Projects, each linking to its board; Threads with presence rings. **Title-bar tabs**: each tab keeps its own location and chat. **Settings** dialog with session defaults, fonts and connectors | CONCEPT §8.5; PRD §8 |
| Teams, Orgs | `/teams` screen | Inside Agent Studio at `/agents?view=teams` and `?view=orgs`; `/teams` redirects | PRD §8; ARCH §13 |
| Runs | `/runs/[id]` | Tasks and loops: `/work`, `/work/:taskId?loop=N&live=1`. `/runs/:id` redirects to its task | ARCH §8, §15 |
| Data model | `runs(...)` belongs to a team; no task | `Task {projectId, teamId, runIds, proposal?, preview?}` → `Run`, one loop with `n`, `status` (`running · blocked · accepted · stopped`), `budget {costUsd, timeS}`, `etaS`, `reworkBudget`, `brief`, `outcome` and `segments`. `Brief` holds the criteria, the preferences and what stayed with Dana. New events: `criterion.checked`, `run.stopped` | ARCH §4 |
| API seam | 6 functions; only the Run view and Report use it | 8 functions, adding projects, tasks and runs (`src/lib/api`). Work, task and report pages load through route loaders. **Studio, Teams, Orgs, the sidebar, Weave and chat still import `src/lib/mock/*` directly** | ARCH §15 |
| Weave | CONCEPT A-11 describes the idea | Built UI. Typed inbox (approval, question, escalation, proposal, finding, result) with cost-of-delay lines, gated approvals, snooze until an event, and undo. Pulse with lead updates and diffs, events, memory Keep/Forget and policy grants. Presence and a calendar. A module-level store, where deciding an item moves its Work card (`DECISIONS` in `lib/work.ts`). **No backend design exists for any of it** | New ARCH section (phase 2, §6) |
| Chat | The Agents/Teams toggle only changes the copy [CHAT-3] | Teams mode picks one of your teams and talks to its lead ("Team chat · led by Elliot"). A final "Create a team" slot hands you to Dana. Direct chat with Jonah, Megan or Carlos still gets a placeholder reply | CHAT-3; CONCEPT A-2 |
| Replay | 1× / 10× / 60× | 1× / 60× / 600×. Fast-forward runs at 600× and pauses on each verdict [RUN-1 closed] | ARCH §8 |
| Section text | Can't be opened [RUN-5] | Sections expand, but the client rebuilds their text from the workspace files and the brief. Nothing stores it | ARCH §7: store `content` |

**Still open after Oct 2, and feeding phase 1:** CHAT-14 · ORG-1 · RUN-2 · RUN-3 · SEED-1 (now it also covers the board, Weave and the threads) · NAME-1 (the chat cards and handoff card still show roles) · CHAT-6/7/10 (Settings also defaults "Runs on" to This machine) · CARD-1/3/4/6/8 · REP-1/2 · RUN-12 · IA-5 · DATA-6 · DATA-8. Appendix A maps each one to its owner.

---

## 2. Decisions

### 2.1 From the owner (Oct 2)

1. **Phased:** phase 1 is the demo on a real backend; phase 2 is everything else.
2. **No spikes have run.** Phase 1 opens with them (§5.2).
3. **Parallel agents in git worktrees.**
4. **For the demo, Work is real and Weave is seeded.**
5. **Models (Oct 3): Spark for development, the Neon AI Gateway at the venue, OpenRouter as backup.**
   - **Development:** the DGX Spark lane (`qwen3.8-flash-next`, vLLM over the tailnet) is free, so all build and test traffic goes there.
   - **The demo:** switch to the Neon AI Gateway with the hackathon credits.
   - **Backup:** OpenRouter, the key capped at $5. Raise the cap before relying on it.
   - **Switching** is one line: `LLM_PROVIDER` in `.env`.

### 2.2 Defaults (all confirmed by the owner, Oct 3)

| # | Default | Settles |
|---|---|---|
| D1 | Agents display as "Name · Role" everywhere. Dana names a new specialist **on the proposal card**, choosing from a persona pool of existing portraits (Elliot for the lead, Sana for the validator), so nothing gets renamed after approval | NAME-1/2, CONCEPT A-1 |
| D2 | Proposals are **human tools**, the pattern the mockup already uses. Dana's turn ends on `propose_*`, and the next request carries `{decision}`. The server creates rows only for a pending proposal it stored itself. Mastra's `requireApproval` is used only if S4 turns up a reason | ARCH §5, §15 |
| D3 | Approving the team and the specialist authorizes the handoff. `handoff_to_team` has no approval of its own | CARD-8 |
| D4 | The backend is a **separate TypeScript server** (Hono, with Mastra embedded) on `:8787`. For the demo it runs locally against Neon. Both the web and Electron builds reach it only through `src/lib/api`, as `apps/web/AGENTS.md` requires | ARCH §2 |
| D5 | **Splice:** on Fast-forward the live run is cancelled, and its event log continues from the recording at the same elapsed `t`. URL, task and loop stay the live ones, and the badge reads `Replay · 600×`. Reaching the end runs the same finalize step a real finish would | RUN-2, ARCH §8 |
| D6 | **Two seed profiles:** `demo` is the pre-approval state with SEED-1 clean; `lived-in` is today's mock world, used for development and phase 2 | SEED-1 |
| D7 | The demo build (`VITE_DEMO=1`) hides group chat, Full auto, voice, the 1M context meter and the unwired Create buttons, and locks "Runs on" to Sprite | CHAT-6/7/9/10, AGT-9 |
| D8 | The root becomes one git repo. `apps/web`'s history is saved as a bundle first, then `apps/web/.git` is removed. **The owner has OK'd this** | DATA-8 |
| D9 | **The mock bundle, labelled "illustrative", is an accepted demo recording.** A real recording is a stretch goal (L3); if one isn't locked at CP-C, demo at L2 | PRD §7 |
| D10 | **The overlap trap is planted for the demo.** In the lab corpus, `data/` overlaps the eval text and `data/train_only/` doesn't, so a naive first attempt is contaminated and Sana's check can catch it. The catch is real but the setup is staged, so say so if asked | PRD §7 |
| D11 | Plan runs **alongside** Prepare, as in the mock timeline, so at least 3 members are working within the first 45 s | PRD §10.3 |
| D12 | Present in the **Electron app** (built web plus local server), with the browser as fallback | — |

---

## 3. Phase 1 architecture

### 3.1 Shape

```text
apps/web  (Vite SPA; the same build runs inside Electron)
  src/lib/api ──── mock (fixtures, offline)  |  http ──┐
  chat adapter ─── mock script               |  http ──┤
                                                        ▼  JSON + SSE, localhost:8787
apps/server  (Hono)
  routes:   chat · registry · work · runs · reports · weave · stream
  services: run writer + SSE hub · splice · finalize · recordings
       │                      │                        │
packages/agents          packages/integrations      packages/db  (Drizzle)
  llm        (Gateway)     tool registry + policy     Neon Postgres, branches:
  assistant  (Dana)        sprites · exa              production · demo · recording · ws-*
  team       (workflow)    agentmail · executor
  context    (brief, assemble, snapshots)
       │
       └──▶ Neon AI Gateway
```

### 3.2 What stays from the mockup

Nothing in the frontend is rebuilt. The server feeds the shapes it already consumes:

- `projectRun()` stays the only projection of a loop, for live and replay alike.
- `useRunClock` stays, and gains a real live source.
- `summarize()` keeps driving the board.
- The Inspector, BriefPanel, LoopStepper, Lanes and Transport stay as they are.
- Cards still render by tool name, and the human-tool approval flow stays.
- The Weave UI and its store stay.

### 3.3 Repo layout and ownership

```text
fabric/
  package.json, tsconfig.base.json, .gitignore, .env.example     FND
  WORK-PLAN.md                                                   integrator
  CONCEPT.md PRD.md ARCHITECTURE.md DEMO-SCRIPT.md MOCKUP-GAPS.md OPS
  status/<code>.md                                               each agent, its own file only
  packages/contracts/                                            FND, then integrator only
  packages/fixtures/                                             FND moves files in; DATA owns profiles/ and recordings/
  packages/db/                                                   DATA
  packages/agents/src/llm/        packages/agents/src/assistant/ DANA
  packages/agents/src/team/                                      TEAM
  packages/agents/src/context/                                   CTX
  packages/integrations/                                         TOOLS
  apps/server/src/index.ts, env.ts                               FND, then integrator
  apps/server/src/routes/chat.ts                                 DANA
  apps/server/src/routes/* (the rest), services/*                DATA
  lab/                                                           LAB (code that runs inside the Sprite)
  scripts/                                                       seed, export: DATA · record: LAB · smoke, demo: OPS
  apps/web/src/lib/api/, lib/registry.ts,
    lib/{work,run-state,use-run-clock,weave-store}.ts,
    components/{work,studio,report,weave,shell}/, routes/        UI-WORK
  apps/web/src/components/chat/, components/settings/, lib/chat/ UI-CHAT
  apps/web/vite.config.ts, electron/                             FND (port, env, CORS only)
```

`apps/web/src/lib/types.ts` and `apps/web/src/lib/mock/*` become re-export shims in FND, and nobody edits them afterwards.

---

## 4. Contracts (frozen at Checkpoint 0)

### 4.1 Shared types — `packages/contracts`

FND moves `apps/web/src/lib/types.ts` here, along with the types now defined inside mock files: `StudioTeam`, `TeamMember`, `WorkflowStage`, `Organization`, `OrgHandoff`, `Project`, `Session`, `ChatAgent`, `StudioProfile`, `AgentWorkspace`, `SpriteAvatar`, and the `InboxItem` / `PulseEntry` / `Presence` / `CalendarEvent` families. It then makes these changes:

| Type | Change | Why |
|---|---|---|
| ids | Agent ids are **persona slugs** (`elliot`, `jonah`, …) everywhere. The role ids in `mock/chat.ts` (`lead`, `coder`, …) are retired | NAME-1 |
| `RosterEntry` | + `role`, `avatar?` | D1 |
| `TeamProposal` | + `proposalId`, `workflow[]`, `reworkBudget`, `criteria[]`, `leadDefaults[{label, value, why}]`, `supersedes?` | CARD-1, CARD-4 |
| `SpecialistProposal` | + `proposalId`, `persona {id, name, role, avatar}`, `supersedes?` | D1, CARD-4 |
| `HandoffPayload` | + `taskId`; members become `{agentId, name, role, state}` | NAME-1 |
| `ResultsPayload` | **new**, args of the `post_results` part: `{reportId, runId, taskId, title, summary, rows}` | CHAT-14 |
| `record_disposition` args | + `considered?: string[]` (stored, not rendered) | CHAT-13 |
| `Task` | + `recordingKey?`, `sessionId?` (the thread it came from) | D5, CHAT-14 |
| `Run` | + `recording? {key, kind: "real" \| "illustrative", spliceT?}` | D5, REP-2 |
| `ContextSection` | + `content?`, `estimated?` | RUN-5 for real |
| `ContextSnapshot` | + `sandbox?` (replaces the hardcoded `SANDBOX` map in the inspector) | — |
| `Report` | + `setup? [{label, value}]`, `artifacts[].id?`, `kind: "real" \| "illustrative"` | REP-1, REP-2 |
| `StudioProfile` | + `status: "active"`, `inbox?` | SEED-1, CARD-3 |
| `ToolName` | **new** canonical union: `sprite.exec · workspace.write · artifacts.read · artifacts.write · exa.search · agentmail.send · network.fetch · team.assign` | DATA-6 |
| `RunEventPayloads` | **new**: a payload type per event (§4.5), with zod schemas | — |
| `AppEvent` | **new** (§4.4) | — |

### 4.2 HTTP API — `apps/server`

| Method | Path | Returns | Owner |
|---|---|---|---|
| GET | `/api/health` | `{ok}` | FND |
| GET | `/api/registry` | `{agents, communityAgents, teams, communityTeams, organizations, projects, sessions, personaPool}`. Active agents and teams only | DATA |
| GET | `/api/projects` · `/api/tasks` · `/api/tasks/:id` · `/api/runs` · `/api/runs/:id` | The shapes `api.*` returns today. `Run.segments` is derived from step events [RUN-7] | DATA |
| POST | `/api/projects` `{name, goal}` | `Project`, with the id slug rule of the mock's `createProject`; emits `registry.changed` (added Oct 3: the Work index's New project dialog uses it) | DATA |
| GET | `/api/runs/:id/events` | `RunEvent[]`; the merged log if the run was spliced | DATA |
| GET | `/api/runs/:id/stream?after=<seq>` | SSE, `event: run`, data is a `RunEvent` | DATA |
| GET | `/api/runs/:id/snapshots` | `ContextSnapshot[]` | DATA |
| POST | `/api/runs/:id/splice` `{t}` | `{run, events}`, the spliced run and its merged log | DATA |
| POST | `/api/runs/:id/finalize-splice` | `{reportId}`; idempotent | DATA |
| GET | `/api/reports/:id` · `/api/artifacts/:id` | `Report` · the file | DATA |
| GET | `/api/weave` | `{items, pulse, presence, calendar}` | DATA |
| GET | `/api/stream` | SSE of `AppEvent`s (§4.4) | DATA |
| POST | `/api/chat` `{sessionId, messages, fixture?}` | NDJSON stream (§4.3) | DANA |
| GET | `/api/sessions/:id/messages` | Thread history, including results messages | DANA |

CORS allows `http://localhost:<web port>` and `app://fabric`.

### 4.3 Chat stream

- **Format:** NDJSON, one line per update. Each line is `{content: Part[]}`, a cumulative snapshot of the assistant message. These are the same objects `mockAssistant` yields today, so the web adapter is a thin reader.
- **Parts:** `text`, and `tool-call {toolCallId, toolName, args, result?}`.
- **Server-executed tools** (`record_disposition`, `handoff_to_team`, `post_results`) arrive with `result` set.
- **Human tools** (`propose_team`, `propose_specialist`) arrive without a result and end the turn. The next request carries `{decision: approved | declined | discuss}` as their result.
- `search_registry` is internal and never streamed.
- `fixture: true`, or the header `x-fabric-fixture: 1`, runs scripted Dana for that turn. It uses the same stream and has the same side effects [RUN-12].
- S4 may swap the format for an AI SDK UI stream if that turns out simpler. It's the only part of §4 a spike can change.

### 4.4 App stream (invalidation only)

`registry.changed` · `task.changed {taskId}` · `run.changed {runId}` · `weave.changed` · `session.message {sessionId, messageId}`. Clients refetch what changed; the events carry no data.

### 4.5 Run events

`t` is seconds since `runs.started_at`, and `seq` increases per run. The server stamps both.

| Type | Payload | Emitted by |
|---|---|---|
| `run.started` | `{objective}` | DATA (`startRun`) |
| `step.started` / `step.finished` | `{label, stage, kind: work \| rework \| bounce \| wait \| blocked}` | TEAM |
| `agent.message` | `{text}` (narration) | TEAM |
| `tool.call` | `{tool, summary}` | TOOLS |
| `tool.result` | `{line, kind: "term"}` (terminal output, line-buffered) | TOOLS |
| `tool.denied` | `{tool, target, reason}` | TOOLS |
| `context.snapshot` | `{snapshotId}`, emitted **before** the model call | DATA (`saveSnapshot`) |
| `handoff` | `{to, step?}` | TEAM |
| `review.verdict` | `{verdict: accept \| request_changes, text}` | TEAM |
| `rework.requested` | `{to, used, budget}` | TEAM |
| `criterion.checked` | `{index, pass, note}` | TEAM |
| `budget.update` | `{reworkUsed?, reworkBudget?, costUsd?}` | TEAM |
| `artifact.created` | `{name, artifactId}` | TOOLS / TEAM |
| `run.blocked` | `{reason, itemId?}` | TEAM |
| `run.stopped` | `{by, text}` | DATA |
| `run.finished` | `{reportId}` | DATA (`finalizeRun`) |

### 4.6 Backend module interfaces

FND wrote these as stubs that throw `NotImplementedError`, so every package compiles from CP-0. The code in `packages/*/src` is the authoritative version; this is a summary.

```ts
// packages/db — DATA. The server constructs it with an onEvent hook wired to the SSE hub,
// and end() triggers finalizeRun inside the server. Packages never import apps/server.
interface RunWriter {
  createTask(i: { projectId: string; teamId: string; title: string; sessionId?: string; recordingKey?: string }): Promise<Task>;
  startRun(taskId: string, brief: Brief, budget: { costUsd: number; timeS: number; rework: number }): Promise<Run>;
  emit<T extends RunEventType>(runId: string, type: T, actor: string | undefined, payload: RunEventPayloads[T]): Promise<RunEvent>;
  saveSnapshot(s: Omit<ContextSnapshot, "id">): Promise<ContextSnapshot>;   // also emits context.snapshot
  saveArtifact(runId: string, a: { name: string; by: string; content: Uint8Array | string }): Promise<{ id: string }>;
  end(runId: string, status: "accepted" | "blocked" | "stopped", outcome?: string): Promise<void>;
}
finalizeRun(runId: string): Promise<void>;          // apps/server/services — DATA

// packages/agents/src/llm — DANA
model(modelId: string): LanguageModel;               // AI SDK model via Neon AI Gateway; fallback by env
meter(ctx: { runId?: string; agentId: string; step?: string }): UsageSink;   // tokens + cost per call

// packages/agents/src/context — CTX
compileBrief(i: BriefInput): Promise<Brief>;        // BriefInput has no transcript field, by design
assembleContext(i: AssembleInput): Promise<{ system: string; snapshot: Omit<ContextSnapshot, "id"> }>;
countTokens(text: string): { tokens: number; estimated: boolean };

// packages/agents/src/team — TEAM. Stateful pieces are factories; services/runtime.ts (DATA) wires them once.
createTeamRuntime(deps: { writer: RunWriter }): { startTeamRun(runId): Promise<void>; cancelRun(runId): Promise<void> };

// packages/agents/src/assistant — DANA
createAssistant(deps: { writer: RunWriter; team: TeamRuntime }): {
  chat(req: ChatRequest): AsyncIterable<ChatStreamLine>;   // POST /api/chat
  history(sessionId: string): Promise<SessionMessages>;
  postResultsMessage(sessionId: string, p: ResultsPayload): Promise<void>;
};

// packages/integrations — TOOLS
toolsFor(agent: StudioProfile, ctx: { runId: string; step: string; writer: RunWriter }):
  { tools: Partial<Record<ToolName, Tool>>; policies: { name: ToolName; policy: ToolPolicy }[]; sandbox?: string };
createInbox(agentId: string): Promise<string>;
sendReportEmail(report: Report, to: string): Promise<void>;
```

### 4.7 Database (DATA owns; others ask for columns)

`agents` (persona, role, avatar, model, workspace jsonb, skills, tools jsonb with policies, connectors, origin, status, is_seeded, author, installs) · `agent_memories` · `persona_pool` · `teams` (workflow jsonb, criteria, rework_budget, status, origin) · `team_members` (duty, lead) · `organizations` · `org_slots` · `org_handoffs` · `projects` · `sessions` · `messages` · `dispositions` (considered jsonb) · `proposals` (kind, payload, status `pending | approved | declined | superseded`, session_id, tool_call_id) · `tasks` · `runs` (n, status, brief, budget, rework_budget, assistant_tokens, outcome, report_id, cost_usd, eta_s, recorded, recording_key, recording_kind, spliced_from_run_id, splice_t) · `run_events` (append-only, unique `(run_id, seq)`) · `context_snapshots` (sections jsonb, including `content`) · `artifacts` · `reports` · `weave_items`. Mastra's own storage lives in a separate `mastra` schema.

### 4.8 Seed profiles

| Entity | `demo` (before approval) | `lived-in` (today's mock world) |
|---|---|---|
| Agents | Dana, Jonah, Megan, Carlos, Diego, Lila, Maya, plus the 5 community profiles. **No Elliot or Sana** | All of them |
| Persona pool | Elliot (lead), Sana (validator) | — |
| Teams | Product Team (idle) | Research Team and Product Team |
| Org "Ty's Lab" | Product Team slot only. A new team joins on creation; the Research → Product edge shows once both exist | As today |
| Projects | Engram on small models, Product exploration, **with no tasks** | Plus the 4 tasks and 4 loops |
| Threads | The rows that don't involve Elliot or the Research Team (drop `p1`, `s9`) | All |
| Weave | Only items whose agent and task exist. An empty inbox is fine | All |
| Recordings | `ngram-135m`: the mock 135M loop as an `illustrative` bundle, replaced by the real one at CP-C | The same loop, attached to its task |

### 4.9 Env, flags and ports

- **Server:** `DATABASE_URL`, `DATABASE_URL_UNPOOLED` (for migrations) and `NEON_BRANCH`, which `neon link` writes. `NEON_AI_GATEWAY_BASE_URL` and `NEON_AI_GATEWAY_TOKEN`, using Neon's names so Mastra's `neon/<model>` and `@neon/ai-sdk-provider` read them with no config. `OPENROUTER_API_KEY`, the name Mastra's `openrouter/<model>` reads by default. Our own names: `LLM_PROVIDER=spark|openrouter|neon`, `SPARK_BASE_URL`, `SPARK_API_KEY` (the server doesn't enforce it; the tailnet is the boundary), `SPARK_MODEL`, `SPRITES_TOKEN`, `SPRITE_CODER`, `SPRITE_VALIDATOR`, `EXA_API_KEY`, `AGENTMAIL_API_KEY`, `EXECUTOR_URL`, `EXECUTOR_KEY`, `PORT`, `CORS_ORIGINS`, `DANA_MODE=live|fixture`, `FEATURE_AGENTMAIL`, `FEATURE_EXECUTOR`, `DEMO_RECORDING_KEY=ngram-135m`, `OWNER_EMAIL`.
- **Web:** `VITE_API_MODE=mock|http`, `VITE_API_URL`, `VITE_DEMO=0|1`, `VITE_PORT`.
- **Ports per worktree:** with index `n` (FND/main 0, DATA 1, DANA 2, TEAM 3, CTX 4, TOOLS 5, LAB 6, UI-CHAT 7, UI-WORK 8, OPS 9), the web runs on `3000+10n`, the server on `8787+10n` and headless Chrome debugging on `9333+n`.
- **Neon:** project `fabric` (`solitary-meadow-39146227`, aws-us-east-2); the default branch is **`production`** (Neon's name; git's integration branch is still `main`). DATA, DANA and TEAM each get a branch (`ws-data`, `ws-dana`, `ws-team`). Recording uses `recording`; the demo uses `demo`, which `npm run demo:reset` restores. The UI agents use mock or fixture data and need no branch. Until DATA creates the branches, everyone shares `production`.

---

## 5. Phase 1 — the demo on a real backend

### 5.1 Timeline and checkpoints (PDT)

Re-based on Oct 3 because work starts Sat ~11:00 instead of Fri evening. The schedule now uses Sunday's hacking hours (10:30–16:30, pre-building disclosed) and moves the freeze to Sunday. Agents keep working overnight on anything that doesn't need you; requests queue until you're back.

| When | Checkpoint | Gate |
|---|---|---|
| Sat 11:00 | **Kickoff** | `.env` filled in with every key. FND starts. Within ~15 min FND's baseline commit exists, and the spike and LAB agents branch from it (§7.1) |
| Sat ~12:30 | **CP-0 Contracts** | FND merged and tagged `contracts-v1`. Every agent rebases and starts its build tasks |
| Sat 16:00 | **CP-A Spikes** | Every spike is reported pass/fail in a status file. Pick the target level (§5.4) and lock the fallbacks |
| Sat 23:00 | **CP-B Live path** | End to end on the real backend: chat → two approvals → handoff → a live loop with ≥3 members streaming, in Electron too. Recording attempts run overnight (stretch, D9) |
| Sun 9:00–10:30 | Venue | Keys and credits verified at the venue, smoke test re-run (PRD §12) |
| Sun 12:00 | **CP-C Lock** | The bundle is chosen: real if one exists, otherwise illustrative (D9). Smoke test passes 3× in a row. Offline mode plays the bundle |
| Sun 14:30 | **Freeze** | 3 timed rehearsals. Fallback video recorded. Submit before 16:30 |

### 5.2 Spikes

These follow ARCH §12's numbering, plus S0 and S-LAB. Each one ends with pass or fail and notes in the owner's status file by CP-A.

| # | Spike | Owner | Pass | If it fails |
|---|---|---|---|---|
| S0 | Neon Postgres, Drizzle migrations, branches | DATA | Migrate and seed a fresh branch in under a minute | — (must pass) |
| S1 | Model providers from Mastra (§2.1 item 5) | DANA | **Spark** (checked by the integrator, Oct 3): a forced tool call takes 3.6 s; streaming gives a first chunk in 0.4 s, delivers the tool call in pieces and reports `usage`. Routing is correct at every thinking level: off (`enable_thinking: false`) 4.8 s, `medium` 5.9 s, `low` 14.3 s, default `xhigh` 55 s. So Dana runs with thinking off and specialists start at `medium` (thinking controls are in DANA step 1). The lane allows only 8 requests at once. Still for DANA to verify: the same through Mastra's agent loop. **OpenRouter:** key valid, every mock model listed with tools, `usage.cost` returned. **Neon Gateway:** needs a paid plan or the hackathon credits; check `GET /v1/models` at the venue and request any missing model | Spark down → `LLM_PROVIDER=openrouter`. Gateway not enabled at the venue → stay on Spark (reachable over the tailnet) or OpenRouter, and drop the Gateway claim from the deck |
| S2 | Sprites from Node | TOOLS | The integrator already created `fabric-coder` and `fabric-validator` (org `ty-thanh-doan`) and confirmed the token through the REST API. Use the `@fly/sprites` SDK to attach to them, stream `exec` output, use its filesystem, and have the egress policy block a fetch. Cold start measured | Sprite CLI over `child_process` |
| S3 | Mastra workflow | TEAM | Parallel steps, a rework loop, cancel, and `.stream()` events mapped onto run events | Plain async orchestration (`Promise.all` plus a loop), which is fine for the demo |
| S4 | Chat stream ↔ assistant-ui | UI-CHAT with DANA | The NDJSON adapter renders the cards, and a human result round-trip creates rows | Scripted Dana for the card turns |
| S5 | AgentMail | TOOLS | Create an inbox and send mail. The organization-wide key is in place and checked (3 inboxes allowed, 1 used; 100 sends a day); see TOOLS step 5 | Send-only from `ty-8132`, or off (P1) |
| S6 | Executor | TOOLS | Allow, approve and block one tool, per agent. **Found by the integrator, Oct 3:**<br>• Executor Cloud is one MCP endpoint (`EXECUTOR_URL`), already in `.mcp.json` for the coding agents.<br>• Sign-in is **OAuth only** (`signin.executor.sh`, scopes include `offline_access`, bearer header); the docs list no static API keys.<br>• Policies are **per tool**, not per agent.<br>• For the server, either complete OAuth once and keep the refresh token in `EXECUTOR_KEY`, or run Executor locally (CLI or Docker) and point the server at that.<br>• Best fit: Executor holds the Exa and AgentMail keys and puts `agentmail.send` behind approval; per-agent rules stay in our own allowlist | Our own allowlist, labelled "behavioral scoping" (ARCH §1.3) |
| S7 | Exa | TOOLS | `type: "fast"` search with `contents: {highlights: true}` returns in under 2 s (request shape from the `build-with-exa` skill). **Key checked by the integrator, Oct 3:** `fast` 0.37–0.56 s, `auto` 1.8 s, $0.007 per search, and the demo queries return the Engram paper and NAND-inference papers. What's left for TOOLS is the tool wrapper and the narration lines | Cached results |
| S8 | Live tail | DATA with UI-WORK | An event appended on the server shows in the loop view within 1 s over SSE, in the browser and from `app://fabric` | Poll every second |
| S-LAB | The experiment in a Sprite | LAB | Baseline and fused perplexity for the ~135M model, computed end to end in under 10 min. The overlap check works | Smaller eval set or table; failing that, the illustrative bundle (L2) |

### 5.3 Workstreams

Each section can be pasted into an agent as its brief.

---

#### FND — Foundation (blocking, ~1.5 h, runs first)

**Mission:** one repo, one workspace, frozen contracts and compiling stubs, so the agents can work in parallel without colliding.
**Owns:** root config, `packages/contracts/`, the initial move into `packages/fixtures/`, scaffolds for `packages/{db,agents,integrations}`, the `apps/server` skeleton, and the port/env/CORS lines in `apps/web/vite.config.ts` and `electron/`.
**Reads:** this plan, §1–§4.

1. **Git (D8).** Commit `apps/web`'s pending work in its own repo and run `git bundle create ../../apps-web-history.bundle --all`. Then, with the owner's OK, remove `apps/web/.git`, run `git init` at the root, and write a `.gitignore` covering `node_modules`, `dist`, `release`, `.env*`, chrome profiles and `*.AppImage`. Commit the baseline as "mockup, Oct 2".
2. **npm workspaces** for `apps/*` and `packages/*`, with one root lockfile. Add root scripts `dev` (server and web together), `typecheck`, `test`, `lint`, `seed`, `smoke`.
3. **`packages/contracts`:** move the types and apply §4.1. Add zod schemas for the API payloads and `RunEventPayloads`. Leave `apps/web/src/lib/types.ts` as a shim that re-exports from the package.
4. **`packages/fixtures`:** move the data-only mock modules (`run`, `work`, `teams`, `studio`, `assistant`, `sessions`, `weave`, `suggestions`, plus the proposal objects from `chat`). Leave shims at the old paths. `options.ts` stays in the web app because it imports icons.
5. **Scaffolds** for `packages/db`, `packages/agents` and `packages/integrations`, exporting the §4.6 interfaces as stubs.
6. **`apps/server`:** Hono app with `env.ts` (zod; every integration optional behind a flag), CORS (§4.2), `/api/health`, and every route in §4.2 mounted from a per-owner file that returns 501 for now. Dev command runs `tsx watch`.
7. `vite.config.ts` reads `VITE_PORT`. Add `.env.example` and `status/README.md` with the template from §7.6.

**Status:** done Sat Oct 3 (tag `contracts-v1`). `npm run electron:dev -w web` was not re-run headlessly; check it when you restart your session.

**Done when:** `npm i && npm run typecheck && npm run build -w web` passes; `npm run dev` serves the unchanged mockup on :3000 and `/api/health` on :8787; `npm run electron:dev` still works; `contracts-v1` is tagged.

---

#### DATA — Database, run log and read APIs

**Mission:** own the state. That covers Postgres and seeds, the append-only run log and its live tail, the read models the UI consumes, splice and finalize, and the invalidation stream.
**Owns:** `packages/db/`, `packages/fixtures/src/{profiles,recordings}/`, `apps/server/src/routes/{registry,work,runs,reports,weave,stream}.ts`, `apps/server/src/services/*`, `scripts/seed.ts`, `scripts/export-recording.ts`.
**Reads:** ARCH §4, §8; PRD §7; §4.2–§4.8 here.
**Spikes:** S0, S8.

1. The Neon project exists: `fabric` (`solitary-meadow-39146227`, aws-us-east-2, Postgres 18), default branch `production`. Write the Drizzle schema for §4.7 and run migrations on `production` with `DATABASE_URL_UNPOOLED`, then create the branches in §4.9 (`neon branches create …`). The free plan allows 10.
2. `npm run seed -- --profile demo|lived-in --branch <name>`: an idempotent reset built from the fixture profiles (§4.8). Seed Dana's tool list without an approval on `handoff_to_team` [CARD-8].
3. **RunWriter** (§4.6). The next loop number per task; `seq` and `t` stamping; an in-process pub/sub hub feeding SSE; cost accumulated from `budget.update`.
4. **Read models** for every GET in §4.2, validated against the contracts in tests. **Derive `segments`** from step events [RUN-7], with a unit test that the 135M fixture's derived segments equal its precomputed ones.
5. **SSE:** `/api/runs/:id/stream?after=` and `/api/stream`.
6. **Recordings:** export a run with its events, snapshots, artifacts and report to `packages/fixtures/src/recordings/<key>.json`, and import that file as `recorded = true` with no task. Convert the mock 135M loop into the first bundle (`kind: "illustrative"`), so splice works before any real recording exists.
7. **Splice (D5):** `POST /splice {t}` finds the recording through the task's `recordingKey`, calls `cancelRun`, and sets `spliced_from_run_id` and `splice_t`. From then on, `GET events` returns the live events up to `t` followed by the recording's events after `t`, re-stamped with the live run's id; `durationS` becomes the recording's, and `recording` is set.
8. **`finalizeRun(runId)`** runs after a real finish (triggered by `RunWriter.end`) or a spliced one (`/finalize-splice`). It's idempotent. It sets the final status from the last verdict, attaches the report (copied from the recording when spliced) and emits `run.finished`. It adds a Weave `result` item, calls `postResultsMessage` (DANA) and, if enabled, `sendReportEmail` (TOOLS). Finally it emits `task.changed`, `weave.changed` and `session.message`.
9. **Registry:** `GET /api/registry` returns active rows only, and emits `registry.changed` on writes.

**Done when:** S0 and S8 pass; both seed profiles load; every GET passes contract tests, with `lived-in` matching today's mock data; an API script can create a task, stream events, splice and finalize against the illustrative bundle.

---

#### DANA — Main assistant and chat backend

**Mission:** Dana for real. She routes each turn with a recorded disposition, proposes minimal specialists and teams, creates them only on your yes, hands off a brief and tells you when results land.
**Owns:** `packages/agents/src/{llm,assistant}/`, `apps/server/src/routes/chat.ts`.
**Reads:** CONCEPT §2, §4, §7; ARCH §5, §10, §15; DEMO-SCRIPT beats 0:45–2:30; `apps/web/src/lib/mock/chat.ts`, which is the script and the fixture.
**Spikes:** S1, plus the server half of S4.

1. **`llm`:** one model factory over three providers, chosen by `LLM_PROVIDER`. Each agent row keeps its intended model (Sonnet 5.5, Haiku 4.5, Opus 5.5), and `model(id)` maps it per provider:
   - **`spark`:** every agent gets `SPARK_MODEL`. Thinking controls on this lane (probed Oct 3):
     - **Off:** only with `chat_template_kwargs: {enable_thinking: false}`. Zero reasoning tokens.
     - **Levels:** top-level `reasoning_effort` set to `low` or `medium`, where medium is the model's own default instruction. `high` and `max` alias to `xhigh`, the template's default, which is verbose and slow.
     - **Never send `"none"`.** Inside `chat_template_kwargs` it returns HTTP 400. At the top level vLLM happens to accept it, but that's undocumented.
     - `preserve_thinking` (on by default) only re-injects reasoning from earlier user turns, so leave it as it is.
     - **Starting defaults** (tune them in S1): Dana off; specialists `medium`; no `xhigh` anywhere on the live-start path. Single samples on the routing prompt: off 4.8 s, medium 5.9 s, low 14.3 s, `xhigh` 55 s.
     - Phase 2: the composer's effort picker (Low / Medium / High / Extra high) maps onto `low` / `medium` / `xhigh` (CHAT-8).
   - **`openrouter`:** `anthropic/claude-sonnet-5.5` and so on.
   - **`neon`:** the Gateway catalog ids (read `/v1/models`).

   A `meter` wrapper tags every call with `{runId, agentId, step}` and reports tokens and cost. OpenRouter returns `usage.cost`; Spark costs $0; the Gateway's price comes from a table in code (ARCH §10). The inspector and report show the model that actually ran, not the intended one.
2. **Dana:** a small fixed prompt built from her workspace files in the DB, plus a few worked routing examples. Tools: `record_disposition`, which must be the first call of every turn (retry once if it's missing), `search_registry` (internal), `propose_team`, `propose_specialist`, `handoff_to_team`.
3. **`POST /api/chat`**, streaming §4.3. Persist sessions and messages, so a reload restores the thread (`GET /api/sessions/:id/messages`). Store `considered[]` [CHAT-13].
4. **Proposals:** on `propose_*`, store a `proposals` row. The payload carries the persona from the pool (D1), purpose, workflow, budget, criteria and lead defaults [CARD-1]. Then act on the decision:
   - `approved` creates the `agents`, `teams` and `team_members` rows, adds the team to the default org, creates the specialist's AgentMail inbox through TOOLS [CARD-3] and emits `registry.changed`.
   - `declined` marks the proposal declined.
   - `discuss` keeps it pending while Dana talks it through. A re-proposal sets `supersedes`, and the old row becomes `superseded` [CARD-4].
5. **Handoff:** `handoff_to_team` calls `compileBrief` (CTX), then `createTask` with the session's project (or Engram), `sessionId` and, in the demo, `recordingKey = DEMO_RECORDING_KEY`. It then calls `startRun` and `startTeamRun` (TEAM) and returns a `HandoffPayload` with personas.
6. **Fixture mode:** port the `mock/chat.ts` script to the server, with the same stream and the same real side effects (rows, task, run). Turn it on with `DANA_MODE=fixture` or per request [RUN-12]. The decline branches stay as scripted [CARD-5].
7. **`postResultsMessage`** appends an assistant message with a `post_results` part to the thread and emits `session.message` [CHAT-14].

**Done when:** S1 passes or a fallback is chosen; the demo conversation works 5 out of 5 times against the real model at low temperature, and identically in fixture mode; the DB shows nothing created before approval; a handoff starts a run that TEAM executes; the results message lands after finalize.

---

#### TEAM — Team workflow runtime

**Mission:** the Research Team actually runs. It works in parallel where it can, bounded by the rework budget, and every step writes the events the loop view already knows how to draw.
**Owns:** `packages/agents/src/team/`.
**Reads:** CONCEPT §5; ARCH §6, §11; `packages/fixtures` (`run.ts`, `teams.ts`), whose 135M timeline is the target shape.
**Spikes:** S3.

1. A **specialist factory** that builds an agent from its DB row: model, tools from TOOLS `toolsFor`, and the system prompt from CTX `assembleContext`.
2. A **data-driven workflow** that reads `teams.workflow`. Research Team stages are Plan, then Prepare (Megan, Jonah and Sana in parallel, with Plan running alongside per D11), then Synthesize, Implement, Validate and Review (the gate).
   - **Rework:** a bounce goes to Re-plan, then Implement as rework, then a Validate re-check, then Review again, up to `reworkBudget` times [RUN-9].
   - **Exhaustion:** `run.blocked` with the evidence attached.
   - Only the Research Team needs to be verified in phase 1.
3. **Events** go through `RunWriter` per §4.5. Steps get `kind`. Narration becomes `agent.message`. Carlos's verdict is structured output. Sana and Carlos check criteria by index (`criterion.checked`). Artifacts are saved. A finish calls `writer.end("accepted")`, and the server runs `finalizeRun` from there.
4. **Before every step**, `assembleContext` runs and the snapshot is saved (and emitted) before the model call.
5. `cancelRun` (used by splice) and per-step timeouts. If Exa is slow, use cached results with a label (ARCH §11).
6. Usage from `meter` turns into `budget.update {costUsd}`.

**Done when:** S3 passes (or the fallback is in place); a toy task runs end to end and renders correctly in the loop view (lanes, stepper, verdict line, criteria); the live start shows at least 3 members working within 45 s; a forced bounce exercises rework, and a forced second bounce on a budget of 1 produces `run.blocked`.

---

#### CTX — Briefs and context assembly (the headline inspector feature)

> **Recommended setup (§7.4):** TEAM owns this workstream. Only run CTX as its own agent if you're using all nine.

**Mission:** make "what did this specialist actually load?" true. One brief compiler and one context assembler, both recording exactly what crossed the boundary.
**Owns:** `packages/agents/src/context/`.
**Reads:** CONCEPT §2.6, §6; ARCH §6 (Brief), §7; `components/work/inspector.tsx` (`sectionText` shows the sections the UI expects).

1. **`compileBrief`:** one LLM call with a strict output schema. It starts from the team's criteria and narrows them to the task, takes preferences from each specialist's `USER.md`, uses the fixed "stayed with Dana" list, and counts tokens. Its input type has no transcript field.
2. **`assembleContext`** returns the system prompt plus a snapshot. Sections use the mock's labels: Soul / identity, Task brief, Tools & policy, User preferences, Artifact references, Team knowledge. Each carries a source, `tokens` and **`content`**, plus `tools[]`, `notLoaded`, `note` and `sandbox`.
3. **Dana's base context** is measured with the same counter and written to `runs.assistant_tokens` (P1-3).
4. **`countTokens`:** Gateway `usage` when it's available, otherwise a tokenizer estimate flagged `estimated`.
5. **Unit tests:** a brief never contains transcript text; section tokens sum to the total; a role with no `USER.md` items gets an empty preferences section; `notLoaded` is right for each role.

**Done when:** every specialist step's snapshot shows real section text in the Inspector's Context tab, and its numbers add up.

---

#### TOOLS — Tools, sandbox and sponsor integrations

**Mission:** one canonical tool registry with policies the runtime enforces, a Sprite for Jonah and another for Sana, plus Exa, AgentMail and Executor.
**Owns:** `packages/integrations/`.
**Reads:** ARCH §3, §9, §11; PRD §9.
**Spikes:** S2, S5, S6, S7.

1. **Tool registry** of the `ToolName`s, each a factory taking `(agent, run, writer)`. `toolsFor` returns the tools, their policies and the sandbox id.
2. **Policies come from the agent row.** A blocked tool emits `tool.denied` and returns an error to the agent. An approval-only tool is denied with "needs approval" in phase 1 (it becomes a Weave ask in phase 2). Use Executor if S6 passes; otherwise our own allowlist, and say "behavioral scoping" wherever enforcement isn't real.
3. **Sprites:**
   - Attach to the two existing Sprites, `SPRITE_CODER` (Jonah) and `SPRITE_VALIDATOR` (Sana). Each has 8 CPUs, 8 GiB RAM, 99 GB disk, no GPU, and Python 3.13, Node 24 and `uv`. LAB fills them with the environment. Checkpoint before risky changes; restoring is destructive (ARCH §3).
   - `exec` streams stdout as line-buffered, throttled `tool.result {line, kind: "term"}` events.
   - The egress policy allows only the package index and model host. Verify it with a blocked fetch that emits `tool.denied`.
4. **Exa:** follow the installed `build-with-exa` skill (`.claude/skills/build-with-exa`) and use the `exa-js` SDK. Megan's tool calls `/search` with `contents: {highlights: true}` and nothing else. The one exception is `type: "fast"` on the live-start path, where latency matters; elsewhere leave the default `auto`. No `category`, domain filters, `numResults` or freshness settings unless a task needs them (the skill's main pitfall). Use `fast` search with narration lines like the mock's ("exa.search “…” · fast", "8 results · 3 highlights kept"). Cache the last results.
5. **AgentMail:** `createInbox` on specialist approval (one address format) [CARD-3], and `sendReportEmail` to `OWNER_EMAIL` at finalize (P1-1). Constraints, checked by the integrator on Oct 3:
   - **The account allows 3 inboxes and 100 sent emails a day.** The owner's inbox `ty-8132@agentmail.to` is already one of the 3.
   - **`createInbox` must be idempotent.** Use a fixed username per persona (e.g. `sana-fabric`) and look it up before creating, or every demo reset uses up another inbox.
   - **Keep `FEATURE_AGENTMAIL=off`** during development and smoke tests, so the owner's inbox doesn't fill up. Turn it on for rehearsals and the demo.
   - **`AGENTMAIL_API_KEY` is an organization-wide key** (named `fabric`, checked). The original onboarding key only covered `ty-8132` and couldn't create inboxes.
6. **Artifacts** are stored through `RunWriter.saveArtifact` (small files go into the DB).

**Done when:** spikes are reported; Jonah's terminal streams into the loop view; a blocked `network.fetch` appears in the Tools tab; Exa lines appear in Megan's lane within 10 s of the start; inbox creation and the report email work or are flagged off.

---

#### LAB — Experiment environment and the recording

**Mission:** make the real experiment run reliably inside a Sprite, then produce the recording the demo replays.
**Owns:** `lab/`, `scripts/record.ts`, and the recording bundles it exports (through DATA's exporter).
**Reads:** PRD §2, §7; DEMO-SCRIPT §4; the 135M fixture, `report` especially.
**Spikes:** S-LAB.

1. Pick and justify the base model (~135M, open weights), the cached corpus, the held-out split and, per D10, the overlap trap. Write the README section that explains how the environment is staged.
2. **Set up both Sprites**, `fabric-coder` and `fabric-validator`, with the weights, corpus, a pinned `uv` environment and the harness scripts (`build_ngram.py`, `eval.py`, an overlap check). The hardware is **CPU only: 8 cores, 8 GiB RAM, no GPU**, so evaluate the ~135M model on CPU with an eval set sized to S-LAB's budget, and keep the n-gram table on disk; 8 GiB leaves no room for it in RAM anyway. When it works, take a checkpoint on each Sprite (`sprite checkpoint create`) and record the version ids in your status file. Recording runs restore from them.
3. **After CP-B**, run `npm run record` against the `recording` branch. Repeat until a run shows a real reviewer bounce, choose the best, export it as `kind: "real"`, and check that the report's numbers come from the eval log [REP-2].
4. Provide the report's Setup data: model, corpus, n, λ, split [REP-1].

**Done when:** S-LAB passes by CP-A, and a real bundle is locked by CP-C, or the fallback in D9 has been declared.

---

#### UI-CHAT — Web chat on the real assistant

**Mission:** the chat beats in DEMO-SCRIPT play against the live server, looking exactly like the mockup.
**Owns:** `apps/web/src/components/chat/`, `apps/web/src/lib/chat/` (new), `components/settings/` (demo gating only).
**Reads:** DEMO-SCRIPT §3 beats 0:45–2:30, §5; ARCH §15; §4.1 and §4.3 here.
**Spikes:** S4 (with DANA).

1. **An `httpAssistant` `ChatModelAdapter`** that reads the NDJSON stream. Keep `unstable_humanToolNames` and the `addResult` / `startRun` flow. `VITE_API_MODE` chooses between it and `mockAssistant`.
2. **Cards:**
   - The team card gains purpose, workflow, budget, criteria and lead defaults [CARD-1].
   - Rosters, the specialist card and the handoff card show personas with portraits [NAME-1/2].
   - An approved specialist shows its inbox from the registry [CARD-3].
   - A superseded card collapses and points to its re-proposal [CARD-4].
   - The declined badge is fixed [CARD-6].
3. **Results message [CHAT-14]:** a `post_results` card ("I got the results here", with title, summary, valid rows, Open report and View loop). It's appended live on `session.message`, and restored from history on reload.
4. **Thread identity:** each thread (and tab) has a `sessionId`, and its history loads on mount. "New thread" on `/` resets the thread [IA-5].
5. A **fixture hotkey** forces scripted Dana for the next turn [RUN-12].
6. **`VITE_DEMO=1`** applies D7 [CHAT-6/7/9/10, AGT-9]. It touches chat, the composer and Settings; the Studio buttons are UI-WORK's.

**Done when:** the chat beats play live and in fixture mode with mockup-identical visuals; returning to the chat after the replay shows Dana's results message without a reload; mock mode is unchanged.

---

#### UI-WORK — Web data, Work board and loop view

**Mission:** every screen reads the real state, the loop view follows a live run and splices into the recording, and nothing shows before you approve it.
**Owns:** `apps/web/src/lib/api/`, `lib/registry.ts` (new), `lib/{work,run-state,use-run-clock,weave-store}.ts`, `components/{work,studio,report,weave,shell}/`, `routes/`.
**Reads:** ARCH §8, §15; DEMO-SCRIPT beats 2:30–6:00; PRD §10.

1. **`api`:** an `http` implementation next to `mock`, chosen by `VITE_API_MODE`, with contract checks in development. In mock mode, recordings load from `packages/fixtures/src/recordings/`, so offline mode plays the real bundle once it exists (PRD §10.5).
2. **Registry store:** hydrate it in the root loader from `GET /api/registry` and refresh it on `registry.changed`. Replace the direct mock imports (`profileById`, `studioTeams`, `organizations`, `sessions`, `projects`, `teamOf`, `teamLoopCount`, `lastLoopAt`) with registry getters. Then Studio, Teams, Orgs, the sidebar, the TeamHero and Work all reflect what has actually been created [SEED-1]. The Studio "Create …" buttons follow D7.
3. The **board and task page** refetch on `task.changed`.
4. **Live clock:** `useRunClock` gets a live source whose max is "now − startedAt", ticking, with events appended from SSE. The badge reads Live only while events come from a live run [RUN-3]. `?live=1` on a running loop is the live start, zoomed in (`laneDomain`).
5. **Fast-forward on a live run** calls `POST /splice {t}`, swaps in the returned run and events, and carries on at 600× with its pauses [RUN-2]. When playback reaches the end, it calls `POST /finalize-splice`.
6. **Inspector:** use the section `content` when present (keep `sectionText` as the fallback) and `snapshot.sandbox`.
7. **Report:** from the API, with a Setup section, artifact links, and an "Illustrative" label when `kind` says so [REP-1/2].
8. **Org view:** draw the dashed handoff edge with its question and a "Preview — not built" label [ORG-1].
9. **Weave:** hydrate the store from `GET /api/weave` and append server items, such as the result item, on `weave.changed`. Decisions stay client-side in phase 1.

**Done when:** on the demo seed, no screen shows the Research Team, Elliot, Sana or any research task before approval (PRD §10.8); after approval they appear without a reload; the loop view follows a real live run, splices and finalizes; mock mode still renders today's mockup.

---

#### OPS — Demo ops, QA and docs

> **Recommended setup (§7.4):** no separate agent. The integrator session does steps 2–4 after CP-B. Step 1 (the docs refresh) waits until after the demo.

**Mission:** prove the demo works and keep the docs honest.
**Owns:** `scripts/smoke-*.mjs`, `scripts/demo-reset.sh`, `CONCEPT.md` §8.5, `PRD.md`, `ARCHITECTURE.md`, `MOCKUP-GAPS.md`, `DEMO-SCRIPT.md`.
**Reads:** everything in §1; DEMO-SCRIPT; the browser memory recipe (headless Chrome over CDP).

1. **Docs refresh** per §1, starting at kickoff. It blocks nobody. Mark closed gaps and point the docs at this plan for implementation detail.
2. **API smoke:** `demo:reset`, then chat in fixture mode → approve → approve → handoff → stream ≥45 s, asserting at least 3 members active at once → splice → finalize. Then assert the report, Dana's results message and the task in Done.
3. **UI smoke:** headless Chrome over CDP captures each demo beat as a screenshot at every checkpoint, for both the web and the Electron build.
4. **Runbook:**
   - One-command reset.
   - Key and credit checklist.
   - Offline fallback (`VITE_API_MODE=mock`, using the real bundle).
   - Fallback video steps.
   - A rehearsal timing sheet against DEMO-SCRIPT §3.
5. **Update DEMO-SCRIPT** as features land: the org beat, the results beat, and the L-level variants.

**Done when:** the smoke tests pass 3× in a row at CP-C; the runbook has been rehearsed; the docs no longer contradict the code.

---

### 5.4 Demo levels (the cut ladder)

| Level | What's real on stage | Needs | Decide at |
|---|---|---|---|
| **L0** | Nothing. Today's mockup in mock mode, labelled | — (always ready) | Last resort |
| **L1** | Dana's routing, proposals and approvals create real rows, the handoff creates a real task, and the results message arrives after the replay. The loop replays the bundle | DANA, DATA, CTX (the brief), UI-CHAT, UI-WORK 1–3 | CP-A, if S1 or S3 fails badly |
| **L2** | L1, plus a real live start: Exa, the Sprite terminal and parallel steps for about 45 s, then a splice into the bundle | + TEAM, TOOLS, UI-WORK 4–5 | CP-B |
| **L3** | L2 with a **real** recording; the report numbers are real | + LAB | CP-C |
| **L4** | L3 plus P1s: AgentMail inbox and email, Executor policy, cost chip, org edge, Weave result item | + TOOLS S5/S6, UI-WORK 8–9 | CP-C, in PRD §5.2 cut order |

### 5.5 Verification

| Check | When | How |
|---|---|---|
| Typecheck and unit tests green | Every merge | `npm run typecheck && npm test` |
| Mock mode unchanged | Every merge | UI smoke screenshots compared with the CP-0 baseline |
| Seed clean (PRD §10.8) | CP-B, CP-C | `demo:reset`, then UI smoke over Studio, Teams, Orgs, Work, Weave and the threads before approval |
| Live path (PRD §10.2, §10.3) | CP-B | API smoke, then the chat beats by hand in Electron |
| Inspector (PRD §10.4) | CP-B | Real snapshots for Jonah and Sana, with section text |
| Fast-forward timing (PRD §10.7) | CP-C | Bounce on screen within ~15 s of FF, results within ~60 s |
| Offline (PRD §10.5) | CP-C | Network off, `VITE_API_MODE=mock`: the whole loop and the report play |
| Full script ≤ 6:30, 3× (PRD §10.1) | Freeze | Timed rehearsals |
| Sponsor claims real (PRD §10.6) | Freeze | Each claim on the deck slide maps to something visible on screen |

### 5.6 Risks (beyond PRD §11)

| Risk | Mitigation |
|---|---|
| Interfaces drift between parallel agents | Contracts frozen at CP-0, path ownership, requests through the integrator, merges at every checkpoint in a fixed order |
| The git conversion loses `apps/web` history | Bundle it first (FND step 1); remove the nested repo only with your OK |
| No real run with a bounce by CP-C (Sun 12:00) | D10's planted trap; D9 accepts the illustrative bundle (L2) |
| Electron's `app://fabric` origin breaks fetch or SSE | CORS from FND; S8 tests the Electron origin; check `electron:start` at CP-B |
| The Spark lane takes 8 requests at once and generates ~28 tokens/s, shared by every agent and every test run | UI agents develop against scripted Dana. Thinking off wherever latency matters. The 27B sglang lane on `ty-dgx-spark-2` (`:8888/v1`, `qwen3.8-27b-sglang`) is spare capacity if needed |
| The Spark lane is at home, and the venue's network or a home outage cuts it off | `LLM_PROVIDER=openrouter` (raise the $5 cap first) or `neon`. Test reaching it over the tailnet from the venue at 9:00 |
| The recording is made on Qwen but the live demo runs on the Gateway's models | Both are real runs. Show the model that actually ran in the inspector and the report, and say so if asked |
| The 135M eval is too slow on Sprite hardware | S-LAB's budget; a smaller eval set; the table stays on disk |
| Phase-2 scope creeps into phase 1 (real Weave, threads) | Out of scope by decision 2.1.4; requests for it go to §6 |
| Keys aren't available to the agents | Fill in `.env` at kickoff; each worktree copies it; never commit it |

---

## 6. Phase 2 — the rest of the mockup

This phase starts after Oct 4, when the docs are refreshed and the open amendments are decided. Each workstream reuses the phase 1 contracts and extends them.

| Workstream | Scope | Gaps / amendments | Needs |
|---|---|---|---|
| **WEAVE** — Weave backend | Asks come from real events: tool approvals (Executor or our policy layer), `run.blocked` escalations, Dana's proposals, Megan's findings, results. Deciding resumes or stops the run, and the `DECISIONS` map is retired. Pulse holds lead updates written at stage changes, memory writes with Keep/Forget into `agent_memories`, and policy grants ("allow for this run"). Presence is derived from runs; snooze until an event; calendar connector | CONCEPT A-11, A-3; IA-4 | DATA, TOOLS |
| **THREADS** — Sessions and chat modes | Threads, projects, pin/archive/delete and search persisted. Status dots driven by pending asks. Direct chat with a specialist as an explicit override, recorded as `direct · user-chosen`; team chat with a lead. Incognito semantics. Tabs persisted | CONCEPT A-2, A-8; CHAT-2, CHAT-3, CHAT-5, AGT-11 | DANA |
| **STUDIO** — Definitions and lifecycle | Create an agent, team or org through a pre-filled Dana thread. Edit workspace files, which triggers a re-proposal. Memory scopes and promotion rules. Installing from the community catalog renders a proposal card. Lifecycle states (pause, retire, template). Show model and harness | CONCEPT A-5, A-9, §7; AGT-6, AGT-7, AGT-8, TEAM-4 | DANA, DATA |
| **WORK+** — Work depth | Several teams per project; team-to-team handoffs as linked tasks (a real Product Team run); re-runs as new loops; stop and resume; time and cost budgets enforced; cost attribution from Gateway usage | CONCEPT A-12; ORG-1 (real edge) | TEAM, DATA |
| **POLICY** — Autonomy and isolation | The scope of each approval mode; per-session run targets with explicit approval for local or remote; Executor keys per agent; human-authority gates always ask | CONCEPT A-3, A-7; CHAT-7, CHAT-10 | TOOLS, WEAVE |
| **DESKTOP** — Platform | Settings persisted and applied; server URL configurable in Electron (or the server embedded in Electron); packaging for macOS and Windows; single-user auth; server deployed to Fly | — | FND |
| **ORG** — Organizations and registry | Decide what an org and a team "copy" are; better registry search; templates | CONCEPT A-4; ORG-3 | STUDIO |
| **QUALITY** — Evals and durability | Routing evals over recorded dispositions; a single-agent baseline comparison (CONCEPT §6, the honesty requirement); durable runs that survive a server restart | CONCEPT §9.2.1, §9.2.8 | TEAM, DANA |
| **MODELS** — Model and context | The model picker shows only what the Gateway serves; the context meter shows base context and history separately | CONCEPT A-10; CHAT-8, CHAT-9 | DANA |

**Decide before phase 2:** CONCEPT §13 A-2 to A-10 (only A-12 has been adopted), ORG-3, AGT-6, and whether Weave's "Always allow" scope and memory promotion rules (CONCEPT §12 Concept-4) are ready to build.

---

## 7. Running the agents

### 7.0 Sequential mode (current, from Sat Oct 3 12:00)

One agent at a time. The integrator writes the agent's prompt, the owner runs it, the integrator reviews the branch, asks for fixes if needed and merges it, then writes the next prompt. This replaces §7.1–§7.5 and, where they conflict, §0 items 2, 3 and 6.

- **Where:** the root checkout (`~/projects/fabric`), on a branch `seq/<code>` cut from the current `main`. The agent never merges or pushes.
- **Ports:** the defaults, web 3000 and server 8787. Ignore the per-worktree ports in §4.9.
- **Neon:** `production` is the development database. DATA creates only `demo` and `recording`; there are no `ws-*` branches.
- **Paths:** an agent edits the paths of its step's workstreams (§3.3) plus its status file. If the step can't be done without touching another path, it may, and says so in the status file.
- **Contracts:** additive changes (new optional fields, new schemas, new routes) are allowed, each in its own commit prefixed `contracts:` and listed under Requests in the status file for review. Anything breaking: stop and ask.
- **Later steps are stubs** that throw `NotImplementedError`. Code that calls one catches it, logs one line and carries on, so each step can be tested on its own.
- **Handoff:** `status/<code>.md` (template §7.6) plus three sections: *How to verify* (exact commands), *Deviations* from this plan, and *Notes for the next step*.

| # | Step (branch) | Covers | Effort | Unlocks | Target |
|---|---|---|---|---|---|
| 1 | DATA (`seq/data`) | DATA 1–9, plus a dev script that simulates a live run | High | S0, S8 | Sat 14:30 |
| 2 | UI-WORK (`seq/ui-work`) | UI-WORK 1–9, built against the seed and the simulated run | High | the web on the real API, seed clean | Sat 17:00 |
| 3 | LLM + CTX (`seq/llm-ctx`) | DANA step 1 (`llm`, thinking controls, `meter`) and all of CTX | High | S1 | Sat 18:30 |
| 4 | DANA (`seq/dana`) | DANA 2–7 | High | — | Sat 20:30 |
| 5 | UI-CHAT (`seq/ui-chat`) | UI-CHAT 1–6 | Medium | S4, **L1** | Sat 22:00 |
| 6 | TOOLS (`seq/tools`) | TOOLS 1–6 | High | S2, S5–S7 | Sun 0:30 |
| 7 | TEAM (`seq/team`) | TEAM 1–6 | Max | S3, **L2** | Sun 4:00 |
| 8 | LAB (`seq/lab`) | LAB 1–4 | High | S-LAB, **L3** | Sun 11:00 |
| 9 | OPS | OPS 2–4 (integrator) | — | smoke, runbook | Sun 12:00 |

LAB steps 1–2 touch only `lab/` and the Sprites, so they are the one step that can run alongside the others if the owner wants the experiment de-risked early.

### 7.1 Per-agent setup

Worktrees need a repo, so wait for FND step 1 (`git init` and the baseline commit, about 15 minutes in). The spike and LAB agents can branch from that baseline. Build agents branch, or rebase, once `contracts-v1` is tagged at CP-0.

```bash
# from the root checkout
git worktree add ../fabric-ws-data -b ws/data
cd ../fabric-ws-data && cp ../fabric/.env . && npm i
# per §4.9: VITE_PORT=3010 PORT=8797, Neon branch ws-data
```

Once DATA has created the branches, point a worktree at its own branch. `neon link` writes the connection strings into that worktree's `.env`, but it won't overwrite values that are already there, so delete the copied ones first:

```bash
sed -i '/^DATABASE_URL/d;/^NEON_BRANCH=/d' .env
neon link --project-id solitary-meadow-39146227 --branch ws-data -y
```

### 7.2 Launch prompt (fill in the code)

> You are the **<CODE>** agent for Fabric. Read `WORK-PLAN.md` §0–§4 and your section in §5.3 in full, then the doc sections it lists. Work only in the paths you own. The contracts in `packages/contracts` are frozen: if you need a change, write it under Requests in `status/<code>.md` and work on something else until the integrator answers. Record spike results in your status file. Keep mock mode working. Commit in small steps on `ws/<code>`, and rebase on `main` when a checkpoint is announced. Use your ports and Neon branch from §4.9.

### 7.3 Merge order at each checkpoint

contracts (integrator) → DATA → TOOLS → TEAM (with CTX) → DANA → UI-WORK → UI-CHAT → LAB. After each merge, run typecheck, tests and the mock-mode smoke before taking the next.

### 7.4 Recommended setup: 7 worktrees plus the integrator

The bottleneck is one person merging, answering requests and checking work, not how many agents run at once. CTX is a few hours of work and TEAM is its only consumer, so folding it into TEAM removes a cross-agent wait. OPS's docs refresh doesn't affect the demo, and the smoke tests are integrator work anyway.

| Worktree | Branch | Workstreams | Index (§4.9) |
|---|---|---|---|
| root checkout | `main` | **Integrator**: FND first, then merges, requests, checkpoints, OPS steps 2–4 | 0 |
| `../fabric-ws-data` | `ws/data` | DATA | 1 |
| `../fabric-ws-dana` | `ws/dana` | DANA | 2 |
| `../fabric-ws-team` | `ws/team` | TEAM + CTX | 3 |
| `../fabric-ws-tools` | `ws/tools` | TOOLS | 5 |
| `../fabric-ws-lab` | `ws/lab` | LAB | 6 |
| `../fabric-ws-ui-chat` | `ws/ui-chat` | UI-CHAT | 7 |
| `../fabric-ws-ui-work` | `ws/ui-work` | UI-WORK | 8 |

Nine worktrees (CTX and OPS as their own agents) also works with the ownership map as written. Expect two more branches to merge and more requests to answer.

**With only 5 agents:** A = FND, then DATA · B = DANA + CTX · C = TEAM + TOOLS · D = LAB · E = UI-CHAT + UI-WORK.

### 7.5 Effort level per agent

| Agent | Effort | Why |
|---|---|---|
| Integrator (+ FND) | **High** | FND is mechanical, but a mistake in the contracts breaks every agent; merges need judgment |
| TEAM (+ CTX) | **Max** | The hardest piece: parallel steps, the rework loop, cancellation, and integrating CTX, TOOLS and DATA against an unspiked Mastra. A wrong design here costs hours |
| DATA | **High** | Splice and finalize semantics, SSE, and segment derivation. Every other workstream builds on it |
| DANA | **High** | Unknown Gateway and stream behaviour (S1, S4), plus prompt work. Raise to Max if S1 or S4 fails and needs a creative fallback |
| TOOLS | **High** | Four sponsor SDKs with unverified APIs, and enforcing egress for real |
| LAB | **High** | ML correctness: tokenizer-aligned n-grams, interpolation and perplexity. The numbers go on stage |
| UI-WORK | **High** | A registry refactor across many components, plus the live clock and splice state |
| UI-CHAT | **Medium** | Well-scoped card and adapter work on existing patterns |
| CTX (if separate) | **Medium** | Well-specified pure functions with tests |
| OPS (if separate) | **Low** | Runbook and smoke scripts. Use Medium if it does the docs refresh |

### 7.6 Status file template (`status/<code>.md`)

```markdown
# <CODE> status — updated <time>
## Spikes
- S? — pass/fail · notes · fallback chosen
## Done
## Next
## Blocked (on whom)
## Requests (contract / path / decision)
```

---

## Appendix A — Open gaps → owners

| Gap | Owner(s) | Gap | Owner(s) |
|---|---|---|---|
| CHAT-14 results message | DANA, DATA (finalize), UI-CHAT | CARD-1 team card detail | DANA, UI-CHAT |
| RUN-2 splice | DATA, UI-WORK | CARD-3 inbox on card | TOOLS, DANA, UI-CHAT |
| RUN-3 badge honesty | UI-WORK | CARD-4 re-propose | DANA, UI-CHAT |
| SEED-1 clean seed | DATA, UI-WORK (registry), UI-CHAT (TeamHero) | CARD-6 declined badge | UI-CHAT |
| NAME-1/2 personas | FND (ids), DANA, UI-CHAT | CARD-8 handoff approval | DATA (seed) |
| ORG-1 org edge | UI-WORK | REP-1 / REP-2 report | LAB, UI-WORK |
| CHAT-6/7/9/10 unsafe controls | UI-CHAT | RUN-12 fixture | DANA, UI-CHAT |
| RUN-7 segments from events | DATA | IA-5 new thread reset | UI-CHAT |
| CHAT-13 considered[] | DANA (store only) | DATA-6 tool names | FND (contracts), TOOLS |
| DATA-8 repo layout | FND | AGT-9 Create buttons | UI-WORK (D7) |
| CHAT-8 model catalog | DANA (S1) | RUN-5 section text | CTX, UI-WORK |
