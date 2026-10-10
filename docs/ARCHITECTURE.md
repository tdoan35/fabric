# Fabric — Architecture

| | |
|---|---|
| Status | Draft, 2026-10-08. Not built. Replaces the hackathon architecture (v0.2, in git history) |
| Spec | `CONCEPT.md`. Its §2 invariants are binding; this document answers its §9 and §11 architecture questions |
| Companion | `RUNTIME.md`: the event log, jobs and recovery that everything here runs on |
| Decision | Fabric is its own product, in TypeScript. One server codebase runs inside the desktop app, on a host you run, or in Fabric's cloud. Hermes Agent is prior art, not a dependency |

## 0. Summary

Fabric is a delegation-first personal assistant. You talk to Dana; Dana routes work to specialist agents and teams; every piece of work is a run you can inspect, bound by a budget, that survives restarts and can last for days.

```
 clients: desktop · web · mobile · chat channels (Telegram, Slack, email)
     │  one protocol: HTTP commands + SSE streams (resume by seq)
     ▼
 ┌─────────────────── Fabric server ───────────────────┐
 │ API · auth · stream fan-out · channel adapters       │
 │ workers: decide (agent loop | team loop) · llm.call  │
 │          tool.exec · delegate.resolve · deliver      │
 │          timers · schedule.fire                      │
 │ agents: brief check · context assembly · registry    │
 │ tools: built-ins · MCP · policy · vault · sandboxes  │
 │ memory: scoped stores · recall                       │
 └──────────────┬───────────────────────┬──────────────┘
                ▼                       ▼
   Postgres (PGlite in the app)   sandboxes · model providers · object storage
```

The server is the same code in all three places. What changes is where it runs, which database it talks to, how people sign in, and whether it is always on.

## 1. Decisions

| Date | Decision |
|---|---|
| 2026-10-06 | Event-sourced runtime on Postgres, no message broker (`RUNTIME.md`) |
| 2026-10-07 | Thin clients that connect to a server at runtime; Postgres is the only required infrastructure |
| 2026-10-08 | Own product, not a fork or plugin of Hermes Agent |
| 2026-10-08 | The desktop app connects to its own local server, a remote host, or the cloud |
| 2026-10-08 | Chat channels are in v1 |
| 2026-10-08 | Long-running background work (hours to days, with approvals) is in v1 |
| 2026-10-08 | No workflow engine. Temporal was reviewed and set aside: the local server runs inside the desktop app, where Temporal can't |

## 2. Where it runs

| | Local | Remote host | Cloud |
|---|---|---|---|
| What it is | The desktop app starts the server on your machine | One container on a machine you run (home server, VPS) | Fabric's hosted service |
| Process | Electron utility process; API and workers in one process | API and workers in one process | Stateless API servers plus an autoscaled worker pool |
| Database | PGlite (Postgres compiled to WASM, in-process) with `pglite-pgvector`, in the app's data directory | Postgres + pgvector | Postgres, tenant-scoped with row-level security |
| Object storage | Files in the app's data directory | Local disk or any S3-compatible store | S3-compatible |
| Sandboxes | Local Docker by default. Your own machine only with explicit approval (CONCEPT A-7) | Docker on the host | Managed microVMs |
| Sign-in | None: the owner is implicit; paired devices get tokens | Owner passkey; paired devices get tokens | Accounts: OAuth (Google, Apple, GitHub), email, passkeys |
| Always on | While the machine is awake (§6.4) | Yes | Yes |
| Channels | Outbound-only transports: no public URL needed (§7.3) | Either | Webhooks |
| Models | Your own keys | Your own keys | Fabric-billed credits |

**Connections.** The desktop app keeps a list of connections, each one `{kind: local | remote | cloud, url, device token}`. A window shows one connection at a time with a switcher. Mobile connects to a remote host, the cloud, or a desktop's local server over the LAN or Tailscale; it never runs a server itself.

**Pairing.** A remote host or a local server shows a one-time code (in the app, or `fabric pair` on a host). A new device exchanges the code for a device token. Tokens are listed and revocable per device.

**Local server lifecycle.** The server keeps running when the window closes (menu-bar or tray icon, optional start at login), so channels and long-running work continue. It stops when the machine sleeps or shuts down, and resumes from the log on wake.

## 3. Domain model

