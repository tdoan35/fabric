# Fabric — Durable Runtime (proposal)

| | |
|---|---|
| Status | Draft proposal, 2026-10-06. Not built. Supersedes the in-process team engine for runs, errands and routines |
| Scope | How long-running work is stored, resumed and observed, for one self-hosted user and for a many-user cloud, with the same code |
| Decision | Event-sourced run logs in Postgres, a Postgres job queue, and stateless workers. No message broker, no workflow engine |

## 0. Summary

Every run is an append-only **log** of events in Postgres. The log is the source of truth, the inspector's data and the resume point. A pure **fold** turns the log into the run's current state; a **decide** function looks at that state and queues the next **jobs** (call a model, run a tool, wait for a person, finish). Stateless **workers** pull jobs from a Postgres queue, do the work, and append the result in the same transaction that queues the next decision. A crash loses at most the job in flight, which is retried; results are keyed by job, so a retry can't record anything twice.

Self-hosted: one process runs the API and a worker, against one Postgres. Cloud: API servers plus an autoscaled worker pool, against Postgres partitioned by tenant.

```
 triggers: user message · approval · schedule · inbound email · webhook
        │ append
        ▼
 ┌───────────────────────────── Postgres ─────────────────────────────┐
 │ events (per-run logs, append-only)    ◀── results ──┐               │
 │ jobs (Graphile Worker or pg-boss)     ─── jobs ──┐  │               │
 │ NOTIFY on append → API servers → SSE to clients  │  │               │
 └──────────────────────────────────────────────────┼──┼───────────────┘
                                                    ▼  │
        workers: fold(log) → decide(state, now) → jobs │
                 llm.call · tool.exec · finalize ──────┘
```

## 1. Why: what happens today

A team run lives in an in-memory `Map` in the server process (`packages/agents/src/team/engine.ts`). Production holds the evidence: `run-engram-lookup-table-on-nand-for-small-models-1` started at 23:46 UTC on Oct 4. Plan, Survey and Setup finished by t=207 s, Sana's "Prep checks" never finished, nothing was written after that, and the run still reads `running`. Nothing can resume it: the position in the workflow, the in-flight model calls and the cost meter (`runCostUsd`, in memory) are gone.

The same trace shows two more costs of the current shape:
- **Narration arrives late.** `generateText` runs a step's whole tool loop and returns all its text at the end, so Megan's narration of searches at t=20–47 s was written at t=172–200 s.
- **The log is mostly terminal output.** 166 of the run's 203 events are `tool.result` terminal lines.

## 2. The model

| Concept | What it is |
|---|---|
| **Stream** | One log: `run:<runId>` now; `session:<sessionId>` later for chat. Has a head sequence number and a tenant |
| **Event** | An immutable record appended to a stream: type, actor, payload, `seq`, `v` (payload version), `causation` (the job that produced it), `class` |
| **Fact** | An event the fold reads: lifecycle, model replies, tool results, verdicts, human responses |
| **Telemetry** | An event only the UI reads: terminal lines, narration copies, budget ticks. The fold skips them |
| **Fold** | `fold(facts) → RunState`. Pure and deterministic; the only code that must be |
| **Decide** | `decide(state, definition, now) → { events, jobs }`. Runs after every fact; its output is recorded, never replayed, so it is free to change between deploys |
| **Job** | A unit of work in the queue with an idempotency key. Executed at least once; its result is recorded at most once |
| **Definition** | The team workflow, members, brief, budgets and engine version, snapshotted into `run.created`. Editing a team never changes a run already under way |

**Append** is one transaction: bump the stream head, insert the events, `pg_notify` the stream, and queue `run.decide` for the stream. A unique index on `(stream_id, causation)` for result events makes a retried job's second append a no-op.

**One decision at a time per run**: `run.decide` jobs are serialized per run (a named queue per run in Graphile Worker, or `groupConcurrency: 1` grouped by run in pg-boss). Executor jobs aren't, so a stage's lanes run in parallel.

## 3. Events

