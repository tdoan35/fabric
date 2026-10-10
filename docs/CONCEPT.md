# Fabric — Delegation-First Personal Assistant

**Working concept brief for further development.** Codename: **Fabric** — the woven whole formed by many connected threads; the assistant is the fabric that connects your agents and teams. Not a final brand name: "fabric" collides with Daniel Miessler's Fabric (44k★ personal-AI augmentation framework), Microsoft Fabric (data platform), Fabric.js (npm), and Fabric (pypi SSH tool) — keep it as a codename until branding is deliberate. Tagline on the table: *"One assistant. A fabric of specialists."*

| | |
|---|---|
| Status | Concept brief — ready for elaboration |
| Date | 2026-09-29 |
| Updated | 2026-10-01 — added §3 supporting concepts, §8.5 and §13 after reviewing the coded mockup (`apps/web`); gap register in `MOCKUP-GAPS.md` (since retired). 2026-10-02 — §8.5 and §13 A-11 for the Weave page; §3, §8.2, §8.5 and §13 A-12 for the Work page (tasks and loops). 2026-10-10 — §4.1 Dana's envelope (direct vs. delegate); Appendix A rows from long-term Hermes use; learning in `LEARNING.md`, evaluation in `LAB.md` |
| Owner | Ty Thanh Doan |
| Purpose | Handoff document for agents/teams doing: (1) concept development, (2) technical architecture, (3) UI/UX design |

---

## 0. How to use this document

Three workstreams will build on this file:

1. **Concept track** — sharpen the product model, routing policy, lifecycles, failure handling.
2. **Architecture track** — design the technical system (see §9 starting points, §12 deliverables).
3. **UX track** — design the experience (see §8 starting points, §12 deliverables).

Reading rules:

- **§2 Settled decisions are binding.** Elaborate them, don't contradict them. If a decision proves wrong, flag it explicitly as a proposed amendment with reasoning rather than silently diverging.
- Sections tagged **[OPEN]** contain genuine open questions — resolving them is your job, not a defect in the brief.
- §A maps lived-experience insights to design implications; cite them when justifying choices.
- Deliverables for each track are listed in §12.

---

## 1. Problem statement

Today's personal-agent products push a single profile to accumulate everything: skills, tools, identity, soul, user model, and memory all grow on the main agent. Want a new capability? Add a skill to the starting profile. Want new tools? Add them to the starting profile. The default trajectory is a **super-agent** with heavy context bloat, degrading reasoning and rising cost.

The industry already knows the fix at the task level: specialized agents (coding harnesses for coding, etc.) dramatically outperform general-purpose contexts for their domain. But no personal-assistant product makes that the *default structure* of the product.