| Primitive | What it is |
|---|---|
| **Workspace** | The tenant. One person for now. Every table carries `workspace_id`. A local or remote server holds one workspace |
| **Agent** | A versioned definition: `SOUL.md`, `IDENTITY.md`, its own `USER.md`, skills, tools and MCP servers with a policy, a model, a memory policy, default budgets. A run snapshots the version it started with (CONCEPT §2.4) |
| **Dana** | An agent with routing tools: `registry.search`, `propose_agent`, `propose_team`, `delegate`, `ask_user`. Every routed turn records a `disposition` fact (CONCEPT §4) |
| **Team** | A versioned operating model stored as data: lead, members and roles, stages `{label, agents, gate}`, completion criteria, rework budget, default budgets (CONCEPT §2.5, §13) |
| **Project** | Groups sessions and tasks |
| **Session** | A conversation between you and one agent, on any surface. A log stream of its own. Direct chat with a specialist is a session too, recorded as `direct · user-chosen` (A-2) |
| **Task** | One objective in a project, owned by one agent or team (A-12) |
| **Run** | One attempt at a task, or one delegation. A log stream of its own. Runs form a tree through delegation. Shown in the UI as a loop |
| **Artifact** | An output stored by reference (object storage), never pasted across a boundary |
| **Memory** | Four scopes: personal, agent, team/project, run (§8.3) |
| **Registry entry** | A compact card for an agent, team or template, with tags and an embedding (§8.4) |
| **Proposal** | A reviewable card for a new agent, team or catalog install. Nothing is created until you approve it (CONCEPT §7) |
| **Channel account / binding** | A connected bot or inbox, and the mapping from a chat on it to a session (§7) |
| **Schedule** | A recurring trigger owned by an agent: starts a run or posts into a session |

## 4. Delegation

Delegation is the core primitive. Any agent with the `delegate` tool can hand work to another agent or a team.

```ts
delegate({
  to: "agent:megan" | "team:research",
  brief: { objective, constraints, context, criteria, artifacts },
  output?: JSONSchema,              // validated, with one correction turn
  mode: "await" | "background",
  budget?: { usd, minutes },        // taken from the caller's remaining budget
  grants?: { tools, paths, hosts }  // can only narrow access, never widen it
}) → result | { runId }
```

| Property | Rule |
|---|---|
| Identity | The callee runs as itself: its own soul, model, skills and memory |
| Context | The callee receives the brief and its own `USER.md`, never the caller's transcript. The run records what was loaded and what was not (§8.2) |
| Permissions | Effective access = callee definition ∩ caller grants ∩ workspace policy. Merge, deploy, spend, credential and outbound-send actions always ask you (A-3), whoever asks for them |
| Budget | Reserved from the parent's remaining budget; unused budget returns. Exhaustion blocks the run and escalates: member → lead → Dana → you (CONCEPT §2.8) |
| Return | Outcome, evidence, open questions, artifact links, cost. Size-capped. With `output`, validated against the schema with one correction turn, and the raw text kept if it still fails |
| Await | The parent's `delegate` call stays open until the child finishes |
| Background | The call returns `{runId}` at once. The result is posted to the caller's stream later, and the caller's next turn sees it |
| Memory | The callee writes only its own agent memory and the run's scratch. Promotion to personal memory is an explicit, visible step (CONCEPT §2.9) |
| Limits | Depth limit, cycle check (Megan → Dana → Megan is refused), and a per-workspace cap on concurrent runs |
| Cancellation | Cancelling a run cancels its whole subtree |

**How it runs.** Waiting for a delegation is an open tool call on the parent's stream; no process holds it in memory. The child is its own run stream. When it ends, a `delegate.resolve` job appends the result to the parent's stream as the tool's result, keyed by the call ID so a retry can't record it twice, and queues the parent's next decision. Details in `RUNTIME.md` §5.2.

## 5. Teams

Delegating to a team starts a **team run**. Its `decide` follows the team's operating model: stages in order, a stage's agents in parallel, then the gate. Each lane is a delegation to a member. At the review gate the reviewer's delegation returns a structured verdict: accept finalizes the run; request changes starts a rework pass, or blocks the run when the rework budget is spent.

The orchestration is deterministic data, not an LLM improvising, so it is inspectable and replayable (CONCEPT §9.2.6). A team's lead is still an agent: it writes the plan and the synthesis as delegations within the stages. This is `RUNTIME.md` §5.3's team loop, with lanes as delegations instead of raw model calls.

## 6. Long-running work

Runs can last hours or days. None of their state lives in a process.

### 6.1 Waits and approvals

`ask_user` appends `human.requested` with a kind (confirm, approve, answer), a prompt and a deadline. The run waits; a timer at the deadline either reminds you or escalates, per the run's policy. Your answer, from any surface, appends `human.responded`. The append checks that the wait is still open, so a late or duplicate answer is refused rather than applied (`RUNTIME.md` §7).

### 6.2 Progress

Runs report progress as they go: leads post `run.progress` updates and milestone facts. The Weave page shows asks in its inbox and progress in its Pulse feed (CONCEPT A-11). You choose where results and asks are delivered: app, push, or a channel.

