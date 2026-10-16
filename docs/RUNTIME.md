# Fabric — Durable Runtime

| | |
|---|---|
| Status | Draft, 2026-10-06; updated 2026-10-08 for sessions, delegation, channels and the local server, and 2026-10-10 for learning (`LEARNING.md` §12). Not built |
| Scope | How sessions, runs and delegations are stored, resumed and observed: inside the desktop app, on a host you run, and in the cloud, with the same code. The system around it is in `ARCHITECTURE.md` |
| Decision | Event-sourced logs in Postgres (PGlite inside the desktop app), a Postgres job queue, and stateless workers. No message broker, no workflow engine |

## 0. Summary

Every session and every run is an append-only **log** of events in Postgres. The log is the source of truth, the inspector's data and the resume point. A pure **fold** turns the log into the current state; a **decide** function looks at that state and queues the next **jobs** (call a model, run a tool, start a delegated run, wait for a person, deliver a message, finish). Stateless **workers** pull jobs from a Postgres queue, do the work, and append the result in the same transaction that queues the next decision. A crash loses at most the job in flight, which is retried; results are keyed by job, so a retry can't record anything twice.

Local: the desktop app runs the API and a worker in one process against PGlite. Remote host: one process against one Postgres. Cloud: API servers plus an autoscaled worker pool, against Postgres scoped by workspace.

```
 triggers: app or channel message · approval · schedule · inbound email · webhook
        │ append
        ▼
 ┌───────────────────────────── Postgres ─────────────────────────────┐
 │ events (per-stream logs, append-only)  ◀── results ──┐              │
 │ jobs                                   ─── jobs ──┐  │              │
 │ notify on append → API servers → SSE to clients   │  │              │
 └───────────────────────────────────────────────────┼──┼──────────────┘
                                                     ▼  │
        workers: fold(log) → decide(state, now) → jobs  │
                 llm.call · tool.exec · delegate.resolve│
                 deliver · finalize ────────────────────┘
```

## 1. Why: what happens today

A team run lives in an in-memory `Map` in the server process (`packages/agents/src/team/engine.ts`). Production holds the evidence: `run-engram-lookup-table-on-nand-for-small-models-1` started at 23:46 UTC on Oct 4. Plan, Survey and Setup finished by t=207 s, Sana's "Prep checks" never finished, nothing was written after that, and the run still reads `running`. Nothing can resume it: the position in the workflow, the in-flight model calls and the cost meter (`runCostUsd`, in memory) are gone.

The same trace shows two more costs of the current shape:
- **Narration arrives late.** `generateText` runs a step's whole tool loop and returns all its text at the end, so Megan's narration of searches at t=20–47 s was written at t=172–200 s.
- **The log is mostly terminal output.** 166 of the run's 203 events are `tool.result` terminal lines.

Chat turns have the same weakness: a turn lives in one HTTP response, so a turn that dies midway leaves a saved question, no reply, and possibly side effects nobody was told about.

## 2. The model

| Concept | What it is |
|---|---|
| **Stream** | One log: `session:<sessionId>` for a conversation, `run:<runId>` for an agent run or a team run, `agent:<agentId>` for an agent's learning log (`LEARNING.md`). Has a head sequence number and a workspace |
| **Event** | An immutable record appended to a stream: type, actor, payload, `seq`, `v` (payload version), `causation` (the job that produced it), `class` |
| **Fact** | An event the fold reads: lifecycle, inputs, model replies, tool results, delegation results, verdicts, human responses, memory writes |
| **Telemetry** | An event only the UI reads: terminal lines, narration copies, progress, budget ticks, delivery receipts. The fold skips them |
| **Fold** | `fold(facts) → State`. Pure and deterministic; the only code that must be |
| **Decide** | `decide(state, definition, now) → { events, jobs }`. Two kinds: the agent loop and the team loop (§5). Runs after every fact; its output is recorded, never replayed, so it is free to change between deploys |
| **Job** | A unit of work in the queue with an idempotency key. Executed at least once; its result is recorded at most once |
| **Definition** | The agent or team definition, brief, grants, budgets and engine version, snapshotted into `run.created`. Editing an agent or team never changes a run already under way |
| **Parent** | A delegated run records its parent `{runId or sessionId, callId}`. Runs form a tree |

**Append** is one transaction: bump each touched stream's head, insert the events, notify the streams, and queue `decide` for each stream that gained a fact. A transaction may touch several streams (a delegation creates the child's stream while recording the parent's tool call). A unique index on `(stream_id, causation)` for result events makes a retried job's second append a no-op. A store transaction opened inside another one's callback, such as a store-backed tool running inside its `tool.exec` job, joins it as a savepoint on the same connection rather than taking a second one; on PGlite's single connection a second one would deadlock.