Existing types keep their names and payloads so the web app's read model (`deriveSegments`) keeps working. New fact types carry what the runtime needs to resume.

| Type | Class | Payload (new fields in bold) | Appended by |
|---|---|---|---|
| `run.created` | fact | **definition snapshot, engineVersion, budgets** | API / Dana handoff / schedule fire |
| `run.started` | fact | objective | decide |
| `step.started` | fact | label, stage, kind, **stepKey, pass** | decide |
| `llm.requested` | fact | **stepKey, callNo, model, params, snapshotId** | decide |
| `llm.completed` | fact | **stepKey, callNo, text, toolCalls[], usage, finishReason, model** | `llm.call` |
| `llm.failed` | fact | **stepKey, callNo, error, retryable** | `llm.call` |
| `tool.call` | fact | tool, summary, **callId, args, effect** | decide (was: the tool itself) |
| `tool.completed` | fact | **callId, ok, result or resultRef, error** | `tool.exec` |
| `tool.interrupted` | fact | **callId, effect, note** | `tool.exec` on recovery (§6) |
| `tool.denied` | fact | tool, target, reason, **callId** | decide (policy check) |
| `step.finished` | fact | label, stage, kind, **stepKey, outcome: done · timed_out · failed · cancelled** | decide |
| `review.verdict`, `criterion.checked` | fact | unchanged (from `llm.completed` structured output) | decide |
| `rework.requested` | fact | to, used, budget | decide |
| `human.requested` | fact | **waitId, kind: confirm · approve · answer, prompt, deadline** | decide |
| `human.responded` | fact | **waitId, decision, by** | API |
| `run.cancel_requested` | fact | **by** | API |
| `run.blocked`, `run.stopped`, `run.finished` | fact | unchanged | decide / `run.finalize` |
| `artifact.created` | fact | name, artifactId | `tool.exec` |
| `context.snapshot` | telemetry | snapshotId (the snapshot row is written before the model call) | `llm.call` |
| `tool.result` (term line) | telemetry | line, kind | `tool.exec`, streamed |
| `agent.message` | telemetry | text (a copy of `llm.completed.text` for the UI) | decide |
| `budget.update` | telemetry | costUsd (folded from usage), rework counts | decide |
| `handoff` | telemetry | to, step | decide |

Model token deltas never enter the log: they are pushed live (§8) and the final text lands in `llm.completed`.

## 4. Jobs

| Job | Idempotency key | Does | Appends |
|---|---|---|---|
| `run.decide` | per-run serial queue | Fold, decide, append decisions, queue jobs | step/llm/tool/human/lifecycle facts |
| `llm.call` | `run:step:llm:n` | Assemble context, save snapshot, call the model **once** with tools that have no `execute` (the SDK returns tool calls instead of running them), stream deltas live | `llm.completed` or `llm.failed`, `context.snapshot` |
| `tool.exec` | `run:callId` | Run one tool from `@fabric/integrations` with the step's policies; stream terminal lines | `tool.completed` or `tool.interrupted`, `artifact.created`, term lines |
| `run.timer` | `run:timer:<id>` | A `run.decide` scheduled with `run_at`: step timeouts, human deadlines, time budgets | via decide |
| `run.finalize` | `run:finalize` | Report, Weave item, Dana's results message, report email; each part checks its own "done" fact first | `run.finished`, report facts |
| `schedule.fire` | `schedule:<id>:<slot>` | Scheduled with `run_at = slot`. Late beyond 10 minutes: marks the fire missed. Otherwise creates the run and plans the next slot | `run.created` |

## 5. Team runs: state and decisions

```ts
interface RunState {
  status: "running" | "waiting" | "blocked" | "accepted" | "stopped";
  def: Definition;                  // from run.created
  pass: 1 | 2; reworkUsed: number; reviews: number;
  steps: Map<string, StepState>;    // stepKey = stage|agent|pass
  costUsd: number;                  // Σ llm.completed.usage, priced
  waits: Map<string, Wait>;
  cancelRequested: boolean;
}
interface StepState {
  agentId: string; stage: string; label: string;
  status: "running" | "done";
  calls: number;                    // llm.completed so far
  openToolCalls: Set<string>;       // tool.call without tool.completed/interrupted
  startedAt: number;
}
```

