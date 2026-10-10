# Fabric — Learning

| | |
|---|---|
| Status | Draft, 2026-10-10. Not built |
| Scope | How agents learn and forget on a user's server: skills, memory, Dana's routing, and hiring. What Fabric measures on its own budget is in `LAB.md` |
| Builds on | `CONCEPT.md` §2 invariants and §4.1 (Dana's envelope); `ARCHITECTURE.md` §3–§9; `RUNTIME.md` (events, jobs) |
| Decision | Agents learn skills under an enforced context budget, with a lifecycle that strengthens what is used and works and forgets what isn't. Skills need no approval; changes to the organization do. The runtime never spends a user's tokens on evaluation unless they ask |

## 0. Summary

Fabric learns at three levels: the **organization** learns which agents exist, each **agent** learns skills and memory for its domain, and **Dana** learns where to route. Only the agent level costs prompt tokens, and it is capped per agent.

Skills move through a lifecycle driven by a strength score computed from the log: a skill that is used and works gets stronger; one that isn't fades out of the prompt, then into the archive, then is deleted. A skill that outgrows Dana becomes the seed of a hire. Evaluation is the lab's job (`LAB.md`); the runtime reads evidence the log already holds and applies thresholds the lab calibrates.

```
 run ends · session goes quiet ──▶ learn job ──▶ candidate skills · memory · outcomes
                                                        │
 daily: skills.maintain (no model) ◀────────────────────┘
        strength from the log → promote · fade · archive · delete · enforce the budget
                                                        │
 weekly: org.review (Dana) ─────▶ hire · split · merge · retire proposals ──▶ you approve
```

All numbers in this document are starting values. The lab tunes them (`LAB.md` §7) and ships them in the policy pack.

## 1. Why: what goes wrong elsewhere

Hermes Agent and Prime Agent both learn by writing files that are loaded back into the prompt; neither changes model weights. Reviewed 2026-10-10 against their source, docs and issue trackers ([Hermes Agent](https://github.com/NousResearch/hermes-agent), [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent)), and against long-term use of Hermes.

| Seen elsewhere | Response here |
|---|---|
| The main agent's prompt grows until it rots; the user prunes skills by hand. Hermes's skill index reached ~6.8k tokens at 275 skills | A context budget per agent; overflow demotes skills out of the prompt, never grows it (§3) |
| Skill sprawl: near-duplicates, one-off corrections saved as standing rules | New skills are fenced and searchable only; an overlap check; "prefer writing nothing" (§5.4, §6.2) |
| Wrong lessons applied silently; nothing measures whether a skill helps. Hermes records recency, not effect | Strength weighted by outcomes; demotion and rollback on negatives (§5.2, §5.3); uplift measured in the lab (`LAB.md` §3) |
| Inconsistent or destructive cleanup: an LLM curator deleted 80+ skills and broke scheduled jobs that referenced skills | Maintenance is deterministic; references protect a skill; deletion is tiered by value (§5.3, §5.5) |
| Approval queues nobody clears: 357 pending proposals in 8 days, none approved | No approval for skills; approval only for organization changes (§2) |
| Lessons applied too widely: one project's facts used everywhere; a review agent's instructions saved as user preferences | Scopes (`ARCHITECTURE.md` §8.3); new skills fenced to where they were learned; personal memory only by explicit promotion |
| Models outgrow skills, which keep costing tokens | Catalog skills load per model; a model change re-resolves them (§8) |
| Self-refinement saved an exploit as a reusable skill (Prime Agent's Factorio run) | Skills can't grant tools; writes are scanned; the learner can't edit how it learns (§6.3, §6.4) |

## 2. Principles

1. **The lab spends tokens; the runtime reads evidence.** Evaluation happens in Fabric's lab. The runtime decides with signals the log already holds. The one background model spend in the runtime is learning itself (§6.5), bounded by a budget and attributed like any other cost.
2. **Every agent has a context budget,** enforced by the runtime. Learning changes what fills the budget, never its size.
3. **Learning is scoped.** A lesson starts as narrow as the evidence behind it and widens only on further evidence.
4. **Skills need no approval; the organization does.** Hiring, splitting, merging or retiring agents and teams, adding tools, and promoting into personal memory always ask you (CONCEPT §2.2, §2.9). Everything else is visible in Agent Studio and the weekly digest, and reversible.
5. **The learner can't change how it learns.** The learning skill is yours to edit; the learn job reads it and never writes it.
6. **Forgetting is deterministic.** Strength, fading and deletion are computed from facts by a job with no model in it, so the same history always gives the same result.

## 3. The context budget

An agent's base context is its `SOUL.md`, `IDENTITY.md`, `USER.md`, tool definitions, skill index and recalled memory. It is measured at every context assembly and shown in Agent Studio (CONCEPT A-10).

The **learned share** (the skill index plus the recalled-memory digest) has a cap per agent:

| Agent | Learned share |
|---|---|
| Dana | 1,000 tokens; her whole base context stays near 2k (CONCEPT A-10) |
| Team lead | 2,000 tokens |
| Specialist | 3,000 tokens |

- **A write never fails for lack of room.** New skills enter as candidates, outside the index (§5.4). Hermes's memory writes fail silently at its cap; that can't happen here.
- **The index holds active and established skills, strongest first.** When they don't fit, `skills.maintain` moves the weakest to dormant: out of the index, still found by search.
- **Persistent pressure is a structural signal, not a pruning problem.** When established skills alone exceed the cap, `org.review` considers a split or a consolidation (§9).
- **Identity files and tools are measured, not capped by learning.** They change only through approved organization changes.
- **Index lines** are `name — description`, at most 100 characters. Bodies load on demand through `skills.read`, which is a tool call, so every load is in the log.
- **Prompt caching.** The index changes at most once a day per agent (when `skills.maintain` runs), so the provider's cache stays warm.

## 4. Three levels of learning

| Level | Who learns | What | Stored as | Prompt tokens |
|---|---|---|---|---|
| Organization | Dana, through `org.review` | Which agents and teams exist: hire, split, merge, retire | Proposals (CONCEPT §7) | None |
| Agent | Every agent, through the `learn` job | Skills and memory for its domain | Skills (§5); memory items (§10) | Within §3's budget |
| Routing | Dana | Which disposition and target suit which kind of request, for you | Routing data | None |

**Routing data** is folded from `disposition.recorded` and outcomes: dispositions and how they turned out, taps on "go deeper", mid-task escalations, and your corrections ("no, give that to Megan"). It reranks `registry.search` results and moves the line of Dana's envelope for you (CONCEPT §4.1). It is data, not text in Dana's prompt; at most it surfaces as a one-line hint when relevant ("you usually want depth on AI-model topics").

## 5. Skills

### 5.1 What a skill is

- **Format.** A `SKILL.md` folder in the Agent Skills format (`ARCHITECTURE.md` §9), plus fields Fabric keeps outside the file: id, version, owner agent, scope, origin, source (`learned` · `user` · `catalog`), state, pinned.
- **Versions.** Every create or patch is a new version, stored by reference (§10.4). A run pins the skill versions in its snapshot, so editing a skill never changes a run under way, and rolling back reactivates an earlier version.
- **Origin.** A learned skill records the stream and events it was learned from. That is the first evidence on its card, and the first test case if anyone tests it (`LAB.md` §11).
- **Scope.** `project:<id>` or `agent` (all of the agent's work). A skill belongs to one agent; installing it in another agent makes a copy.

### 5.2 Strength

Strength is how practiced a skill is, computed from its uses:

```
strength = ln( Σ_j  w(outcome_j) · (t_now − t_j)^(−d) )        over the skill's uses j
```

This is ACT-R's base-level activation, a standard model of human recall: frequent and recent use keeps something available, and availability fades as a power of the time since each use. Each use is weighted by how it went:

| Outcome | Weight | Evidence, free from the log |
|---|---|---|
| Positive | 1.0 | The run was accepted at review, or you accepted the result, and no correction followed |
| Neutral | 0.5 | No signal either way |
| Negative | 0, counted separately (§5.3) | Rework requested, a correction, the run blocked, or the result rejected |

`d` starts at 0.5, ACT-R's usual value.

A **use** is a `skills.read` of the skill during a run or a session turn. Its outcome is set when the run finishes or the session goes quiet, and recorded as `skill.used` on the agent's stream. If the learn job later finds a correction, it appends a `skill.used` that revises the outcome.

### 5.3 Lifecycle

| State | In the index | Found by search | Entered when |
|---|---|---|---|
| `candidate` | No | Yes, within its scope | The learn job writes it (§6), or you ask an agent to remember how to do something |
| `active` | Yes | Yes | 3 positive uses with no negative, or you pin it |
| `established` | Yes | Yes | Strength stays above the established line for 30 days |
| `dormant` | No | Yes | Strength falls below the active line, or the budget squeezes it out (§3) |
| `archived` | No | Only when nothing current matches | Dormant for 60 days, or a candidate unused for 30 days |
| deleted | — | — | Its archive window ends (§5.5); a tombstone stays |

- **Demotion on negatives.** 2 negatives in the last 10 uses demote a skill one state (`established` → `active` → `candidate`), whatever its strength. If the negatives started with a new version, the previous version is reactivated instead.
- **Restore.** A dormant or archived skill that is found by search and used successfully returns to `active` with part of its old strength, because relearning is faster than learning.
- **Consolidation.** Established skills that overlap heavily in one domain can be merged by the learn job into one broader skill. The merged skill starts `active`; the originals go dormant with `absorbedInto` set, so nothing is lost.
- **Pinned skills** never fade and are never deleted. A skill referenced by a schedule, a team definition or another skill counts as pinned while the reference exists.
- **You can always** edit, pin, demote, archive or delete a skill directly. Your edits are versions like any other.

### 5.4 Fencing new lessons

Most of Hermes's damage came from new lessons applied everywhere at once.

- **A candidate is in no index.** It is found only by `skills.search` within its scope: the project it was learned in, or the agent if there was no project.
- **It enters the index only on evidence** (§5.3).
- **Overlap check.** Before a create is applied, the runtime compares it by embedding with the agent's skills, including dormant and archived ones. Above the threshold, the create becomes a patch to the existing skill, or is dropped as a duplicate.
- **Patches take effect at once** as a new version; negatives in its first uses roll it back (§5.3).

### 5.5 Deletion

Archived skills are deleted when their window ends. The window depends on how valuable the skill ever was:

| Skill | Deleted after |
|---|---|
| A candidate never promoted | 30 days in the archive |
| Reached `active`, never `established` | 6 months in the archive |
| Reached `established` | 1 year in the archive, which covers once-a-year work |
| Pinned, or referenced by a schedule, team or skill | Never automatically |

- **Keep everything** is a setting that turns automatic deletion off; archived skills then stay until you delete them. Off by default.
- **Notice.** Deletions due in the coming week are listed in the weekly digest (§11), where you can pin anything to keep it.
- **What's left.** Deletion removes the content (§10.4) and leaves a tombstone: id, name, dates and the reason.

## 6. The learn job

### 6.1 When it runs

On events, never on turn counters:

| Trigger | Runs when |
|---|---|
| An agent run finishes | It had rework, a review asking for changes, a block it recovered from, a denied or failed tool it worked around, a correction in an answer to `ask_user`, or more than 20 steps (it may hold a reusable procedure) |
| A session goes quiet for 30 minutes, or is compacted | The segment since the last learn job had feedback, a correction, or more than 10 tool calls |
| A scheduled run finishes | Only on failure or a correction |
| You ask | "Remember how to do this", or the learn action in the UI |

The job key is `learn:<stream>:<upToSeq>`, so a segment is learned from once.

### 6.2 What it does

One model call, with a small tool loop for reading skills. It receives:
- the segment's facts, compacted: inputs, tool calls, results by reference, outcomes;
- the agent's skill index, and the skills the segment loaded;
- skills found by search for the segment's topic;
- the learning skill (§6.4).

It returns structured output, validated like a delegation's output contract:

```ts
{
  skills:   [{ op: "create" | "patch", skillId?, name, description, body, scope, evidence: Seq[] }],
  memory:   [{ scope, op: "add" | "update" | "forget", content, evidence: Seq[] }],
  outcomes: [{ skillId, outcome: "positive" | "neutral" | "negative", evidence: Seq[] }],
  nothing?: string   // why nothing was worth keeping
}
```

- **Every write cites the events it came from.** A write without evidence is rejected.
- **Prefer writing nothing** over a speculative or one-off lesson (Prime Agent's refinement prompt makes the same call), and **patch before create** (Hermes's review order). Both are in the learning skill.
- **Applying.** Skills become candidates or patches (§5.4), memory becomes `memory.written` in the allowed scopes, outcomes become `skill.used`. The job ends with `learning.completed`: what it considered, wrote and skipped, and what it cost.

### 6.3 Guards

Enforced by the runtime when writes are applied, not by the prompt:

- **Own skills and allowed scopes only.** Never another agent's skills. Never personal memory, except Dana's own writes (`ARCHITECTURE.md` §8.3).
- **A skill can't grant anything.** A skill that needs a tool its agent lacks is not written; it becomes an outgrow signal (§7.2) and its evidence goes to `org.review`.
- **Read-only:** the learning skill and any user-owned skill.
- **Scanned:** every write, for prompt-injection and secret patterns. On by default; Hermes leaves this off for agent-written skills.
- **Size cap:** a skill body is at most 2k tokens; longer material goes into the skill's reference files.
- **Read before patch:** a patch is refused unless the job read that skill.

### 6.4 The learning skill

How to learn is a skill, so you can read and change it: what counts as a lesson, how narrowly to scope it, when to patch and when to create, what goes in memory and what in a skill. Fabric ships it in the policy pack (`LAB.md` §2); you own your copy. One learning skill serves every agent; Dana's section adds the organization-level signals (§7, §9).

### 6.5 Cost

The learn job is the only background model spend in the runtime.
- It runs on the agent's model, or a cheaper one you choose.
- Its cost is attributed to the source run or session, as learning.
- It draws from a monthly **learning budget**. When the budget is spent, learning pauses and Agent Studio says so; nothing else changes.

## 7. Dana

### 7.1 Her layer

Dana does one layer of work herself and delegates or hires for the rest: an executive assistant, not a super-agent. She handles requests inside her envelope (CONCEPT §4.1): her assistant tools, general knowledge, a few steps, reversible or gated.

- **Starting skills** (proposed): scheduling, email triage and drafting, quick research briefings, summaries, reminders, notes.
- **Routing is not a skill.** It applies to every request, so it lives in her core instructions.
- **Same lifecycle,** under the tightest budget (§3).

### 7.2 When a skill outgrows Dana

A skill that outgrows Dana becomes the seed of a hire: it moves to the new specialist, and Dana keeps a routing entry instead. Like an assistant who has been doing the books proposing a bookkeeper, and handing over their notes.

Signals, free from the log, with thresholds from the lab (`LAB.md` §8):

| Signal | Kind |
|---|---|
| A skill needs a tool outside Dana's toolset | Hard: enough on its own |
| One domain's skills take more than a third of Dana's learned share | Soft |
| Dana keeps escalating mid-task in one domain (CONCEPT §4.1) | Soft |
| Negatives rising on one domain's skills | Soft |
| Enough volume in the domain for a specialist to pay off | Required with any soft signal |

A domain is a cluster of skills and requests, by tags and embeddings. When signals cross their thresholds, `org.review` (§9) looks first for a catalog specialist that covers the domain (`LAB.md` §9), then drafts a custom one.

## 8. Catalog skills and models

### 8.1 Loading

Catalog skills ship with the lab's verdict for each measured model (`LAB.md` §3):

| Verdict for the agent's model | What the runtime does |
|---|---|
| Helps | Loads it. It enters as `active`: it is vetted, so it skips the candidate stage |
| Not needed, or hurts | Doesn't load it. Agent Studio lists it as "not needed on this model" |
| Unmeasured | Loads it, marked "unverified". Self-hosted users run many checkpoints; the lab measures the common ones |

After that, catalog skills follow the lifecycle: unused ones fade like any other, and local negatives can demote one for this workspace whatever the lab says. Lab results describe the average user; your log describes you.

### 8.2 When an agent's model changes

- Catalog skills are re-resolved against the verdicts for the new model.
- Personal skills keep their state but go on probation for their next 10 uses, where a single negative demotes, because there is no evidence for them on the new model yet.
- Nothing is evaluated on your tokens.

## 9. Organization review and hiring

### 9.1 `org.review`

Weekly, and at once on a hard signal. The signals are checked first, with no model; Dana writes a proposal (one model call each) only when something crosses a threshold.

| Proposal | Triggered by |
|---|---|
| Hire a specialist or team | Outgrow signals (§7.2). Work that needs tools no agent has is also proposed in the moment, as the *propose* disposition (CONCEPT §4) |
| Split an agent | Persistent budget pressure (§3) with two or more domains among its established skills |
| Merge agents | Two agents whose registry cards and routed work overlap |
| Retire an agent | Nothing routed to it for 60 days, or a failed probation |

Each is an organization change, so each asks you (CONCEPT §2.2).

### 9.2 The hiring card

- **Evidence:** links to the runs that show the need.
- **Expected outcome:** what should improve ("fewer corrections on contract reviews"), so probation has something to check.
- **Overlap check:** the closest existing agents. If one is close, Dana proposes extending it instead.
- **Catalog first:** a catalog specialist arrives with its lab benchmark (`LAB.md` §9).
- **What moves:** the skills that seed the hire.

You approve with one tap. Everything after that is silent unless it needs you.

### 9.3 Probation

Probation watches real work and never runs extra work.
- **Length:** 10 tasks or 30 days.
- **Comparison:** against similar tasks before the hire, from the log: rework, corrections, cost, time.
- **At the end:** keep, silently; or a recommendation to adjust or retire, which is an ask.

### 9.4 Dana's hiring scorecard

How often you accept her proposals, how many hires pass probation, and how many are still used 30 days later. It is routing data: a low score raises the evidence Dana needs before proposing.

## 10. Memory

### 10.1 Scopes

Unchanged from `ARCHITECTURE.md` §8.3. The learn job writes agent and project memory; Dana writes personal memory; promotion into personal memory stays an explicit, visible step (CONCEPT §2.9).

### 10.2 Recall

Recalled memory counts against the learned share (§3). Each item records how often and when it was last recalled.

### 10.3 Forgetting

| Scope | Automatic forgetting |
|---|---|
| Personal (about you) | None. You delete what you choose, when you choose |
| Agent, project | Unrecalled for 90 days → archived; deleted 30 days later. Keep everything (§5.5) applies |
| Run | Dropped when the run ends unless promoted (unchanged) |

### 10.4 Erasable content

The event log is append-only, so real deletion needs the content kept outside it.
- `memory.written` and `skill.written` carry a `contentRef`; the text lives in a content table or object storage.
- Context snapshots store memory and skill sections by reference, not as copies.
- Deleting appends `content.erased` and removes the content. Folds and the inspector show "erased".
- **Limit:** text a model wrote that repeats an erased item stays in that transcript until the session is deleted.

## 11. What you see

- **Agent Studio, per agent:** the context budget and what fills it. For each skill: state, strength trend, uses in 30 days, last outcome, origin run, tokens, and for catalog skills the verdict on the agent's model.
- **Weave, weekly digest:** a quiet Pulse item, never an ask. Skills promoted, demoted and archived; deletions due next week.
- **Asks,** only for organization changes: hires, splits, merges, retirements, and end-of-probation recommendations.
- **Settings:** learning budget and model; keep everything; evaluate my skills automatically (off by default, `LAB.md` §11).
- **Test this skill,** in Agent Studio: runs the lab's harness on your keys after showing the estimated cost (`LAB.md` §11).

## 12. Runtime changes

Applied to `RUNTIME.md`:

| Change | Where |
|---|---|
| An `agent:<agentId>` stream: the agent's learning log | §2 |
| `skill.written`, `skill.used`, `skill.state_changed`, `learning.completed`, `content.erased` | §3 |
| `memory.written` carries `contentRef`, not content; snapshots reference memory and skill sections | §3 |
| `learn`, `skills.maintain` and `org.review` jobs | §4 |

Code: the strength and lifecycle fold in `packages/core`; the skills store and `skills.maintain` in `packages/memory`; the learn job and `org.review` in `packages/agents`; the eval harness in `packages/evals` (`ARCHITECTURE.md` §12).

## 13. Open questions

1. **Learning on by default?** Proposed: on, with a monthly learning budget. It is the one background spend, so it could instead stay off until you turn it on.
2. **One learning skill, or one per agent.** Proposed: one shared skill, with per-agent overrides you write.
3. **Dana's starting skills.** The list in §7.1 is a proposal.
4. **Feedback UI.** The learn job finds corrections in free text; explicit feedback (thumbs, edits) is cheaper and clearer. How much of it can chat carry without getting noisy?
5. **Sharing back.** Can you submit a personal skill to the catalog, and how is it scrubbed? Later (`LAB.md` §14).
6. **Teams.** Do team leads learn changes to their operating model (stage order, gates)? Not in this draft: an operating model changes only through proposals.