**One decision at a time per stream.** `decide` jobs are serialized per stream. Executor jobs aren't, so a stage's lanes and a turn's parallel tool calls run at the same time.

## 3. Events

Existing types keep their names and payloads so the web app's read model (`deriveSegments`) keeps working. New fact types carry what the runtime needs to resume.

| Type | Class | Payload (new fields in bold) | Appended by |
|---|---|---|---|
| `run.created` | fact | **definition snapshot, engineVersion, brief, grants, budgets, parent** | API / `delegate` / schedule fire |
| `run.started` | fact | objective | decide |
| `message.received` | fact | **text, attachments, surface (app · channel), sender, platformMessageId** | API / channel adapter |
| `disposition.recorded` | fact | **kind (direct · agent · team · propose · clarify), target, reason** | decide (Dana) |
| `step.started` | fact | label, stage, kind, **stepKey, pass, childRunId** | decide (team loop) |
| `llm.requested` | fact | **turn, callNo, model, params, snapshotId** | decide |
| `llm.completed` | fact | **turn, callNo, text, toolCalls[], usage, finishReason, model** | `llm.call` |
| `llm.failed` | fact | **turn, callNo, error, retryable** | `llm.call` |
| `context.compacted` | fact | **upToSeq, summary** | `llm.call` (compaction) |
| `tool.call` | fact | tool, summary, **callId, args, effect** | decide (was: the tool itself) |
| `tool.completed` | fact | **callId, ok, result or resultRef, error** | `tool.exec` / `delegate.resolve` |
| `tool.interrupted` | fact | **callId, effect, note** | `tool.exec` on recovery (§6) |
| `tool.denied` | fact | tool, target, reason, **callId** | decide (policy check) |
| `delegation.result` | fact | **childRunId, outcome, summary, output, artifacts, costUsd** | `delegate.resolve` (background mode) |
| `step.finished` | fact | label, stage, kind, **stepKey, outcome: done · timed_out · failed · cancelled** | decide |
| `review.verdict`, `criterion.checked` | fact | unchanged (from the reviewer's structured output) | decide |
| `rework.requested` | fact | to, used, budget | decide |
| `human.requested` | fact | **waitId, kind: confirm · approve · answer, gated, prompt, deadline** | decide |
| `human.responded` | fact | **waitId, decision, by, surface** | API |
| `memory.written` | fact | **scope, itemId, op: add · update · forget, contentRef** (the text lives outside the log so it can be erased, `LEARNING.md` §10.4) | `tool.exec` / `learn` |
| `skill.written` | fact | **skillId, version, op: create · patch, contentRef, scope, origin, source** (on the agent's stream) | `learn` / API |
| `skill.used` | fact | **skillId, version, stream, outcome, revises?** (on the agent's stream) | `run.finalize` / `run.timer` (session quiet) / `learn` |
| `skill.state_changed` | fact | **skillId, from, to, reason, strength** (on the agent's stream) | `skills.maintain` |
| `learning.completed` | fact | **source stream, upToSeq, written, skipped, costUsd** (on the agent's stream) | `learn` |
| `content.erased` | fact | **contentRef, reason, by** | `skills.maintain` / API |
| `feedback.given` | fact | **targetEventId, kind: up · down · edit, diffRef** (on the target's stream) | API |
| `proposal.created`, `proposal.decided` | fact | **kind, definition, decision, by** | decide / API |
| `run.cancel_requested` | fact | **by** | API / parent's cancellation |
| `run.blocked`, `run.stopped`, `run.finished` | fact | unchanged, plus **result, costUsd** on `run.finished` | decide / `run.finalize` |
| `artifact.created` | fact | name, artifactId | `tool.exec` |
| `context.snapshot` | telemetry | snapshotId (the snapshot row is recorded with the call's result, in the same batch; memory and skill sections are stored by reference) | `llm.call` |
| `tool.result` (term line) | telemetry | line, kind | `tool.exec`, streamed |
| `agent.message` | telemetry | text (a copy of `llm.completed.text` for the UI) | decide |
| `run.progress` | telemetry | **text, milestone** | decide |
| `budget.update` | telemetry | costUsd (folded from usage), rework counts | decide |
| `message.delivered` | telemetry | **eventId, target, platformMessageId** | `deliver` |
| `handoff` | telemetry | to, step | decide |

Model token deltas never enter the log: they are pushed live (§8) and the final text lands in `llm.completed`.

## 4. Jobs

| Job | Idempotency key | Does | Appends |
|---|---|---|---|
| `decide` | per-stream serial queue | Fold, decide, append decisions, queue jobs | lifecycle, step, llm, tool, delegation, human facts |
| `llm.call` | `stream:turn:llm:n` | Assemble context, save snapshot, call the model **once** with tools that have no `execute` (the SDK returns tool calls instead of running them), stream deltas live. The model is called between a read transaction and a record transaction, and a result that arrives after another runner's is discarded | `llm.completed` or `llm.failed`, `context.snapshot` |
| `tool.exec` | `stream:callId` | Run one tool with the run's effective access; stream terminal lines | `tool.completed` or `tool.interrupted`, `artifact.created`, `memory.written`, term lines |
| `delegate.resolve` | `run:<child>:resolve` | When a child run ends, report it to the parent: `tool.completed` (await mode) or `delegation.result` (background mode). Release the unused budget | parent facts |
| `deliver` | `deliver:<eventId>:<target>` | Send one outbound message to a channel, push or email, with formatting, chunking, rate limits and retries | `message.delivered` |
| `run.timer` | `stream:timer:<id>` | A `decide` scheduled with `run_at`: step timeouts, wait deadlines and reminders, stall watchdogs, time budgets | via decide |
| `run.finalize` | `run:finalize` | Report, Weave item, results message, report email; each part checks its own "done" fact first | `run.finished`, report facts |
| `schedule.fire` | `schedule:<id>:<slot>` | Scheduled with `run_at = slot`. Applies the schedule's overlap and catch-up rules (§9). Creates the run or posts into the session, and plans the next slot | `run.created` or `message.received` |
| `learn` | `learn:<stream>:<upToSeq>` | One learning pass over a finished run or a quiet session segment (`LEARNING.md` §6) | `skill.written`, `memory.written`, `skill.used`, `learning.completed` |
| `skills.maintain` | `maintain:<agentId>:<day>` | Daily, with no model: strength, lifecycle, the context budget, deletion windows (`LEARNING.md` §3, §5) | `skill.state_changed`, `content.erased` |
| `org.review` | `org-review:<workspaceId>:<week>` | Weekly, or at once on a hard signal: checks the signals, then Dana drafts proposals (`LEARNING.md` §9) | `proposal.created` |

**Timeouts and retries are declared per job type**, not scattered through `decide`:

| Job | Runs at most | Heartbeat | Retries |
|---|---|---|---|
| `decide` | 30 s | — | 3, then `run.blocked` with the error |
| `llm.call` | 10 min | stream activity every 60 s | 429 and 5xx with backoff, honouring `retry-after`; one retry for other retryable errors (§5.1) |
| `tool.exec` | 61 min — the 60 min sandbox cap plus grace (§6) | 30 s | by effect class (§6) |
| `delegate.resolve`, `run.finalize` | 30 s | — | until done (idempotent) |
| `deliver` | 30 s | — | backoff up to 24 h, then a failed-delivery fact the UI shows |

Starting values; the spike adjusts them. A job whose heartbeat goes stale is handed to another worker.

**Sandbox slots (T16).** Wherever step-2 tools run (Docker or Sprites), a per-workspace cap on concurrent sandbox tool calls holds one slot **per tool call, never per run**, over a runtime-owned `sandbox_slots` table — `acquire` grants when fewer than the cap are held and no waiter ranks ahead (chat turns — `session:` streams — first, then the older ask), `release` and `heartbeat` ride the call, and a held slot whose heartbeat is older than 60 s is reclaimable, so a crashed worker never leaks one. A refused `tool.exec` appends the fact `tool.queued` — one fact per transition, so a later waiting period (a retry that waits again) or a return to an earlier position records anew, while a repeat of the position the fold still reports appends nothing — and defers its job 2 s — the attempt count untouched, a queue wait is not a retry — and runs nothing; when granted it appends `tool.dequeued` with the wait (one per waiting period), holds the slot through the run heartbeating with the lease, and releases it on completion or on any failure after the grant. Host mode wires no slots.

## 5. Decide

### 5.1 Agent loop (sessions and agent runs)

```ts
interface AgentState {
  status: "idle" | "running" | "waiting" | "blocked" | "finished" | "stopped";
  def: Definition;                  // from run.created, or the session's agent version
  turn: number;
  pendingInputs: Input[];           // message.received, delegation.result, human.responded not yet answered
  calls: number;                    // llm.completed in this turn
  openToolCalls: Map<string, ToolCall>;  // tool.call without tool.completed/interrupted
  waits: Map<string, Wait>;
  costUsd: number; reservedUsd: number;  // reserved for child runs
  compactedUpTo: number;            // latest context.compacted
  cancelRequested: boolean;
}
```

`decide` for the agent loop, in order:
1. **Cancel or budget.** `cancelRequested` → `run.cancel_requested` to every open child run, close open tool calls as cancelled, append `run.stopped`. Cost or time over budget → `run.blocked` with the reason, escalated to the parent. A session turn over its per-turn cost cap ends as in rule 4, and its reply says so and offers to delegate (PRODUCT §4.1).
2. **Last fact is `llm.completed` with tool calls** → for each call, check policy and route it:
   - denied → `tool.denied`;
   - `delegate` → §5.2;
   - `ask_user` → `human.requested`, status `waiting`, a `run.timer` at the deadline;
   - anything else → `tool.call` and queue `tool.exec`.
3. **All of the turn's tool calls resolved** → `llm.requested` for call n+1, unless `calls = MAX_STEPS`.
4. **`llm.completed` with no tool calls, or `MAX_STEPS` reached** → the turn ends. A session copies the reply to `agent.message`, queues `deliver` for each surface that should receive it, and goes `idle`. A run appends `run.finished` with its result and queues `delegate.resolve` when it has a parent.
5. **`llm.failed`** → one retry if retryable; otherwise the turn ends with a narration of the failure (today's behaviour).
6. **Idle with pending inputs** → start a turn: `llm.requested` for call 1.
7. **Context too long** → the next `llm.call` compacts first and appends `context.compacted`.

The conversation for each call is rebuilt from facts: the snapshot's system prompt, the latest compaction summary, then each later input, `llm.completed` (text and tool calls) and its results. Large tool results live in object storage, referenced by `resultRef`.

### 5.2 Delegation

When a turn's tool call is `delegate`, one append does all of this in one transaction:
- the parent's `tool.call` (`delegate`, effect `idempotent`);
- the child's `run.created` on a new stream, with an ID derived from the parent's stream and `callId` (so a retried `decide` can't create two runs), the callee's definition snapshot, the brief, the effective grants, the budget reserved from the parent, and the parent reference;
- a `decide` job for the child.

In **await** mode the parent's tool call stays open. In **background** mode `decide` also appends `tool.completed {runId}` at once, and the parent's turn continues.

The child runs its own agent loop (or team loop). When it ends, `delegate.resolve` appends `tool.completed` with the result to the parent (await) or `delegation.result` (background), releases the unused budget, and queues the parent's `decide`. A `delegation.result` on an idle session starts a turn, so Dana tells you the outcome.

The brief is checked before the child starts (`ARCHITECTURE.md` §8.1); a failing brief returns to the caller as a tool error with one correction turn.

### 5.3 Team loop (team runs)

```ts
interface TeamState {
  status: "running" | "waiting" | "blocked" | "accepted" | "stopped";
  def: TeamDefinition;              // from run.created
  pass: 1 | 2; reworkUsed: number; reviews: number;
  lanes: Map<string, LaneState>;    // stepKey = stage|agent|pass
  costUsd: number;                  // Σ child costs
  waits: Map<string, Wait>;
  cancelRequested: boolean;
}
interface LaneState {
  agentId: string; stage: string; label: string;
  childRunId: string;
  status: "running" | "done" | "failed" | "timed_out" | "cancelled";
  startedAt: number;
}
```

`decide` for a team run, in order:
1. **Cancel or budget**, as in §5.1.
2. **Current stage(s).** From `planPasses(def.workflow)` (unchanged): Plan runs alongside Prepare, then the middle stages in order. For each lane of the current stage without a child: `step.started` and a delegation to the member (§5.2), with a brief built from the team's brief and the stage.
3. **Each lane's child ends** → `step.finished` with its outcome. A failed child gets one retry if its failure was retryable, else the lane is `failed` with a narration.
4. **Stage complete** (all lanes finished) → the next stage. At the gate, the reviewer's delegation returns a structured verdict → `review.verdict`:
   - accept → queue `run.finalize`;
   - request changes → `rework.requested` and pass 2 (Re-plan → Rework → Re-check), or `run.blocked` when `bounceOutcome` says the budget is spent.

## 6. Side effects

Every tool declares its effect class. `tool.call` (with the class) is appended **before** `tool.exec` runs, so after a crash the runtime knows what was attempted. The tool itself runs **between two transactions** — the read and the record — so a long call never holds the store's connection; a result that arrives after another runner's is discarded.

| Effect | Tools | A retried `tool.exec` finds no result |
|---|---|---|
| `read` | `exa.search`, `artifacts.read`, `memory.search` | Runs again |
| `idempotent` | `artifacts.write`, `workspace.write` (upsert by name/path), `memory.write` (keyed by callId), `delegate` (child ID from callId) | Runs again |
| `rerunnable` | `sprite.exec`, sandbox shell | Appends `tool.interrupted` ("interrupted by a restart; effects may be partial"). The model sees it as the result and decides whether to run it again |
| `once` | `send` and `agentmail.send`, `browser.task` submit, anything that pays or books | Never runs again. Appends `tool.interrupted`, then `human.requested` ("check whether this happened"). Uses the provider's idempotency key where one exists |

Outbound messages that are part of a reply (not a `send` tool call) go through `deliver`, which is keyed by event ID and so never duplicates a message within its retry window.

## 7. Waits, cancellation, budgets, stalls

- **Waits.** `human.requested` sets status `waiting` and queues a `run.timer` at the deadline, plus reminders per the run's policy. The API appends `human.responded` only if the wait is still open: the check and the append are one transaction, and the API returns `accepted` or `refused` (expired, already answered, run cancelled). The browser booking confirmation becomes exactly this, replacing the `pendingAction` patched into `runs.budget`. Gated waits (merge, deploy, spend, credentials, external send) accept answers only from the app, never from a channel.
- **Cancellation.** The API appends `run.cancel_requested`; `decide` passes it to every open child run, so cancellation reaches the whole subtree. Workers holding jobs for a cancelled stream get a notification and abort in-flight model calls; late results are refused by the append guard (today's `RunClosedError`).
- **Budgets.** Cost is folded from `llm.completed.usage` and children's `run.finished.costUsd`, so it survives restarts. A delegation reserves budget from its parent; `delegate.resolve` releases what the child didn't use. Time budgets and step timeouts are `run.timer` jobs.
- **Stalls.** Every running stream has a watchdog `run.timer`, re-armed by each new fact. When it fires with no progress, `decide` re-queues a lost job if there is one; if the stream is still stuck at the next firing, it appends `run.blocked` with the reason and escalates. A stream with a call queued for a sandbox slot (T16) reads `EMPTY` at either strike — the wait is a fact (`tool.queued`/`tool.dequeued` in the fold's `queuedCalls`), and a queue wait is not a stall.

## 8. Live updates

Every append notifies its streams. API servers read the new events and push them over SSE; clients resume with `Last-Event-ID = seq`. Model token deltas from `llm.call` go out on the same channel, batched about every 100 ms, and never enter the log: the model port emits raw text **increments** — the provider stream's shape — and the `llm.call` worker accumulates them per call attempt, so the frames carry the **cumulative** text of the call (R16). This replaces the in-process hub and the 400 ms database poll per stream.

| | Notify | Token deltas |
|---|---|---|
| Local (one process) | In-process event emitter | Same emitter |
| Remote host, cloud | `pg_notify('stream', '<workspace>:<stream>:<seq>')`; API servers `LISTEN` | Same channel; Redis or NATS when NOTIFY stops scaling |

`LISTEN` and the job queue need a direct (unpooled) connection; HTTP handlers keep using the pooled one. Postgres serializes the commits of all transactions that sent a NOTIFY, so at cloud scale the notify moves to Redis or NATS before the commit lock becomes the bottleneck.

## 9. Schedules

Each enabled schedule always has its next `schedule.fire` job queued with `run_at = slot`. There is no 30-second tick. What a schedule is, and what its runs may do, is in `ARCHITECTURE.md` §6.5.

- **Overlap.** Each schedule says what happens when its previous run is still going: `skip` (default), `queue_one`, or `allow`.
- **Catch-up.** A fire more than 10 minutes late is marked missed. After a local server wakes from sleep, only the most recent missed slot fires, and only if it is inside the catch-up window; the others are marked missed. Nothing is dropped silently.
- **Idle cost.** No tick means no scheduler traffic, but the queue's own polling (§14) keeps a database awake. A scale-to-zero database is a spike measurement, not a promise.

## 10. Versioning

- **Events** carry `v`. Old payloads are upgraded on read (upcasters), never rewritten.
- **Runs** pin `engineVersion` in `run.created`. `decide` dispatches on it; an old version's `decide` stays in the code until no unfinished run uses it. Sessions pin per turn.
- **Fold** changes must read every older event shape. That's the one place deploys need care, and it's plain data code.
- **Replay tests in CI.** Every recorded log in the fixtures is folded with the current code for every `engineVersion` still in use; a fold that changes state for an old log fails the build.

## 11. Tenancy

`workspace_id` on streams, events, jobs and every domain table. In the cloud, workers run each job in a transaction with `SET LOCAL app.workspace_id`, and row-level security enforces it. Local and remote servers hold one workspace with the same schema. Per-workspace caps on concurrent jobs keep one workspace from starving others (§14).

## 12. Paper test: the stuck production run

The real trace of `run-engram-lookup-table-on-nand-for-small-models-1`, replayed through this design. Each member's lane is now a child run with its own agent loop.

| t (s) | Today | This design |
|---|---|---|
| 0.7 | `run.started` | `run.created` → decide: `run.started` |
| 4.1 | 4× `step.started` (Plan ∥ Prepare) | decide: 4× `step.started`, 4 child runs created, their first `llm.call` jobs run in parallel |
| 4–55 | Tool events stream; narration held back | Each child cycles `llm.completed` → `tool.call` → `tool.exec` → `tool.completed` → next `llm.call`. Narration is in each `llm.completed`, visible as it happens |
| 20–47 | Megan's 3 searches run | Same, each a `tool.exec` (`read`) |
| 166 | Jonah's Setup finishes | Jonah's child `run.finished` → `delegate.resolve` → `step.finished(done)` |
| 172–200 | Megan's narration finally written | Already shown at t=20–47 |
| 206.9 | Elliot's Plan finishes. Sana still mid-step | Same |
| ~207 | **Process dies. Run stuck as `running` forever** | Process dies. Last facts in Sana's run: `llm.completed` (call 3) asking for `sprite_exec`, and its `tool.call`, without a result |
| restart | Nothing | The worker comes back (local, remote host) or another worker takes the job once its heartbeat goes stale (cloud). `tool.exec` finds no result for a `rerunnable` call → `tool.interrupted` → decide → Sana's `llm.call` 4 sees "interrupted" and re-runs her check |
| then | — | Sana's run finishes → `delegate.resolve` → Prepare is complete → decide starts Synthesize (Elliot). The run continues |

Cost of the crash: one interrupted sandbox command and one extra model call. Changes this test forced into the design: telemetry is a separate event class so the fold ignores 80% of the log; narration comes from each model reply instead of the end of the step; tool-argument failures (Elliot's "the content parameter isn't attaching") become `tool.completed {ok: false}` facts that are visible and countable.

## 13. From today's code

| Today | Becomes |
|---|---|
| `run_events` + `RunWriter.emit` (advisory lock + `max(seq)+1`) | `events` with `workspace_id`, `v`, `causation`, `class`; `append()` bumps stream head rows and notifies |
| `team/engine.ts` `executeWorkflow` (in-memory, long-lived) | `team/decide.ts`, pure; `planPasses` and `bounceOutcome` reused as they are |
| `team/steps.ts` `runStep` (whole tool loop in one `generateText`) | The agent loop: `llm.call` (one model call, tools without `execute`) and `tool.exec` (one tool), in a child run per lane |
| Dana's chat turn (one HTTP response) | The agent loop on a `session:` stream; the client posts the message, then follows the stream |
| `tool-context.ts` `ToolIO` emitting `tool.call` itself | decide appends `tool.call`; `ToolIO` keeps streaming term lines |
| `llm` meter `runCostUsd` (in memory) | `llm.completed.usage`, folded |
| `services/finalize.ts` (called from `RunWriter.end`) | `run.finalize` job, each part idempotent |
| `services/scheduler.ts` 30 s tick + claims | `schedule.fire` jobs at each slot |
| `assistant/errand.ts` + `pendingAction` in `runs.budget` | An agent run: browser steps as `tool.exec`, confirmation as `human.requested` |
| `services/hub.ts` + 400 ms poll per stream | Notify → SSE (§8) |
| `labels.ts` splice-seam labels, recording splice, Illustrative loops, `DANA_MODE=fixture` | Dropped (decided 2026-10-06). Labels move into the team definition; recorded logs survive only as test fixtures for the fold |

## 14. Decisions and open questions

**Decided**
- **2026-10-06: Demo machinery is dropped:** the recording splice, Illustrative loops, scripted Dana (`DANA_MODE=fixture`) and the splice-seam label constraints.
- **2026-10-06: No per-provider concurrency limiter.** Every `llm.call` retries a 429 with backoff, honouring `retry-after`. Self-hosters bring their own keys and set one knob, the worker's job concurrency. In the cloud, the concern is fairness between workspaces, not provider limits: cap concurrent jobs per workspace.
- **2026-10-08: Sessions run on the log in v1.** Channels, sessions that continue across devices, and long-running delegations all need a turn to outlive the client that started it. The spike's chat measurement still applies: first token through the queue within ~200 ms of a direct call.
- **2026-10-08: No workflow engine.** Temporal was reviewed as the alternative: the same model (event history, workflow tasks, activities), mature, with an AI SDK integration. It was set aside because the local server runs inside the desktop app, where Temporal's server can't. Five of its features became amendments above: per-job timeouts, heartbeats and retries (§4); validated answers to waits (§7); idempotent run creation (§5.2); schedule overlap rules (§9); replay tests in CI (§10). Its history limits motivated compaction for long sessions (§5.1).
- **2026-10-08: Large outputs** go to object storage: files in the app's data directory locally, S3-compatible elsewhere.
- **2026-10-12: Queue: own table.** The pg-boss probe (ANY-33) passes 11 of 12 conformance cases on both drivers — Q7's final assertion pins the id literal `qjob-1`, unsatisfiable on pg-boss's uuid ids — and exceeds the idle budget at 79 queries/min on both (limit 60, empty-claim probe alone is fetch + expiry + re-check); pickup p95 4.5 ms on PGlite and 16.3 ms on Postgres (limit 50) and the ~60 s dead-worker handover (limit 2× the 60 s lease) passed, but the rule needs all four.

**Queue: decided by the spike.** It must run unchanged on PGlite (single connection, in-process) and on Postgres.

| | Graphile Worker | pg-boss (v12) | Own `jobs` table |
|---|---|---|---|
| Runs on PGlite | Unknown: expects several connections and `LISTEN` | Unknown: expects a `pg` pool; `pglite-socket` may bridge it | Yes, by construction |
| Pickup latency | LISTEN/NOTIFY by default: a few ms | Polling by default (2 s, minimum 0.5 s); LISTEN/NOTIFY opt-in with a 30 s polling backstop | In-process wake locally; LISTEN/NOTIFY on Postgres |
| One decide at a time per stream | Named queue per stream, serial | `groupConcurrency: 1` grouped by stream | A per-stream lock column |
| Crashed worker | Jobs stay locked for 4 hours unless force-unlocked; heartbeat recovery is in the commercial Worker Pro | Per-queue `heartbeatSeconds` | Leases and heartbeats we write |
| Per-workspace cap | None built in | `groupConcurrency` grouped by workspace | A count in the claim query |
| Maturity | Long-stable core | Heartbeats and group concurrency are recent | New code: `SKIP LOCKED` claims, leases, heartbeats, backoff |

Decided: own table (the 2026-10-12 bullet under Decided above). Hermes Agent's hand-built cron and kanban (a long list of crash and ownership invariants in its `cron/AGENTS.md`) are the warning about how much an own queue grows; most of that list comes from many processes sharing files, which one database with transactions avoids.

**Still open**
1. **Token streaming transport** under load in the cloud: NOTIFY payloads are capped at 8 KB and share one channel.
2. **Idle database traffic** from the queue's polling, and whether Neon can scale to zero under it.

## 15. Spike

On a branch, with the queue options behind one small interface:
1. `events` table, `append()`, the queue, the agent loop, delegation in both modes, and the team loop for a two-stage team with no review gate. Run it on PGlite inside Electron's utility process and on a local Postgres container.
2. `llm.call` and `tool.exec` with the real Spark lane and the real Sprite tools (or local Docker).
3. `kill -9` at five points: during a model call, during a sandbox command, between jobs, while a parent waits on a child, during a `deliver`. Check that every run finishes, no result or message is recorded twice, and the loop view reads it correctly. Record how long each queue takes to hand a dead worker's job to another.
4. Measure, for each queue: the extra latency per hop (appends plus pickup, on PGlite, local Postgres and Neon), one decide at a time per stream under parallel lanes, and idle database traffic.
5. Chat check: one Dana turn through the queue, time from POST to first token versus today's direct stream.
6. PGlite checks: `pglite-pgvector` for memory and the registry, `SKIP LOCKED`, write throughput at a real run's event volume, data surviving a crash of the utility process, and the server's native dependencies (`onnxruntime-node` for embeddings) loading in Electron's utility process.

### R12 results (2026-10-15, ANY-38 — Ty, real credentials)

Environment: lane = self-hosted tensorfold **GLM-5.3-Flash-EXL3** on `ty-dgx-spark:8888/v1` (the `.env` Spark lane, `qwen3.8-flash-next` on :18300, was down — the DGX GPU is held by the live GLM server; a real self-hosted lane either way). Sprite = the real `fabric-coder` over `@fly/sprites`. Local Postgres = 17.10 on :55488. Neon = the project's own branch, dedicated `fabric_r12` database, direct (unpooled) endpoint, ~65 ms RTT. PGlite 0.3.16. `MODEL_PORT=ai`, `LLM_PROVIDER=spark`.

| # | Check (§) | Numbers | Verdict |
|---|---|---|---|
| 1 | Real lanes (§15.2) | Session turn end to end: 2× `llm.completed` (disposition + reply), `agent.message`, `message.delivered`, POST→reply ≈1.5 s; 0 duplicate facts (the fact-causation count, checked after the turn — telemetry carries no causation). Agent run with one real `sprite.exec`: 14.6 s wall, 2 model calls, 1 resolved tool run (first attempt a transient Sprite error, retried once), exactly one `run.finished` | **pass** for the turn proper (`message.received` → reply + delivery); everything after the turn is ANY-93's spin, not this check |
| 2 | Chat latency (§15.5) | POST → first token on the SSE stream: **1 606 ms** queued vs **1 151 ms** for the same call direct (+455 ms; a second run measured 14 540 ms — ANY-93's timer starvation). Only 1 delta frame arrived, **after** `llm.completed` (+93 ms), while the direct port streamed 42 | **fail** — over the ~200 ms target, and deltas never stream (ANY-94, ANY-95). Queue transport alone (POST→`llm.requested`) is 43–55 ms |
| 3 | Latency per hop (§15.4) | Hop table below: append p50/p95 and the production per-hop shape (append + enqueue in one transaction → a worker holds the job). Serial decide under 4 parallel lanes: max 1 lease per stream, 0 overlap instants (200 jobs, 8 streams) | **pass** locally; remote hops are RTT-bound — see the Neon column |
| 4 | Idle traffic, scale to zero (§9, §14 q2) | One idle claimer at the daemon's 200 ms poll: 295 statements/min (PGlite, local PG), 221/min (Neon); the **shipped daemon** (4 worker loops + the purge claim loop) measured **2 292/min** on Neon via `pg_stat_statements`. `SELECT 1` on Neon stayed 62–71 ms for the whole 6-min idle window — the compute never suspends under the queue | **fail vs the 60/min budget** — a database with a running server never sleeps; needs `claimWaiting` (wake) or a longer poll (ANY-100) |
| 5 | PGlite in Electron's utility process (§15.6) | The runtime does not start there — **no utility process exists**, so the Electron leg is unmeasured (ANY-97). Plain-Node supporting data: `SKIP LOCKED` ok; appends p50 2.6 / p95 4.7 ms; SIGKILL mid-write stream: 21/21 committed events recovered, no torn writes; `pglite-pgvector` loads + cosine query works on 0.5.10 — the store now pins PGlite 0.5.10 (Postgres 18.6) + `pglite-pgvector` 0.0.11 and refuses pre-18 data dirs with a clear delete-to-start-fresh error (ANY-96); the R12 "does **not** load on 0.3.16 (WASM ABI: `vacuum_delay_point`)" was a misdiagnosis — the standalone `pglite-pgvector` package targets the 0.5 line only, while 0.3.16 bundled `@electric-sql/pglite/vector`, which loads; `onnxruntime-node` 1.21.0 — already in the tree via `@huggingface/transformers` (`packages/agents/src/memory`) — loads in Node in 564 ms; its utility-process load is unmeasured (ANY-97) | **fail** as written — the check's host does not exist yet (ANY-96, ANY-97) |
| 6 | kill −9, real lanes (§15.3 K1/K2) | K1 (SIGKILL mid model call): handover 2 796 ms, settled 5 116 ms, one `llm.completed`, exactly-once `run.finished`. K2 (SIGKILL mid real sprite run): handover 2 841–3 000 ms, settled 8 109–11 979 ms, `tool.interrupted` recorded, the real command never ran to completion twice (0 resolved re-runs), the model saw the note and finished | **pass** |

**Hop table** (own `PgQueue`; "idle board" = the server daemon's shape — empty claim every 200 ms; Neon "production shape" = `kind: "postgres"` pool, what `bootstrap.ts` builds):

| | PGlite | local Postgres | Neon (direct, ~65 ms RTT) |
|---|---|---|---|
| append, 1 event/tx, p50/p95 (ms) | 2.64 / 4.70 | 1.58 / 5.61 | 405 / 456 |
| per hop — append + enqueue in one tx → claim, p50/p95 (ms) | 7.0 / 10.7 | 14.8 / 26.5 | 639 / 686 (42 / 69 measured from commit — the claim is fast; the WAN transaction dominates) |
| pickup, idle board (the daemon's 200 ms poll), p50/p95 (ms) | 111 / 201 | 117 / 192 | 278 / 289 |
| dead-worker handover (s) | 60.5 | 60.2 | 60.1 |
| idle statements/min, one claimer | 295 | 295 | 221 |
| idle statements/min, shipped daemon (4 worker loops + purge) | — (in-process) | — | **2 292** (pg_stat_statements, 3 min) |

The earlier single-run append means (2.88 and 5.63 ms on PGlite) both sit inside the distribution above. A continuous back-to-back enqueue bench on Neon once read 42–49 s "pickup" — an artifact of the bench's bare-`QueueTx` staged-apply path (production enqueues ride the store's transaction, as the per-hop row shows); recorded so the number is not mistaken for production behavior.

For the record, the retired pg-boss probe the same day: pickup 5.2/8 ms (PGlite), 3.7/5 ms (Postgres); idle 79/min; handover 60.0 s; Q7 fails on uuid ids (§14's known pin).

**Follow-ups filed under ANY-49:** ANY-93 (session decide re-appends `agent.message` forever — ~30 events/s, board never idles, `rt.stop()` hangs; reproduces with `MODEL_PORT=test`), ANY-94 (live deltas never stream with a real lane), ANY-95 (`llm.call` holds the serialized PGlite transaction across the whole model call), ANY-96 (PGlite 0.5 bump so `pglite-pgvector` loads), ANY-97 (Electron utility-process host), ANY-100 (idle polling vs the 60/min budget and scale-to-zero). The Sessions epic's chat-path acceptance is blocked on ANY-94/ANY-95; everything else above is recorded as measured.
