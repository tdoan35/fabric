# Fabric — Lab

| | |
|---|---|
| Status | Draft, 2026-10-10. Not built |
| Scope | What Fabric measures on its own budget, and how the results reach users' servers: the curated catalog of skills, specialists and teams; the verdict for each skill on each model; Dana's benchmark; the policy values the runtime applies |
| Companion | `LEARNING.md`: how the runtime uses what the lab ships |
| Decision | Evaluation happens in Fabric's lab, once per model or catalog change, for everyone. A user's tokens are never spent on evaluation unless they ask |

## 0. Summary

A skill's value depends on the model running it. A skill that helps a small model can be dead weight on a frontier model, or make it worse. Measuring that costs real tokens, so it happens once, in the lab, and ships to every server as a signed **policy pack**. The runtime loads catalog skills only on models where they help, proposes catalog specialists before custom ones, and applies thresholds the lab has calibrated against its measurements.

```
 Fabric lab (Fabric's budget)                      a user's server (no evaluation spend)
 ┌─────────────────────────────┐   policy pack    ┌──────────────────────────────────┐
 │ benchmarks · eval harness   │  signed, daily   │ loads catalog skills per model   │
 │ skill × model verdicts      │ ───────────────▶ │ proposes catalog specialists     │
 │ curated agents and teams    │                  │ applies thresholds and budgets   │
 │ calibrated policy values    │                  │ local evidence can override      │
 └─────────────────────────────┘                  └──────────────────────────────────┘
```

## 1. Why a lab

- **Nobody measures today.** Neither Hermes Agent nor Prime Agent checks whether a learned skill helps. Hermes records when a skill was last used; Prime Agent checks an edit's format. Both have rollback, which only helps after the damage (`LEARNING.md` §1).
- **Per-user evaluation is the wrong place.** It spends each user's tokens, silently, to answer the same question for everyone.
- **Models change faster than skills.** A release can make a skill unnecessary overnight. One measurement per release covers every user.

## 2. The policy pack

| Part | Contents | The runtime uses it to |
|---|---|---|
| Skill catalog | Curated skills, each with a verdict per measured model (§3) | Load catalog skills only where they help (`LEARNING.md` §8) |
| Agent and team catalog | Curated specialists and teams, with benchmark results per model (§9) | Propose catalog hires first (`LEARNING.md` §9) |
| Dana's defaults | Her starting skills and envelope values, per model (§6) | Set Dana up for the model you run |
| The learning skill | Default instructions for the learn job | Seed every agent's learning (`LEARNING.md` §6.4) |
| Policy values | Thresholds and parameters (§7) | Promote, demote, fade, delete, detect outgrowing, run probation |
| Model chart | The verdicts as a model × skill table | Recommend in Agent Studio's model picker ("on this model, 4 of Megan's skills help and 1 isn't needed"); a public page |

## 3. Measuring a skill

**Uplift** is how much better an agent does on the same tasks with the skill than without it, on a given model, weighed against the tokens the skill costs.

Each skill gets two evals on each covered model:

| Eval | Question | Method |
|---|---|---|
| Triggering | Is it loaded when it should be, and skipped when it shouldn't? | Should-load and shouldn't-load tasks. This tests the description, not the body |
| Uplift | When loaded, does it help? | The same tasks with and without the skill |

Grading:
- **A checker** wherever the output can be checked mechanically: format, extracted fields, tests passing.
- **Otherwise a judge** compares the two outputs against a rubric without knowing which used the skill, in both orders, using a model from a different family than the one under test where possible.
- **Repeats.** Each task runs several times, and results carry a confidence interval.

Prior art: Anthropic's skill-creator already pairs skills with evals, benchmarks them with variance analysis, and tunes descriptions so skills trigger at the right time.

Each (skill, model) pair gets a verdict:

| Verdict | Rule |
|---|---|
| Helps | Wins by a clear margin at confidence, and triggers accurately |
| Not needed | No significant difference: the model already does this, so the skill only costs tokens |
| Hurts | Loses by a clear margin |
| Unmeasured | Not run on this model |

## 4. Test data

| Source | Role |
|---|---|
| Curated tasks | Written or reviewed by Fabric for each skill's domain; the core of every set |
| Synthetic variants | Rephrasings, edge cases and harder versions of curated tasks |
| Near misses | Requests that look related but shouldn't trigger the skill, for the triggering eval |
| Held-out set | Never shown to whoever, or whatever, writes the skill. Verdicts come from it |
| User data | None, unless contributed by explicit opt-in (§14) |

The trap with synthetic data is circularity: the model that wrote a skill generates tests the skill passes. Guards:
- Generate tasks from a description of the task, never from the skill's text.
- Use different models to generate, run and judge.
- Take verdicts from the held-out set.
- Refresh sets when models start saturating them.

## 5. Model coverage

- **The most common models:** what Fabric cloud users run, plus major releases. Self-hosted users can run any checkpoint; those models are unmeasured, and the runtime loads catalog skills on them marked "unverified" (`LEARNING.md` §8.1).
- **Joining coverage.** A model added to coverage gets the full matrix: every catalog skill and every curated agent's benchmark.
- **Silent model changes.** Providers sometimes change a model behind the same name, so a monthly spot check re-runs a sample on each covered model.

## 6. Agent benchmarks

Every curated agent has a core benchmark: its job description, as test cases. It tunes the agent's defaults per model and catches regressions when its skills or instructions change.

### 6.1 Dana's benchmark