`decide` for a team run, in order:
1. **Cancel or budget.** `cancelRequested` → finish open steps as `cancelled`, append `run.stopped`. Cost or time over budget → `run.blocked` with the reason.
2. **Current stage(s).** From `planPasses(def.workflow)` (unchanged): Plan runs alongside Prepare, then the middle stages in order. For each lane of the current stage without a step: `step.started`, `llm.requested`, queue `llm.call`.
3. **Each running step:**
   - last fact is `llm.completed` with tool calls → for each call, check policy: `tool.denied` or `tool.call` + queue `tool.exec`;
   - all of its tool calls resolved → `llm.requested` for call n+1, unless `calls = MAX_STEPS`;
   - `llm.completed` with no tool calls, or `MAX_STEPS` reached → `agent.message` copies, `step.finished(done)`;
   - `llm.failed` → one retry if retryable, else `step.finished(failed)` with a narration (today's behaviour);
   - past its timeout → `step.finished(timed_out)`; a `run.timer` is queued at each step's deadline.
4. **Stage complete** (all lanes finished) → the next stage; at the gate, the reviewer's structured `llm.call` → `review.verdict`:
   - accept → `run.finished` path: queue `run.finalize`;
   - request changes → `rework.requested` and pass 2 (Re-plan → Rework → Re-check), or `run.blocked` when `bounceOutcome` says the budget is spent.

The step's conversation for call n+1 is rebuilt from facts: the snapshot's system prompt, the step prompt, then each earlier `llm.completed` (text + tool calls) followed by its `tool.completed` results. Large tool results live in object storage, referenced by `resultRef`.

## 6. Side effects

Every tool declares its effect class. `tool.call` (with the class) is appended **before** `tool.exec` runs, so after a crash the runtime knows what was attempted.

| Effect | Tools | A retried `tool.exec` finds no result |
|---|---|---|
| `read` | `exa.search`, `artifacts.read` | Runs again |
| `idempotent` | `artifacts.write`, `workspace.write` (upsert by name/path) | Runs again |
| `rerunnable` | `sprite.exec` | Appends `tool.interrupted` ("interrupted by a restart; effects may be partial"). The model sees it as the result and decides whether to run it again |
| `once` | `agentmail.send`, `browser.task` submit, anything that pays or books | Never runs again. Appends `tool.interrupted`, then `human.requested` ("check whether this happened"). Uses the provider's idempotency key where one exists |

## 7. Waits, cancellation, budgets

- **Waits.** `human.requested` sets status `waiting` and queues a `run.timer` at the deadline. The API appends `human.responded` when the person answers. The browser booking confirmation becomes exactly this, replacing the `pendingAction` patched into `runs.budget`.
- **Cancellation.** The API appends `run.cancel_requested`. Workers holding jobs for that run get a NOTIFY and abort in-flight model calls; late results are refused by the append guard (today's `RunClosedError`).
- **Budgets.** Cost is folded from `llm.completed.usage`, so it survives restarts. Time budgets and step timeouts are `run.timer` jobs.

## 8. Live updates

Every append calls `pg_notify('stream', '<tenant>:<stream>:<seq>')`. API servers `LISTEN`, read new events, and push them over SSE; clients resume with `Last-Event-ID = seq`. Model token deltas from `llm.call` go out on the same channel, batched about every 100 ms, and never enter the log. This replaces the in-process hub and the 400 ms database poll per stream. When NOTIFY stops scaling, the same outbox feeds Redis or NATS.

`LISTEN` and the job queue need a direct (unpooled) connection; HTTP handlers keep using the pooled one.

## 9. Schedules

Each enabled schedule always has its next `schedule.fire` job queued with `run_at = slot`. There is no 30-second tick, so an idle tenant does no work and its database can scale to zero. The "older than 10 minutes counts as missed" rule moves into the job.

## 10. Versioning

- **Events** carry `v`. Old payloads are upgraded on read (upcasters), never rewritten.
- **Runs** pin `engineVersion` in `run.created`. `decide` dispatches on it; an old version's `decide` stays in the code until no unfinished run uses it.
- **Fold** changes must read every older event shape. That's the one place deploys need care, and it's plain data code with tests over recorded logs.

## 11. Tenancy

`tenant_id` on streams, events, jobs and every domain table. Workers run each job in a transaction with `SET LOCAL app.tenant_id`, and row-level security enforces it. Self-hosted is one tenant. Per-tenant queues or concurrency caps come later if one tenant's runs starve others.

## 12. Paper test: the stuck production run

The real trace of `run-engram-lookup-table-on-nand-for-small-models-1`, replayed through this design:

| t (s) | Today | This design |
|---|---|---|
| 0.7 | `run.started` | `run.created` → decide: `run.started` |
| 4.1 | 4× `step.started` (Plan ∥ Prepare) | decide: 4× `step.started` + `llm.requested`, 4 `llm.call` jobs run in parallel |
| 4–55 | Tool events stream; narration held back | Each lane cycles `llm.completed` → `tool.call` → `tool.exec` → `tool.completed` → next `llm.call`. Narration is in each `llm.completed`, visible as it happens |
| 20–47 | Megan's 3 searches run | Same, each a `tool.exec` (`read`) |
| 166 | Jonah's Setup finishes | `step.finished(done)` for Jonah |
| 172–200 | Megan's narration finally written | Already shown at t=20–47 |
| 206.9 | Elliot's Plan finishes. Sana still mid-step | Same |
| ~207 | **Process dies. Run stuck as `running` forever** | Process dies. Last facts for Sana: `llm.completed` (call 3) asking for `sprite_exec`, and its `tool.call`, without a result |
| restart | Nothing | The worker comes back (self-hosted) or another worker takes the job once its lease lapses (cloud). `tool.exec` finds no result for a `rerunnable` call → `tool.interrupted` → decide → Sana's `llm.call` 4 sees "interrupted" and re-runs her check |
| then | — | Sana's step finishes → Prepare is complete → decide starts Synthesize (Elliot). The run continues |

Cost of the crash: one interrupted sandbox command and one extra model call. Changes this test forced into the design: telemetry is a separate event class so the fold ignores 80% of the log; narration comes from each model reply instead of the end of the step; tool-argument failures (Elliot's "the content parameter isn't attaching") become `tool.completed {ok: false}` facts that are visible and countable.

## 13. From today's code

| Today | Becomes |
|---|---|
| `run_events` + `RunWriter.emit` (advisory lock + `max(seq)+1`) | `events` with `tenant_id`, `v`, `causation`, `class`; `append()` bumps a stream head row and notifies |
| `team/engine.ts` `executeWorkflow` (in-memory, long-lived) | `team/decide.ts`, pure; `planPasses` and `bounceOutcome` reused as they are |
| `team/steps.ts` `runStep` (whole tool loop in one `generateText`) | `llm.call` (one model call, tools without `execute`) and `tool.exec` (one tool) |
| `tool-context.ts` `ToolIO` emitting `tool.call` itself | decide appends `tool.call`; `ToolIO` keeps streaming term lines |
| `llm` meter `runCostUsd` (in memory) | `llm.completed.usage`, folded |
| `services/finalize.ts` (called from `RunWriter.end`) | `run.finalize` job, each part idempotent |
| `services/scheduler.ts` 30 s tick + claims | `schedule.fire` jobs at each slot |
| `assistant/errand.ts` + `pendingAction` in `runs.budget` | Errand `decide`: browser steps as `tool.exec`, confirmation as `human.requested` |
| `services/hub.ts` + 400 ms poll per stream | NOTIFY → SSE (§8) |
| `labels.ts` splice-seam labels, recording splice, Illustrative loops, `DANA_MODE=fixture` | Dropped (decided 2026-10-06). Labels move into the team definition; recorded logs survive only as test fixtures for the fold |

## 14. Decisions and open questions

**Decided (2026-10-06)**
- **Demo machinery is dropped:** the recording splice, Illustrative loops, scripted Dana (`DANA_MODE=fixture`) and the splice-seam label constraints.
- **No per-provider concurrency limiter.** Every `llm.call` retries a 429 with backoff, honouring `retry-after`. Self-hosters bring their own keys and set one knob, the worker's job concurrency. In the cloud, the concern is fairness between tenants, not provider limits: cap concurrent jobs per tenant (see the queue comparison).

**Chat turns (phase 2, after runs).** Today a turn writes the user's message first and Dana's reply only when the stream ends; side effects in between (stored proposals, dispositions, a handoff's task and run, an errand) are written as they happen. A turn that dies midway leaves a saved question, no reply, and possibly side effects nobody was told about. Two ways out:

| | Request-scoped, hardened | On the log (`session:` streams) |
|---|---|---|
| Consistency | Side effects keyed by tool-call id; reply and tool results in one transaction; a "retry" for a question without a reply | Each step appends facts and queues the next job in one transaction; the thread is a projection of the log |
| Survives a disconnect or restart | No: the turn lives in one HTTP response and one process | Yes: close the laptop and the reply is waiting; the phone gets a push |
| Latency | Direct stream, no queue | A queue hop per step: milliseconds with push pickup, seconds with polling |
| Approvals, proposal cards | Human-tool round trip through the client | `human.requested` / `human.responded`, like errands |
| Multi-device, inspector | Extra work | Free: every client follows the same stream; Dana's turns read like runs |
| Client change | None | POST the message, then follow the session stream |

Recommendation: the log, once runs work, provided the spike's chat measurement holds (first token through the queue within ~200 ms of a direct call). It needs a queue with push pickup.

**Queue: Graphile Worker or pg-boss.** Decided by the spike.

| | Graphile Worker | pg-boss (v12) |
|---|---|---|
| Pickup latency | LISTEN/NOTIFY by default: a few ms | Polling by default (2 s, minimum 0.5 s); LISTEN/NOTIFY opt-in (`useListenNotify`) with a 30 s polling backstop |
| One decide at a time per run | Named queue per run (`queue_name`), serial | `groupConcurrency: 1` with group = run id |
| Crashed worker | Its jobs stay locked for 4 hours unless force-unlocked by worker id; heartbeat recovery is in the commercial Worker Pro | Per-queue `heartbeatSeconds`: a job fails over as soon as its heartbeat goes stale |
| Per-tenant cap (cloud fairness) | None built in | `groupConcurrency` with group = tenant, enforced across nodes |
| Dedupe, delays, cron | `job_key`, `run_at`, crontab | singleton policies / `singletonKey`, `startAfter`, schedules |
| Maturity | Long-stable core | Heartbeats and group concurrency are recent |

Leaning pg-boss: heartbeats and group concurrency solve cloud crash recovery and tenant fairness without extra code, as long as its LISTEN path is fast and reliable in the spike. Otherwise Graphile Worker, with our own heartbeat table driving `force_unlock_workers`.

**Still open**
1. **Large outputs:** object storage for tool results and artifacts (S3-compatible; local disk when self-hosted).
2. **Token streaming transport** under load: NOTIFY payloads are capped at 8 KB and share one channel.

## 15. Spike

On a branch, against a local Postgres container, with both queues behind one small interface:
1. `events` table, `append()`, the queue, and `decide` for a two-stage team with no review gate.
2. `llm.call` and `tool.exec` with the real Spark lane and the real Sprite tools.
3. `kill -9` at three points: during a model call, during a sandbox command, between jobs. Check that the run finishes, no result is recorded twice, and the loop view reads it correctly. Record how long each queue takes to hand a dead worker's job to another.
4. Measure, for each queue: the extra latency per hop (appends plus pickup, on Neon and local), one decide at a time per run under parallel lanes, and idle database traffic.
5. Chat check: one Dana turn through the queue, time from POST to first token versus today's direct stream.