### 6.3 Stalls

Each running run has a watchdog timer. If no fact arrives within the run's stall window, `decide` re-evaluates the run (a lost job is re-queued); if it is still stuck, the run is blocked with the reason and escalated. Budgets cover wall-clock time as well as cost.

### 6.4 Local and remote

On a local server, work pauses while the machine sleeps and resumes on wake. Timers that came due during sleep fire on wake under the schedule's catch-up rules. The app says so plainly, and suggests a remote host or the cloud for work that has to keep going. A run lives on the connection where it started; moving a workspace between connections is an open question (§14).

## 7. Channels

### 7.1 Model

| Piece | What it is |
|---|---|
| Channel account | A bot token, app installation or inbox owned by the workspace. Active on exactly one connection at a time (Telegram allows one poller per bot) |
| Binding | A chat or thread on that account ↔ a session. A DM to the bot binds to Dana by default; you can bind a chat to a specialist (a direct chat, A-2) |
| Sender allowlist | Only identities you paired from the app can talk to an agent. A message from anyone else is dropped and shown as a pairing request in Weave |

### 7.2 Flow

- **Inbound.** The adapter normalizes a platform message and appends `message.received` to the bound session, keyed by the platform message ID (a redelivered webhook is a no-op). The session's `decide` takes it from there.
- **Outbound.** Each message to a channel is a `deliver` job keyed by its event ID: platform formatting, chunking, attachments, rate limits, retries. Long replies stream by editing the platform message, throttled.
- **Asks.** Ungated asks can be answered in the channel with buttons. Gated asks (merge, deploy, spend, credentials, external send) send a link into the app and are never approved from a chat message.

### 7.3 Transports

Every adapter supports an outbound-only transport so a local server needs no public URL: Telegram long polling, Slack Socket Mode, Discord's gateway WebSocket, email through the provider's API. The cloud uses webhooks. A remote host can use either.

Proposed v1 set: Telegram, Slack, email. Then Discord, WhatsApp, Signal, iMessage (§14).

## 8. Context, briefs and memory

### 8.1 Briefs

The caller's model writes the brief through the `delegate` tool's schema. The runtime checks it before the child starts: an objective, completion criteria, and artifact references that resolve. A brief that fails the check goes back to the caller as a tool error with one correction turn. This is the v1 brief compiler (CONCEPT §9.2.2); smarter assistance comes once real briefs show where they go wrong.

### 8.2 Context assembly