| Area | Example case | Passes if |
|---|---|---|
| Handle directly | "Move my 3pm with Sam to Thursday and let him know" | Done in a few steps without delegating, and the outbound message goes through its approval gate |
| Route | "Make a simple landing page" goes to the Coder, not a team; "test this research idea" goes to the Research team | The disposition and target match the expected ones |
| Brief | Delegating a research question | The specialist can act without asking back, and the brief passes the brief check (`ARCHITECTURE.md` §8.1) |
| Hire | A Coder exists, and you ask for a Rust command-line tool | Reuses the Coder. Proposes a hire only when nothing fits |
| Ask | "Pay this invoice" vs "draft a reply" | Always asks before gated actions; doesn't ask when it isn't needed |
| Report | A specialist returns 3,000 words | A five-line summary with a link, not a wall of text |
| Stay in her lane | "Refactor this 2,000-line module" | Delegates instead of doing it herself |

- **Where her line is.** Dana handles a request directly when it needs only her assistant tools and general knowledge, takes a few steps, and is reversible or gated (CONCEPT §4.1). The worked examples in CONCEPT §4.1 are routing cases in this benchmark.
- **Measures:** disposition accuracy, brief success, task success, unnecessary asks, missed gated asks (must be zero), and cost.
- **Used for:**
  - Dana's defaults per model: which starting skills she carries, and her envelope values. A stronger model can take on more herself.
  - Measuring context rot: adding a domain's skills to Dana must not make her worse on this benchmark (§8).

## 7. Calibrating the runtime

The runtime decides with signals it already has; the lab works out what those signals mean.

1. The lab runs agents with skills it already knows help, don't matter or hurt (§3), opposite simulated users. Each simulated user has a hidden goal and reacts the way people do: accepts, corrects, re-asks, taps "go deeper".
2. It records the signals the runtime would see and fits the rules that best separate good skills from bad ones: the promotion count, the demotion rule, the outcome weights, the decay rate.
3. It ships those values in the policy pack, with the envelope values per model, the budgets and the probation length.

This rests on a hypothesis: the signals a runtime sees for free predict uplift well enough to act on. The lab tests it. If they don't, the pack ships conservative values: slower promotion and quicker demotion. Simulated users only approximate people, so the runtime's local evidence still overrides the lab's starting assumptions (`LEARNING.md` §8.1).

## 8. Split tests: when a domain outgrows Dana

For each domain (research, coding, finance, …):
1. Dana with the domain's skills against a specialist with a narrow role, the same skills and the domain's tools, on the domain's tasks.
2. Dana's benchmark with and without the domain's skills.

The results set:
- the thresholds the runtime watches for a skill outgrowing Dana (`LEARNING.md` §7.2): the domain's share of her budget, volume, and mid-task escalations;
- which domains get a curated specialist in the catalog.

## 9. Curated agents and teams

- **Built and benchmarked** by Fabric across covered models.
- **Catalog card:** role, tools and why each one, skills, memory policy, benchmark results per model, recommended models, and typical cost per task.
- **The work sample, done once.** The lab's benchmark replaces a per-user trial. Installing a curated agent or team is still a proposal you approve (CONCEPT A-5).

## 10. Delivering the pack

- **Signed.** Packs are versioned and signed by Fabric, and servers verify the signature before applying one. Catalog content goes into prompts, so it is treated like code.
- **Daily check.** Servers check for a new pack once a day. A local or remote server can pin a version, or import a pack file by hand when offline.
- **On apply:**
  - updates to catalog skills become new versions of installed skills; runs already under way keep the versions they pinned; changes are listed in the weekly digest;
  - new agents and teams appear in the catalog, and nothing is installed without a proposal;
  - policy values take effect at the next `skills.maintain`.
- **A pack never touches** your personal skills or memory.

## 11. Evaluating on your own tokens

The lab's harness (`packages/evals`) also runs on your server, only when you ask:

- **Test this skill,** in Agent Studio. Runs the skill's origin case, its recent uses and generated variants, with and without the skill, on the agent's model, after showing the estimated cost. Tool calls replay results recorded in the log; a tool the original run didn't call runs in the sandbox, with fake versions of tools that have real-world effects.
- **Evaluate my skills automatically.** Off by default. When on, runs §3's evals when a skill is promoted and after it is edited, within a monthly cap.

Results stay on your server.

## 12. Cadence

| Event | What runs |
|---|---|
| A model joins coverage | Every catalog skill and every agent benchmark, on that model |
| A catalog skill is added or edited | That skill, on every covered model |
| A curated agent or a benchmark changes | That agent, on every covered model |
| Monthly | A spot-check sample on each covered model |

Never continuously.

## 13. Limits

- **Lab tasks are not your tasks.** Verdicts are a starting assumption, and the runtime's local evidence overrides them.
- **Small sets give evidence, not proof.** Verdicts need a margin, and a single run never decides one.
- **Judges are biased** towards the first output, longer outputs and their own model family. Hence blind comparison, both orders, and judges from other families.
- **Benchmarks saturate and leak into training data.** Sets are refreshed, and the held-out part stays private.
- **Simulated users approximate people** (§7).

## 14. Open questions

1. **Contributions.** Can users opt in to share skills or anonymized traces to improve the catalog? What is scrubbed, and how?
2. **Coverage for self-hosted users.** Count model ids with opt-in telemetry, or rely on cloud usage and public popularity?
3. **Public chart.** Publish the model × skill table openly?
4. **Community submissions** to the catalog: the review pipeline, and whether community skills pass the same evals before they are listed.
5. **Infrastructure.** Where the lab runs, and its budget per model release.