At the same time, agent *products* make multi-agent orchestration either invisible (you can't inspect or manage it) or absent (you must assemble it yourself and keep reminding the assistant to use it). And the UX of powerful agent frameworks is developer-oriented; the UX of polished assistants is capability-limited. Users shouldn't have to choose.

**Fabric's thesis:** a personal assistant should *manage capabilities, not accumulate them*. Adding a new capability should usually mean the assistant gains someone to delegate to — not a bigger prompt, toolbelt, and memory for itself. And the resulting organization of agents and teams must be first-class in both the runtime and the UI: creatable by conversation, inspectable, governable.

Two equal halves:

1. **Delegation, capability creation, and team execution are the default product workflow** — not features the user must assemble and continually remind the assistant to use.
2. **The organization is inspectable** — a calm, consumer-grade primary UX (the feel of Muse / Grok's assistant) with the functionality and transparency of a power-user framework.

---

## 2. Settled decisions (product invariants)

These are the agreed core. Binding unless explicitly amended.

1. **Delegation-first, not delegation-always.** Every request gets an explicit routing disposition, including "handle directly." The assistant stays small and good at: understanding the user, selecting help, negotiating scope, handling approvals, communicating outcomes.
2. **Agents and teams are first-class primitives**, created through conversation with reviewable proposals (never silently instantiated with broad access), reusable across contexts, inspectable at any time.
3. **The capability registry is searched, not loaded.** The main assistant sees compact capability descriptions of specialists, never their full skills/tools/schemas.
4. **Agents are definitions; runs are instances.** The same agent definition participates in many runs/teams with isolated run contexts. Teams and agents don't inherit each other's bloat.
5. **A team is an operating model, not a group chat.** Purpose, membership, a lead accountable for the outcome, decision rights, handoff/dependency rules, completion criteria, budgets.
6. **Context boundaries are a central design surface.** What crosses a delegation boundary is deliberately minimized and inspectable ("what context was actually loaded for this run?").
7. **Creation proposals default to minimal.** Suggested defaults for a new specialist must be minimal and explainable — never a clone of the main profile. UI tool toggles are not security boundaries; isolation is enforced at runtime.
8. **Work is bounded.** Runs carry time/cost/rework budgets; exhaustion produces an actionable blocked state, not an endless agent-conversation loop.
9. **Memory is scoped.** Personal / agent-scoped / team-project / run-temporary. Specialist learnings do not silently write into the main assistant's permanent memory.

---

## 3. Core model — primitives

| Primitive | Owns | Notes |
|---|---|---|
| **Agent** | Identity/role, instructions (soul), skills, tools, model + harness, permissions, scoped memory | A reusable definition. May be referenced by many teams and runs. |
| **Team** | Purpose, members + roles, lead, operating rules (decision rights, handoffs, concurrency), shared knowledge base, completion criteria, budgets | Created for a durable purpose or ad hoc for a campaign. |
| **Task / Run** | A specific objective: assigned agent(s)/team, working context, dependencies, budget, status, audit trail | The unit of execution and inspection. Distinct from the Agent definition. Split per §13 A-12: a **task** (one objective, one team, one project) has one or more **runs**, shown in the UI as *loops*. |
| **Artifact** | The actual output + evidence: code, docs, research, test results, evaluation data | Immutable-ish, referenced (not inlined) across boundaries. |

Supporting concepts:

- **Memory scopes** — personal (about the user), agent-scoped (specialist's own lessons), team/project (shared facts + decisions), run-temporary (scratch). Writes are scoped deliberately; promotion between scopes is an explicit act.
- **Capability registry** — searchable directory of agents, teams, and templates (see §7) that powers routing and the "propose a new specialist" flow.
- **Capability tokens / proposal cards** — the reviewable unit of capability creation (§7).
- **Templates** — reusable, parameterized agent/team definitions (e.g., a "Research Team" template). [OPEN] How much structure templates encode (workflow? budgets? memory policy?) is an open design question.
- **Persona** — the display layer on an agent: a name, portrait, traits and voice on top of its role. In the mockup, the main assistant's persona is **Dana** (executive assistant); specialists include Jonah (Coder) and Sana (Validator). Display and naming rules are in §13 A-1.
- **Workspace files** — an agent's identity as markdown files, loaded in this order at every run:
  - `SOUL.md`: core truths, voice and boundaries.
  - `IDENTITY.md`: name, role, avatar, vibe and team memberships.
  - `USER.md`: for a specialist, a minimal user profile curated by the assistant — never the assistant's own memory (§13 A-9).
- **Session / project** — a session is one conversation thread; projects group sessions. A session's status is unread, needs your input, or idle.
- **Organization** [PROPOSED, §13 A-4] — the assistant at the head, with teams attached by their leads.
- **Community catalog** [PROPOSED, §13 A-5] — shared agent and team definitions that users can add; added agents start with empty memory.

---

## 4. Routing & delegation

Every incoming request gets an explicit, recorded **disposition** — decided by the main assistant as part of its normal turn, not a separate expensive planning conversation:

| Disposition | When it fits | Example |
|---|---|---|
| **Handle directly** | Conversation, clarification, or small tasks within the assistant's own scope | Discuss whether an experiment is worth pursuing |
| **Delegate → agent** | One specialist can own the outcome | "Create a simple HTML landing page" → Coder |
| **Delegate → team** | Needs multiple capabilities, dependent stages, or independent validation | Adaptive-thinking experiment → Research Team |
| **Propose new specialist/team** | Existing capabilities don't adequately cover the task | Suggest a new agent with a reviewable config (§7) |
| **Clarify first** | Missing info would materially change the work | Ambiguous objective, missing spend/scope limit |

Design requirements:

- The disposition is **recorded** (auditable routing trail: what was considered, what was chosen, why). This is inspection fuel and the training signal for improving routing.
- Delegation handoffs carry a **task brief** (objective, constraints, relevant context, budget, completion criteria) — not the parent transcript (§6).
- The assistant recommends and helps create missing capabilities; it does not silently instantiate permanent agents with broad access.
- **Anti-goal:** do not build a heavyweight LLM routing classifier in front of everything before the value path works. Start with the main agent's judgment + registry search; add structure only where observed routing is bad.
- Disambiguation between adjacent dispositions: **direct vs. delegate is resolved in §4.1.** [OPEN] Agent vs. team: §4.1's worked examples cover the common cases (a team when the work needs several capabilities, dependent stages or independent validation); a full policy is still owed.
- [OPEN] Should lightweight requests skip disposition recording entirely (pure chat), or is everything logged at decreasing detail?

### 4.1 Handling directly: Dana's envelope

*Resolved 2026-10-10.*

Route by depth, not topic. "Anything research goes to the researcher" delegates too much: quick lookups are assistant work, the way a human executive assistant googles something without calling in an analyst. Dana handles a request directly when it fits all four:

| Criterion | Handle directly | Delegate when |
|---|---|---|
| Tools | Her assistant toolset: web search, calendar, mail, notes | It needs code execution, the sandbox or specialist tools |
| Expertise | General knowledge is enough | It needs a specialist's judgment: weighing benchmarks, licences, methodology |
| Size | A few steps (starting values: ~5 tool calls, ~2 minutes) and a chat-length answer | Many sources, cross-checking, a report or other deliverable, or anything recurring |
| Stakes | Informational, reversible, or behind an approval gate | A decision depends on the answer |

- **Ambiguous depth: answer, then offer.** When a request doesn't say how deep to go, Dana answers at the cheapest depth that is useful on its own, and offers more as a one-tap action under the answer ("Have Megan research this") rather than a question in the text. She clarifies first only when a wrong guess would waste real work (the *clarify* disposition).
- **Escalating midway.** Dana can start directly and find the work is bigger than it looked. The runtime enforces the size limit as a budget on direct handling: at the limit she finishes or delegates, what she found goes into the brief, and the change is recorded as a new disposition (`direct → agent:megan`, "sources conflict").
- **Learning the line.** Taps on the offer, mid-task escalations and corrections ("no, give that to Megan") are routing data. They move the line for you without adding text to Dana's prompt (`LEARNING.md` §4).

Worked examples:

| Request | Disposition |
|---|---|
| "What's the newest Llama release?" | Direct, one search |
| "Tell me about the latest advances in SOTA open-source models" | Direct briefing with sources, plus the "go deeper" action |
| "Which open model should we use for our product? We decide on Friday" | Delegate → Megan · Researcher, with the decision criteria in the brief: a decision depends on it |
| "Write me a report on open-source model trends" | Delegate → Megan · Researcher: a deliverable |
| "Keep me posted on major open-model releases" | Propose a weekly schedule owned by Megan · Researcher: recurring |
| "Check whether Qwen beats Llama on our eval set" | Delegate → Research Team: it runs code and needs independent validation |

Where it lives: the policy in Dana's core instructions (it applies to every request, so it is always loaded, not a skill); the size limit in the runtime; the values per model, with these examples as test cases, in the lab (`LAB.md` §6); your adjustments in routing data (`LEARNING.md` §4). This keeps to the anti-goal above: Dana's judgment plus a runtime limit, not a classifier in front of every request.

---

## 5. Reference workflow — the research campaign

The canonical non-trivial example (from the origin conversation): the user says *"I want to test and experiment with the following idea: 'use a classifier to create adaptive/dynamic thinking for my models between turns'"*.

```text
You
 └─ Personal assistant  (disposition: delegate → Research Team)
     └─ Research Team lead
         ├─ Investigator: survey papers/projects/limitations
         │
         ├─ Lead: synthesize → testable hypothesis + evaluation plan
         │
         ├─ Coder: implement experiment ──────────────┐
         ├─ Validator: prepare independent checks ──┤ parallel
         │                                           │
         ├─ Validator: execute evaluation ◀──────────┘
         └─ Reviewer: inspect evidence + conclusions
             ├─ Accept → report + artifacts to user
             └─ Request changes → bounded rework loop
```

Key properties:

- The **lead owns the research outcome**, not just message-passing between members.
- "Done" is defined by **completion criteria**, e.g.: hypothesis and baselines explicit; implementation runs; evaluation measures quality, latency, and cost; conclusions distinguish measured results from speculation; artifacts reproducible and returned.
- Parallelism is structural: implementation and evaluation-prep overlap; review is dependency-gated on results existing.
- The rework loop (Coder → Reviewer → Validator → Coder) has a **rework budget**; exhaustion escalates to the user with evidence, per invariant §2.8.

---

## 6. Context architecture

Context boundaries are the main defense against super-agent bloat. Defaults:

| Context | Receives |
|---|---|
| **Main assistant** | Relevant personal context + compact capability descriptions from the registry (searched on demand) — never specialists' skills/tool schemas |
| **Specialist (per run)** | Its narrow instructions + task brief: objective, constraints, relevant user preferences, artifact references — not the parent transcript |
| **Team (shared)** | Project facts, decisions, operating rules — retrieved when needed, not always-resident |
| **Return path (to delegator)** | Outcome, evidence, unresolved questions, artifact links — not internal conversations |

Additional requirements:

- **Introspection:** any run can answer "what context was actually loaded?" — the *actual* system-prompt assembly, not the theoretical config. This is a headline inspection feature.
- **Failure modes to design against:** handoff information loss (brief under-specified for the specialist to act); context creep via return-path inflation (specialists returning walls of text); shared-team knowledge growing unbounded; registry descriptions themselves becoming bloat.
- **Honesty requirement:** specialization is a hypothesis, not a law. Multi-agent adds handoff error surface and total cost even as it shrinks the main context. Instrument both directions (per-run token cost, handoff rework rate, outcome quality vs. single-agent baseline) so the product can prove where delegation helps and where it doesn't.

---

## 7. Capability creation lifecycle

When routing decides capabilities are missing, the assistant produces a **proposal card** — never an immediately-instantiated permanent agent.

Proposal card contents:

> **Suggested specialist: Experiment Validator**
> **Purpose:** Independently evaluate research implementations
> **Suggested skills:** experimental design, benchmark execution, statistical checks
> **Tools:** read artifacts; execute checks in an isolated workspace
> **Model/harness:** [suggested default, e.g. a coding harness]
> **Memory:** project-scoped; no personal memory access
> **Restrictions:** cannot modify protected acceptance criteria; cannot deploy
> **Lifecycle:** this task only · save as reusable agent · save as template
> **Actions:** Create · Customize · Use an existing agent instead

Same pattern for teams: propose lead, fill roles with existing agents where possible, surface missing specialists, preview the workflow (dependencies, parallelism, budgets) before anything runs.

Lifecycle states [OPEN — concept track to refine]:

```text
Proposed → Approved → Active → (Paused) → Retired / Archived
                 └→ Template (saved definition)
```

Rules:

- Defaults are **minimal and explainable** — every suggested skill/tool/permission has a one-line justification tied to the triggering task.
- Reuse beats creation: the proposal flow must offer existing agents/templates first ("Use an existing agent instead").
- Security: UI capability toggles are *behavioral scoping, not security*. Real isolation (filesystem, credentials, network) is enforced by the runtime sandbox. Proposals state what the agent can *do*, and the runtime enforces what it *may*.

---

## 8. UI/UX directions [UX]

### 8.1 Design principles

1. **Calm by default, inspectable on demand.** The primary surface is a conversation with the assistant. The organization exists behind it, one tap away. Not an "agent control room" home screen.
2. **Two different graphs, two different views.** *Org view* (who belongs to what, who owns what — the org chart) and *Run view* (execution of a specific task: members, dependencies, handoffs, evidence). Team membership ≠ execution order; don't collapse them into one diagram.
3. **Conversation is the creation surface.** Agents/teams get created through chat + proposal cards, not a settings wizard — but every proposal is inspectable and editable before approval.
4. **Nothing hidden, nothing loud.** Progress surfaces as compact cards; full detail is drilled into, never pushed.

### 8.2 App structure (starting point)

- **Assistant** — the main conversation; compact delegation/progress cards inline:

  > **Research Team · Evaluating hypothesis**
  > Implementation ready · Validator running checks · Reviewer waiting
  > **View work · Message lead · Pause**

- **Agents** — roster of specialists: identity/soul, skills, tools, permissions, memory scope, model/harness; recent runs; "what would change if I edited this?"
- **Teams** — purpose, membership/roles, lead, operating rules, shared knowledge, active campaigns.
- **Work** — active + completed runs: status, blockers, approvals needed, artifacts, evidence, full audit trail (including the routing disposition from §4). In the mockup: a board of tasks by project (default) or by team, and each task's loops, live or replayed (§13 A-12).

### 8.3 Named UX problems to solve [OPEN]

1. **Org view** — visualizing membership, roles, lead, decision rights; multiple teams side by side; agent reuse across teams without duplication.
2. **Run view** — dependency/handoff graph over time (not a chat transcript); showing parallelism, waiting states, budgets remaining, rework loops.
3. **Inspection surfaces** — an agent's soul/identity/memory made readable (not raw YAML); run context introspection ("what was loaded?"); memory-scope viewer (what lives where, who can write it).
4. **Creation flow** — proposal-card interaction design; editing suggested defaults; template save/parameterize.
5. **Approval/blocked flows** — how approvals, budget exhaustion, and blocked states interrupt the user appropriately (urgency without anxiety).
6. **Trust calibration** — progressive autonomy: show more detail until the user stops asking (learned trust), with a permanent "why did it do that?" affordance.

### 8.4 References

- Target conversational feel: Muse, Grok's assistant apps (consumer-grade calm).
- Functional depth reference: Hermes Agent desktop (profiles, skills, memory, Kanban board, observability) — functionality to preserve, developer-density to shed.

### 8.5 Where the coded mockup stands (2026-10-01)

The UX track has a coded mockup (`apps/web`, mock data). It commits to one of the §12 UX-2 directions, **calm consumer**: an animated aurora background, translucent panels, pixel-art portraits and motion. Against §8.2–8.3:

| Item | Mockup answer | Still open |
|---|---|---|
| App structure (§8.2) | Sidebar: Weave (asks and updates, §13 A-11) · New thread (Assistant) · Agent Studio (Agents ⇄ Teams ⇄ Organizations) · Work (board of tasks and their loops, §13 A-12), plus Projects and Threads | — |
| Org view (§8.3.1) | Organizations: the assistant at the head, teams by lead; an agent on two teams is drawn under each with a `shared` tag | The team-to-team handoff edge; §13 A-4 |
| Run view (§8.3.2) | Member lanes over time with work, bounce and dashed-rework segments; the live start zoomed to the first minute; replay controls | Budgets other than rework |
| Inspection (§8.3.3) | Agent Studio shows workspace files as raw but readable markdown with token estimates ("exactly what the agent loads"). The Run inspector shows sections, sources, tokens and what was *not* loaded. Each agent has a memory list with provenance | Opening a section's actual text; a memory-scope viewer across scopes |
| Creation flow (§8.3.4) | Proposal cards in chat; edits happen through "Chat about this" | Inline edits, template save, re-proposal |
| Approval / blocked (§8.3.5) | Sessions get a pulsing amber "needs your input" dot. **Weave** (`/weave`, §13 A-11) collects every ask in one inbox: typed asks with the cost of delay, escalation options when a rework budget runs out (raise · accept with caveat · stop), and snooze until an event | Wiring asks to real tool-call approvals and `run.blocked` events |
| Trust calibration (§8.3.6) | Approval modes in the composer: Ask · Auto-approve edits · Full auto | The scope of Full auto (§13 A-3) |
| Lifecycle (§7) | Origin pills only ("Created in chat · today", "Seeded", "From @author") | Pause, retire, template |

---

## 9. Technical architecture starting points [ARCH]

Not decisions — verified starting points and known hard problems.

### 9.1 Verified mappings in existing systems

These exist today in Hermes Agent (verified against current docs) and are useful either as implementation substrate or as prior art:

- **Profile = isolated agent instance** — per-profile config, skills, memory, credentials; bot mode is a UI over profiles with creation dialogs (model pin, per-skill/tool/MCP enablement, custom SOUL.md).
- **Bot-to-bot messaging** — `message_agent` with attribution, validated roster, fire-and-forget delivery into canonical bot chats; group rooms with serial rounds and message caps.
- **Kanban** — durable SQLite task board: claims, dependencies, stale-claim reclaim, atomic claiming, per-task retry/failure limits, worker lanes with task-scoped toolsets. Prior art for the Run primitive and bounded-failure policy.
- **delegate_task** — ephemeral parallel subagents with isolated context, output contracts (JSON schema + bounded correction), configurable model/harness per delegation. Prior art for brief-based handoff; *not durable* (children don't survive owner crash).
- **Cron / routines** — scheduled bounded jobs per profile.
- Prior art elsewhere: OpenClaw/Claude-Code-style coding harnesses = the "specialized harness per agent" pattern; multi-agent frameworks (Mastra workflows, LangGraph, etc.) = team workflow encoding; observability tooling = run inspection surfaces.

### 9.2 Hard problems [OPEN]

1. **Durable delegation** — runs that survive crashes (Kanban-style durable state vs. in-process delegation). What's the recovery/reconciliation story for in-flight runs?
2. **The brief compiler** — turning "user request + registry lookup + user context" into a minimal-but-sufficient task brief. This is the highest-leverage component in the system and the easiest to get subtly wrong.
3. **Context assembly + introspection** — building each run's context from (agent def + brief + scoped memory + team knowledge) and *recording the assembly* so "what was loaded?" is answerable.
4. **Registry** — representation (embeddings? structured tags? both), search quality vs. compactness, freshness as agents/teams change.
5. **Isolation model** — sandboxing unattended specialist execution (filesystem, credentials, network) beyond UI toggles.
6. **Team orchestration semantics** — encoding operating models (decision rights, dependency-gated stages, parallelism, rework budgets) in a way that's inspectable and not a DSL that recreates Airflow.
7. **Memory scoping implementation** — separate stores per scope with deliberate promotion rules; preventing cross-scope leakage.
8. **Routing quality** — making the main assistant's disposition judgment reliable and cheap; measurement/eval harness for routing decisions.
9. **Cost accounting** — per-run token/cost attribution across agent boundaries (feeds budgets and the honesty requirement in §6).

### 9.3 Build vs. compose [OPEN]

Candidate strategies for the architecture track to evaluate honestly (they interact with the timebox in §10):

- **Compose:** orchestrate existing runtimes (e.g., Hermes profiles/bots/kanban, or coding-agent CLIs) under a new router + UI. Fastest to value; least control over context assembly and introspection.
- **Build narrow:** a purpose-built runtime with first-class primitives (registry, runs, briefs, scoped memory) from day one, calling out to model providers directly. Most control; most work.
- **Hybrid:** purpose-built router/context layer over composed specialist runtimes.

### 9.4 Suggested data model starting point (to be redesigned)

```text
agents(id, name, role, soul, model_config, permissions, memory_policy, status, created_from)
teams(id, purpose, lead_agent_id, operating_rules, completion_policy, budgets, status)
team_members(team_id, agent_id, role_in_team, decision_rights)
runs(id, objective, team_id?, agent_ids[], status, brief, budget, parent_run_id?, created_at)
run_events(run_id, seq, type, actor, payload)          -- audit trail incl. routing disposition
artifacts(id, run_id, kind, uri, evidence_summary)
memory(scope_type, scope_id, key, content, provenance)  -- personal | agent | team | run
capability_registry(entry_type, ref_id, description, tags, embedding)
```

---

## 10. Constraints & non-goals

### Non-goals (v1)

- General-purpose business "agent workforce platform" — this is a **personal** assistant; it may serve the user's one-person business, but it is not B2B SaaS.
- Auto-scaling agent swarms / emergent orgs without user-approved creation.
- Replacing the user's judgment: merge/deploy/spend/credential authorities stay human (approval gates).
- Building a workflow DSL capable of everything; encode what teams actually need.
- Mobile-first (assumed desktop/tablet first; challenge if wrong).

### Constraints

- The main assistant's context must stay bounded by design (this is the product's own dogfood — a super-agent main profile is failure state #1).
- Every autonomous boundary must have an approval/evidence story.
- Cost visibility is a feature, not telemetry.
- Timeboxed hackathon variant (optional trigger, §10.1) must be cuttable to a demo-thin slice.

### 10.1 Optional timebox: hackathon build (Oct 4, 2026)

If this concept becomes the "Build Personal Agents Hack" entry (SF, one day, ~6.5h hacking, submission 4:30 PM): prove the minimal slice, not the platform.

- **Demo thesis:** "Ask once → the assistant routes it → the right specialist/team executes with visible structure → you inspect everything and stay in control."
- Four demo paths: direct answer · coding handoff → Coder · bounded Research Team run · approved specialist creation (proposal card → create → use).
- Observable artifacts: routing decision visible; org view + run view; "what context was loaded" inspector; budget/rework bound triggering an escalation.
- Available co-host stack (optional, not required): Neon (Postgres + AI gateway), Mastra (agent framework + observability), Exa (research search), Fly.io (agent sandboxes), Kernel (browser automation), Executor (tools/MCP gateway), Assistant UI (chat components), AgentMail (email inboxes).
- Verify on-site rules first: if all code must be written day-of, pre-stage pitch + architecture and rebuild the wiring live.
- Recorded-demo fallback mandatory (venue wifi risk).

---

## 11. Open questions summary

**Concept:** routing disambiguation policy (§4; direct vs. delegate resolved in §4.1) · team operating-model vocabulary (§5) · lifecycle states and retirement/archival semantics (§7) · when a run's specialist learning is promoted to personal memory (§3, §6) · template expressiveness (§3).

**Architecture:** durability model for runs (§9.2.1) · brief compiler design (§9.2.2) · build/compose/hybrid choice (§9.3) · registry representation (§9.2.4) · isolation enforcement (§9.2.5) · cost attribution (§9.2.9).

**UX:** org-view visualization for multi-team reuse (§8.3.1) · run-view over time (§8.3.2) · soul/memory readability (§8.3.3) · proposal-card interaction (§8.3.4) · interruption/urgency design for approvals and blocks (§8.3.5) · progressive-autonomy/trust UI (§8.3.6).

**From the mockup (§13):** persona display and naming (A-1) · direct chat (A-2) · approval-mode scope (A-3) · organizations and team copies (A-4) · community catalog trust (A-5) · group chat (A-6) · execution target (A-7) · incognito (A-8) · specialist `USER.md` (A-9) · context meter (A-10) · Weave as a secondary surface (A-11) · Work as tasks and loops (A-12, adopted).

---

## 12. Deliverables requested

**Concept track**
1. Routing decision policy with worked examples (including disambiguation edge cases).
2. Team operating-model spec: vocabulary, decision-rights taxonomy, completion-criteria patterns, budget defaults.
3. Capability lifecycle spec (states, transitions, retirement, template semantics).
4. Memory-scope promotion rules.
5. Named failure scenarios (10+) with prescribed system behavior.

**Architecture track**
1. System decomposition + component diagram; build/compose/hybrid recommendation with trade-offs.
2. Data model (evolving §9.4) + storage choices.
3. Delegation protocol: brief schema, return contract, run lifecycle, durability/recovery story.
4. Context assembly + introspection design ("what was loaded" recording).
5. Isolation/security model mapping permissions → runtime enforcement.
6. Instrumentation plan: routing quality, handoff loss, cost attribution, single-agent baseline comparison.

**UX track**
1. Information architecture + navigation model for the four areas (Assistant / Agents / Teams / Work).
2. 2–3 distinct design directions (e.g., calm-minimal vs. command-center vs. hybrid) with rationale against §8.1 principles.
3. Key flows: routing transparency, delegation handoff observation, proposal-card creation, approval/blocked escalation, run inspection, org view.
4. Wireframes/prototypes for: org view, run view, agent inspector, memory-scope viewer.
5. Component inventory mapped to available UI primitives (e.g., Assistant UI) where sensible.

---

## 13. Proposed amendments from the mockup (2026-10-01)

The coded mockup adds behaviour this brief doesn't cover. Per §0, each item below is a **proposed amendment**: none is adopted until the owner says so. Gap IDs refer to the retired gap register (`docs/MOCKUP-GAPS.md`, in git history).

**Elaborations consistent with §2 (no amendment needed):**
- **The escalation chain is explicit:** member → team lead → assistant → user. Leads "report to Dana, not to you directly", and the Reviewer escalates to the assistant once the rework budget is spent (§5, §2.8).
- **A team's operating model as data:** ordered stages `{label, agents (several = parallel), note, gate}`, plus completion criteria and a rework budget. This is a first cut of §12 Concept-2.
- **Each run records what crossed the boundary**, including a "not loaded" list: your transcript, personal memory and other specialists' skills (§2.6, §6).

**Proposed amendments:**

| # | Proposal (mockup) | Touches | Reasoning / risk | Suggested resolution |
|---|---|---|---|---|
| A-1 | **Persona layer**: the assistant is "Dana"; specialists have names and portraits | §3, §8.1 | Adds warmth (the §8.4 Muse/Grok feel). Risks: roles get lost behind names, and the mockup mixes roles and names across screens | Adopt. Show "Name · Role" everywhere. The assistant proposes the name on the proposal card, so nothing is renamed after approval |
| A-2 | **Direct chat with specialists** (agent switcher; "Back to Dana") | §2.1, §2.6, §4 | Matches how people work with experts, but bypasses routing and the brief | Allow it as an explicit user override, recorded as a disposition (`direct · user-chosen`). The specialist sees its own `USER.md` and this session — never the assistant's memory. Work that needs a run still goes through a brief |
| A-3 | **Approval modes**: Ask · Auto-approve edits · Full auto ("never ask, inside the sandbox") | §2.2, §2.7, §10 | Progressive autonomy is the goal of §8.3.6, but "never ask" can't cover capability creation or the human-authority gates | Modes relax approval only for in-sandbox actions. Creating agents or teams, and the merge / deploy / spend / credential / external-send gates, always ask |
| A-4 | **Organizations**: a named org with the assistant at the head and teams by lead; the same team can be added twice ("copy 2") | §2.4, §3, §10 | Shows multi-team structure. But a "copy" has no defined meaning (shared or separate knowledge? runs?), and "organization" drifts toward the B2B non-goal | An org is a personal grouping and reporting view. Drop copies — or define a copy as a separate team instance with its own knowledge and runs |
| A-5 | **Community catalog** of agents and teams (author, installs; added agents start with empty memory) | §3 templates, §2.7, §7 | Reuse beats creation, but third-party souls and tools raise a trust problem | Installing renders a proposal card (tools, policies, memory scope) and needs approval, like any new capability |
| A-6 | **Group chat** (a button only) | §2.5 | Undefined, and the term collides with "a team is not a group chat" | Remove it, or define it as a user-hosted multi-agent session that is explicitly not a team |
| A-7 | **Per-session execution target and connectors** ("Runs on": This machine (the default) · Sprite · Remote host) | §7 security, §2.7 | A local default contradicts "isolation is enforced by the runtime" | Default to isolated. Local or remote execution needs explicit approval and must state what it can reach |
| A-8 | **Incognito sessions** ("not saved to your sessions or used to shape your assistant") | §2.9 | A useful privacy mode, but its audit semantics are undefined | No session history and no writes to any memory scope; dispositions and runs are still audited |
| A-9 | **Specialist `USER.md`**: a curated user profile per specialist | §6 | Makes "relevant user preferences" concrete, but risks drifting into a copy of personal memory | `USER.md` is the per-agent ceiling, edited only by explicit promotion (§12 Concept-4); the brief picks from it per run |
| A-10 | **Session context meter**: a 1M window with auto-compaction at 80% | §10 constraint 1 | Mixes conversation length with the assistant's bounded base context | Show both: the base context (bounded, ~2k) and the conversation history (compacted) |
| A-11 | **Weave** (`/weave`): where the organization reports to you. An inbox of typed asks (approval, question, escalation, proposal, finding, result); a Pulse feed of lead updates (health, what changed), memory writes and granted autonomy; agent presence and your day | §8.1.1, §8.3.5, §2.8, §2.9 | Answers §8.3.5, and makes specialist memory writes visible and forgettable. Risk: drifting into the "agent control room" §8.1.1 rules out | Adopt as a secondary surface; chat stays the landing page. Calm defaults: counts only for asks, amber not red, quiet events hidden. "Always allow" only for non-gated actions (A-3), and gated asks can't be approved from the list |
| A-12 | **Work: tasks and loops** (`/work`, adopted by the owner on 2026-10-02). A **task** is one objective owned by one team (or agent) in one project; each run of it is a **loop**. The board belongs to the **project**: columns every team shares (Proposed · In progress · In review · Done), so several teams can work one project. A **team** view shows the same tasks in that team's own workflow steps. Below both, previous loops can be replayed. A task's page shows its loop: the workflow with the way back from review, member lanes, the brief and its completion criteria, and the inspector | §3 Task/Run, §8.2 Work, §2.4, §2.5 | Matches how real organizations split durable teams (how work is done) from projects (why). Work that needs two teams is two tasks linked by a handoff, so each has one accountable lead. Agent Studio holds definitions; Work holds instances (§2.4). Weave pushes what needs you; Work shows where everything is. Risk: a second inbox, so asks only appear as flags linking to Weave | Adopted. Ideas stay in chat until Dana proposes them (no Ideas column). A re-run is a new loop on the same task; reviewer bounces stay inside one loop's rework budget |

---

## Appendix A — Source insights → design implications

| Lived observation (origin conversation) | Implication in this brief |
|---|---|
| Hermes/openclaw usage drifts toward super-agent profiles; skills/tools/soul/memory pile onto the starting profile | §1 problem, §2.1, §2.3, §6 context boundaries; main assistant's own context bloat is failure state #1 (§10) |
| Specialized agents demonstrably outperform general contexts (coding harnesses) | §1 thesis; specialists get their own harness/model choice (§3, §7 card) |
| Desired flow: "Can I delegate? → team or individual? → which team?" as explicit steps | §4 disposition table + recorded routing trail |
| Research-team example (lead, investigator, coder, validator, reviewer; hypothesis → implement → validate → review cycle) | §5 reference workflow, completion criteria, bounded rework |
| "Simple HTML page" should route to a lone coder, not a team | §4 single-specialist disposition |
| Missing-specialist requests should trigger *helped creation* with suggested defaults | §7 proposal cards, minimal-and-explainable defaults |
| Preference for Muse/Grok UX with Hermes functionality | §8.1 calm-by-default principle, §8.4 references |
| Need to inspect each agent's soul/identity/memory; teams as org charts; manage multiple teams | §8.2 Agents/Teams/Work areas; §8.3.1–8.3.3 |
| Multi-agent runtime failure modes (starvation, WIP pileups, stuck claims, unbounded loops) | §2.8 budgets/blocked states; §5 rework budget; §9.1 Kanban prior art |
| Handoff information loss and return-path bloat as multi-agent failure modes | §6 failure-mode list; §12 brief-compiler deliverable |
| "More agents" is not automatically better — handoff errors and total cost can rise | §6 honesty requirement; §12 instrumentation plan |
| A long-used Hermes main agent's prefill keeps growing until it rots itself; skills have to be pruned by hand | Per-agent context budget; skills fade without use (`LEARNING.md` §3, §5) |
| Saved skills carry no quality metric, so there is no telling whether one was worth keeping | Uplift per skill and model, measured in the lab (`LAB.md` §3) |
| Cleanup is inconsistent; skills should solidify with practice and be forgotten without it, as people's are | Strength from use and outcomes, computed deterministically; tiered deletion (`LEARNING.md` §5) |
| As models improve, some skills become useless and only add context | A verdict per model; catalog skills load only where they help (`LAB.md` §3, `LEARNING.md` §8) |
| An executive assistant does one layer of simple work themselves, and delegates or hires for the rest | §4.1 envelope; Dana's skills and hiring (`LEARNING.md` §7, §9) |
| Name brainstorm: "fabric" chosen as codename (the woven whole; assistant connects agents/teams); word heavily used in tech — codename only, deliberate brand pick deferred | Header codename note; naming history |

## Appendix B — Glossary

- **Disposition** — the recorded routing decision for a request (§4).
- **Brief (task brief)** — the self-contained handoff package given to a specialist for a run (§6).
- **Run** — one execution instance of a task by agent(s)/team, with its own context, budget, and audit trail (§3).
- **Proposal card** — the reviewable unit of capability creation (§7).
- **Capability registry** — searchable directory of agents, teams, templates powering routing and proposals (§3).
- **Return contract** — the constrained shape of what a specialist returns to its delegator (§6).
- **Memory scopes** — personal / agent / team / run partitioning of durable memory (§3).