Each model call's context is assembled from the agent's definition files, its skills index, the brief, recalled memory from the scopes it may read, and retrieved team knowledge. The assembly is saved as a `context.snapshot` before the call, with a "not loaded" list (your transcript, personal memory, other agents' skills). The inspector reads it to answer "what was actually loaded?" (CONCEPT §6).

Long sessions are compacted with marker events: a summary fact supersedes the events before it for context purposes, and nothing is deleted.

### 8.3 Memory

| Scope | Read by | Written by |
|---|---|---|
| Personal | Dana | Dana, and promotion from other scopes (shown in Weave) |
| Agent | That agent | That agent |
| Team / project | Members, when retrieved | Members, via the team's knowledge tool |
| Run | That run | That run; dropped at the end unless promoted |

A specialist's `USER.md` is the ceiling of what it knows about you, edited only by explicit promotion (A-9). Memory items live in one table keyed by `(scope_type, scope_id)`, with pgvector and full-text search. Every write is a `memory.written` fact applied to the table in the same transaction, so Weave can list it and you can forget it.

### 8.4 Registry

Cards for agents, teams and templates: a compact description, tags, an embedding. Dana's `registry.search` runs a hybrid query (full-text and vector) and returns the top few cards, never full definitions (CONCEPT §2.3). A card is rewritten when its definition changes.

## 9. Tools, sandboxes and credentials

- **Built-in tools:** `delegate`, `ask_user`, `memory.*`, `artifacts.*`, files, shell, browser, web search, `schedule.*`, `send`. Agents can add MCP servers.
- **Every tool declares** its effect class (`read`, `idempotent`, `rerunnable`, `once`; `RUNTIME.md` §6) and its gate (none, by approval mode, always human).
- **Policy is enforced in `tool.exec`**, against the run's effective access (§4). UI toggles describe; the runtime enforces (CONCEPT §2.7).
- **Sandboxes:** one persistent sandbox per workspace that sleeps when idle, a working directory per run, a slot leased per tool call, and a network allowlist per agent. Providers: local Docker, the host machine (approval required), cloud microVMs (Sprites today). The browser runs inside the sandbox.
- **Credentials** (model keys, channel tokens, connector secrets) live in an encrypted vault: the OS keychain locally, envelope encryption with a KMS in the cloud. They are injected into tool calls by the runtime, scoped per agent, and never appear in prompts or the log.
- **Skills** use the Agent Skills format (`SKILL.md` folders), loaded on demand. Agents can be imported from Hermes or Claude Code as proposals.

## 10. Surfaces and protocol

- **One protocol** for desktop, web and mobile: HTTP commands plus SSE streams that resume from `Last-Event-ID`. Types live in `packages/contracts`.
- **Every client follows the same streams,** so a session continues across surfaces without sync code.
- **Model tokens** stream outside the log (`RUNTIME.md` §8).
- **Screens:** chat is the landing page. Weave holds asks and progress, Work holds tasks and loops, Agent Studio holds definitions (CONCEPT §8, A-11, A-12).
- **Push** goes to mobile and desktop for asks, blocks and results, following your delivery preferences.

## 11. Identity, tenancy and billing

- **Auth:** none locally (implicit owner, device tokens for paired devices); an owner passkey on a remote host; Better Auth in the cloud (Neon Auth is a managed version).
- **Tenancy:** `workspace_id` on every table. In the cloud each job runs with `SET LOCAL app.workspace_id` and row-level security enforces it. The schema is the same everywhere.
- **Billing (cloud):** a usage ledger written from facts (model usage, sandbox minutes, tool costs) draws down prepaid credits bought through Stripe. Budgets are checked in `decide`.
- **Cost attribution:** every `llm.completed` carries usage; cost rolls up the run tree, so each run, agent and team has its own cost and the honesty metrics of CONCEPT §6 (handoff rework rate, cost against a single-agent baseline) come from facts.

## 12. Repo layout

```
packages/core       domain types, event schemas, fold/decide (pure)
packages/runtime    append, queue, workers, timers, storage (Postgres | PGlite)
packages/agents     agent loop, team loop, brief check, context assembly, registry
packages/tools      built-ins, MCP client, policy, vault, sandbox providers
packages/channels   adapters (Telegram, Slack, email), bindings, delivery
packages/memory     scopes, recall, embeddings
packages/llm        providers, pricing, bring-your-own-key
packages/contracts  client↔server protocol
apps/server         HTTP, SSE, auth; API and workers in one process except in the cloud
apps/desktop        Electron, with the local server built in (today: apps/web/electron)
apps/web, apps/mobile
```

| Today | Becomes |
|---|---|
| `apps/web`, `apps/web/electron`, `apps/mobile` | Kept; the Electron shell moves to `apps/desktop` and gains connections |
| `packages/contracts` | Kept, extended with the protocol |
| `packages/agents/src/llm` (Spark, OpenRouter, Neon lanes) | `packages/llm` |
| `packages/integrations` (Exa, AgentMail, Sprites) | Exa → web search tool; AgentMail → email channel and `send`; Sprites → one sandbox provider |
| `packages/agents/src/memory` (local embeddings) | `packages/memory` |
| `team/engine.ts`, `services/hub.ts`, `services/scheduler.ts` | Replaced by the runtime (`RUNTIME.md` §13) |
| Mastra dependency, demo machinery | Dropped |

## 13. Build order

1. **Spike** (`RUNTIME.md` §15): the runtime core on PGlite inside Electron and on Postgres, with the `kill -9` tests.
2. **Durable sessions:** session streams and the agent loop. Dana's chats survive restarts, on local and remote connections.
3. **Delegation:** await and background modes, budgets, cancellation, waits and approvals, stall watchdogs, the inspector, Weave's inbox.
4. **Teams** on delegation; the Work page; schedules as jobs.
5. **Tools and isolation:** sandbox providers, policy, the vault, skills, MCP.
6. **Channels:** Telegram, Slack and email adapters, pairing, delivery preferences.
7. **Connections and cloud:** remote-host pairing; cloud accounts, tenancy, the worker pool, billing, push.

## 14. Open questions

1. **v1 channel set.** Proposed: Telegram, Slack, email. iMessage needs a Mac bridge; WhatsApp's official API needs business verification.
2. **Push for local and remote connections.** Push credentials belong to the app's publisher, so self-run servers can't send push directly. Options: a free Fabric push relay, or rely on channels for notifications when not on the cloud.
3. **Moving a workspace between connections** (local → cloud, for example): v1 or later. The log makes export straightforward; channel accounts and in-flight runs need a handover.
4. **Cloud:** bring-your-own-key in the cloud, and the pricing shape.
5. **Sandboxes:** what persists in a workspace's sandbox, and whether v1 needs GPUs.
6. **Multiple connections at once:** one connection per window (proposed), or a combined view across connections.
7. **License:** Apache-2.0, everything in one repo (proposed).
