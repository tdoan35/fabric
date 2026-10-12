# Fabric — Product

| | |
|---|---|
| Status | Current, 2026-10-11. Replaces `CONCEPT.md`, the hackathon brief (in git history) |
| Scope | What Fabric is and the rules it keeps. The system: `ARCHITECTURE.md` and `RUNTIME.md`. How agents learn: `LEARNING.md`. What Fabric measures: `LAB.md` |
| Owner | Ty Thanh Doan |
| Name | "Fabric" is a codename: it collides with Daniel Miessler's Fabric, Microsoft Fabric and Fabric.js. The brand is undecided |

## 1. Thesis

Personal-agent products grow one profile until it holds everything: skills, tools, identity, memory. The result is a super-agent with a bloated context, worse reasoning and rising cost. Specialized agents beat general contexts in their domain, yet no assistant makes delegation its default structure, and the ones that orchestrate agents either hide it or leave you to assemble it.

Fabric's thesis: **an assistant should manage capabilities, not accumulate them.** A new capability usually means someone new to delegate to, not a bigger prompt. Two halves, equally important:

1. **Delegation is the default workflow.** Routing, creating capabilities and running teams happen without you assembling them or reminding the assistant to use them.
2. **The organization is inspectable.** A calm, consumer-grade conversation in front, with the depth and transparency of a power-user framework one tap behind it.

Specialization is a hypothesis, not a law: delegation adds handoff errors and total cost even as it shrinks the main context. Fabric measures both directions (§6).

## 2. Invariants

Binding. Changing one is a deliberate, dated amendment to this section.

1. **Delegation-first, not delegation-always.** Every request gets an explicit routing disposition, including "handle directly". The assistant stays small and good at understanding you, choosing help, negotiating scope, handling approvals and reporting outcomes.
2. **Agents and teams are first-class.** They are created through conversation from reviewable proposals, never silently instantiated with broad access; reusable across contexts; inspectable at any time.
3. **The registry is searched, not loaded.** The assistant sees compact capability cards, never specialists' skills, tools or schemas.
4. **Agents are definitions; runs are instances.** One definition takes part in many runs and teams, each with its own isolated context.
5. **A team is an operating model, not a group chat:** purpose, members, a lead accountable for the outcome, decision rights, stages and handoffs, completion criteria, budgets.
6. **Context boundaries are a design surface.** What crosses a delegation boundary is minimal and inspectable: you can always ask what a run actually loaded.
7. **New capabilities start minimal.** A proposed specialist's defaults are minimal and explained, never a clone of the assistant. UI toggles describe behaviour; the runtime enforces isolation.
8. **Work is bounded.** Runs carry time, cost and rework budgets. Running out produces an actionable blocked state, not an endless loop.
9. **Memory is scoped:** personal, agent, team/project, run. A specialist's learning never silently writes into the assistant's personal memory.

## 3. Primitives

| Primitive | What it is |
|---|---|
| **Agent** | A reusable definition: identity and role, instructions, skills, tools, model, permissions, scoped memory |
| **Team** | Purpose, members and roles, a lead, an operating model (§5), shared knowledge, completion criteria, budgets |
| **Project** | Groups sessions and tasks. Projects are why work happens; teams are how |
| **Task** | One objective in one project, owned by one team or agent |
| **Run** | One attempt at a task, or one delegation, with its own context, budget and audit trail. Shown as a **loop**; a re-run is a new loop on the same task |
| **Artifact** | An output and its evidence, referenced across boundaries, never pasted |
| **Session** | One conversation thread with one agent. Unread, needs your input, or idle |
| **Proposal** | The reviewable card for a new agent, team or catalog install (§7) |
| **Schedule** | A recurring job owned by an agent or team (`ARCHITECTURE.md` §6.5) |

- **Persona.** Every agent has a name and a portrait on top of its role. The assistant is **Dana**; specialists include Megan (Researcher), Jonah (Coder) and Sana (Validator). Agents are always shown as "Name · Role". The name is proposed on the proposal card, so nothing is renamed after approval.
- **Workspace files.** An agent's identity is markdown, loaded at every run: `SOUL.md` (core truths, voice, boundaries), `IDENTITY.md` (name, role, avatar, team memberships) and `USER.md`. A specialist's `USER.md` is a minimal profile of you, curated by Dana: the ceiling of what it knows about you, changed only by explicit promotion and never a copy of Dana's memory. Each brief picks from it.
- **Registry.** A searchable directory of agents, teams and templates. It powers routing and the "propose a new specialist" flow.
- **Memory scopes.** Personal (about you), agent (a specialist's own lessons), team/project (shared facts and decisions), run (scratch). Promotion between scopes is an explicit, visible act.
- **Organization.** A personal grouping and reporting view: Dana at the head, teams attached by their leads. Not a company (§9).

## 4. Routing

Every request gets a recorded **disposition**, decided by Dana in her normal turn: no separate planning step, and no classifier in front of every request.

| Disposition | When it fits | Example |
|---|---|---|
| Handle directly | Conversation, clarification, or small work in Dana's own scope (§4.1) | "What's the newest Llama release?" |
| Delegate → agent | One specialist can own the outcome | "Make a simple landing page" → Jonah · Coder |
| Delegate → team | It needs several capabilities, dependent stages or independent validation | "Test whether a classifier can make thinking adaptive" → Research Team |
| Propose | Nothing that exists covers it | A proposal card for a new specialist or team (§7) |
| Clarify first | Missing information would change the work materially | An ambiguous objective, no spend limit |

- **Recorded.** What was considered, what was chosen and why: the routing trail you can inspect, and the data that improves routing (`LEARNING.md` §4).
- **A brief, not a transcript.** A delegation carries a task brief: objective, constraints, relevant context, budget, completion criteria (§6).
- **Direct chat with a specialist** is your explicit override, recorded as `direct · user-chosen`. The specialist sees its own `USER.md` and that session, never Dana's memory. Work that needs a run still goes through a brief.

### 4.1 Handling directly

Route by depth, not topic. Quick lookups are assistant work, the way an executive assistant looks something up without calling in an analyst. Dana handles a request herself when it fits all four:

| Criterion | Handle directly | Delegate when |
|---|---|---|
| Tools | Her assistant toolset: web search, calendar, mail, notes | It needs code execution, the sandbox or specialist tools |
| Expertise | General knowledge is enough | It needs a specialist's judgment: weighing benchmarks, licences, methodology |
| Size | A few steps and a chat-length answer | Many sources, cross-checking, a report or other deliverable, or anything recurring |
| Stakes | Informational, reversible, or behind an approval gate | A decision depends on the answer |

- **Ambiguous depth: answer, then offer.** Dana answers at the cheapest depth that is useful on its own and offers more as a one-tap action under the answer ("Have Megan research this"). She clarifies first only when a wrong guess would waste real work.
- **Escalating midway.** When work turns out bigger than it looked, Dana delegates: what she found goes into the brief, and the change is recorded as a new disposition (`direct → agent:megan`, "sources conflict"). This is her judgment; the runtime never forces it. A direct turn is bounded by `MAX_STEPS` and a per-turn cost cap, and hitting the cap stops the turn with an offer to delegate rather than a silent cut-off (§2.8, `RUNTIME.md` §5.1).
- **Learning the line.** Taps on the offer, mid-task escalations and corrections ("no, give that to Megan") are routing data. They move the line for you without adding text to Dana's prompt (`LEARNING.md` §4).
- **Where it lives.** The policy is in Dana's core instructions, because it applies to every request. The examples below are test cases in her benchmark (`LAB.md` §6.1).

| Request | Disposition |
|---|---|
| "What's the newest Llama release?" | Direct, one search |
| "Tell me about the latest advances in open-source models" | Direct briefing with sources, plus the "go deeper" action |
| "Which open model should we use for our product? We decide on Friday" | Delegate → Megan · Researcher, with the decision criteria in the brief: a decision depends on it |
| "Write me a report on open-source model trends" | Delegate → Megan · Researcher: a deliverable |
| "Keep me posted on major open-model releases" | Delegate → Megan · Researcher as a weekly schedule: recurring. Dana confirms first, since a schedule spends on every fire (§8.3) |
| "Check whether Qwen beats Llama on our eval set" | Delegate → Research Team: it runs code and needs independent validation |

## 5. Teams

A team's operating model is data: ordered stages `{label, agents, gate}`, where several agents in one stage work in parallel, plus completion criteria and a rework budget. The lead owns the outcome, not just the message-passing.

- **Done is defined by completion criteria.** For research, for example: hypothesis and baselines explicit; the implementation runs; the evaluation measures quality, latency and cost; conclusions separate measured results from speculation; artifacts are reproducible.
- **Review gates.** A reviewer accepts or requests changes. Rework is bounded by the rework budget; when it runs out, the run blocks and escalates with its evidence.
- **Escalation:** member → lead → Dana → you. Leads report to Dana, not to you directly.
- **Work across teams** is two tasks linked by a handoff, so each has one accountable lead.

The reference team is the Research Team. Its lead plans and synthesizes; an investigator surveys prior work; a coder implements while a validator prepares independent checks in parallel; the validator runs the evaluation; a reviewer inspects the evidence and accepts or sends it back.

## 6. Context

| Context | Receives |
|---|---|
| Dana | Relevant personal context and compact registry cards, searched on demand. Never specialists' skills or tool schemas |
| A specialist, per run | Its own instructions and `USER.md`, plus the brief: objective, constraints, relevant preferences, artifact references. Never the parent's transcript |
| A team | Project facts, decisions and operating rules, retrieved when needed rather than always loaded |
| The return path | Outcome, evidence, open questions, artifact links. Never the internal conversation |

- **Introspection.** Every run answers "what was actually loaded?" with the real assembled context, including what was *not* loaded: your transcript, personal memory, other agents' skills.
- **Failure modes to design against:** a brief too thin to act on; walls of text on the return path; team knowledge that grows without bound; registry cards that become bloat themselves.
- **Bounded base context.** Dana's base context is a fixed part that changes only through deliberate, versioned edits, plus a learned share the runtime caps (`LEARNING.md` §3). It never grows from use. Agent Studio shows each agent's base context; a session shows its conversation history, compacted, separately.
- **Honesty.** Fabric measures per-run cost, handoff rework rate and outcome quality against a single-agent baseline, so it can show where delegation helps and where it doesn't.

## 7. Creating capabilities

When routing finds a gap, Dana writes a **proposal card**, never a live agent:

> **Suggested specialist: Experiment Validator.** Purpose · skills · tools · model · memory scope · restrictions · lifecycle (this task only · save as reusable agent · save as template). **Create · Customize · Use an existing agent instead**

- **Minimal and explained.** Every suggested skill, tool and permission has a one-line justification tied to the task that triggered it.
- **Reuse first.** The card always offers existing agents and templates before creating one.
- **Teams too.** A team proposal names a lead, fills roles with existing agents where it can, flags missing specialists, and previews the workflow, dependencies and budgets before anything runs.
- **Catalog installs are proposals.** Adding an agent or team from the catalog shows its tools, policies and memory scope and needs your approval, like any new capability. Installed agents start with empty memory.
- **Describe, then enforce.** A proposal states what the agent can *do*; the runtime enforces what it *may* (`ARCHITECTURE.md` §9).

## 8. Experience

### 8.1 Principles

1. **Calm by default, inspectable on demand.** The landing page is a conversation with Dana. The organization sits one tap behind it; the home screen is never an agent control room.
2. **Two graphs, two views.** The org view shows who belongs to what; the run view shows how one task executed: lanes, dependencies, handoffs, evidence. Membership is not execution order.
3. **Conversation is the creation surface.** Agents and teams are created through chat and proposal cards, not a settings wizard, and every proposal can be inspected and edited before approval.
4. **Nothing hidden, nothing loud.** Progress arrives as compact cards; detail is drilled into, never pushed.

The target feel is Muse or Grok's assistant apps; the functional depth is Hermes Agent's desktop (profiles, skills, memory, a task board, observability) without its developer density.

### 8.2 Surfaces

| Surface | What it holds |
|---|---|
| **Chat** | The landing page: conversations with Dana, with delegation, progress and proposal cards inline |
| **Weave** | Where the organization reports to you. An inbox of typed asks (approval, question, escalation, proposal, finding, result) with the cost of delay, escalation options when a budget runs out (raise · accept with caveat · stop), and snooze until an event. A Pulse feed of lead updates, memory writes and granted autonomy. Counts only for asks, amber not red, quiet events hidden by default |
| **Work** | Tasks and their loops. A project's board has columns every team shares (Proposed · In progress · In review · Done); a team view shows the same tasks in that team's own steps. A task's page shows its loop: the workflow, member lanes, the brief and its criteria, the inspector, and replays of earlier loops. Asks appear only as flags linking to Weave |
| **Schedule** | Agents' and teams' recurring jobs on a weekly calendar. Past slots show what ran and how it went; future slots show what is planned. A side rail holds a month calendar, an owner filter (agents and teams; a team shows its lead's face) and the list of routines |
| **Agent Studio** | Definitions: agents, teams and organizations. Workspace files as readable markdown with token counts, skills and memory with provenance, the context budget and what fills it |
| **Mobile** | A companion, not a port: chat, Weave, Work at a glance, reports, and push for asks. Agent Studio, the inspector and loop lanes stay on desktop and web |

Weave pushes what needs you; Work shows where everything is. Ideas stay in chat until Dana proposes them.

### 8.3 Approvals and autonomy

- **Approval modes** in the composer: Ask · Auto-approve edits · Full auto. They relax approval only for actions inside the sandbox.
- **Always asks,** whatever the mode and whoever requests it: creating agents, teams or schedules, and the merge, deploy, spend, credential and external-send gates. Gated asks are answered in the app, never from a Weave list action or a chat channel.
- **Execution is isolated by default.** Running on your own machine or a remote host needs explicit approval and states what it can reach.
- **Trust grows with use.** Detail stays visible until you stop needing it, and "why did it do that?" is always one tap away.

## 9. Non-goals and constraints

Non-goals:
- A business agent-workforce platform. Fabric is a **personal** assistant; it may serve your one-person business, but it is not B2B SaaS.
- Agent swarms, or organizations that grow without your approval.
- Replacing your judgment: merge, deploy, spend and credential authority stay with you.
- A workflow language that can express everything. Teams get what they actually need.
- Mobile-first. Desktop and web are primary; the phone is a companion.

Constraints:
- Dana's context stays bounded by design. A super-agent Dana is failure number one.
- Every autonomous boundary has an approval and evidence story.
- Cost visibility is a feature, not telemetry.

## 10. Open questions

1. **Agent or team.** §4.1's examples cover the common cases; a full policy is still owed.
2. **Light requests.** Does pure chat record a disposition, or is everything logged at decreasing detail?
3. **Capability lifecycle.** States beyond proposed, active and retired (pause, archive), and what a template encodes: workflow, budgets, memory policy.
4. **Team vocabulary.** A taxonomy of decision rights, and patterns for completion criteria.
5. **Team copies.** The mockup lets an organization hold the same team twice. Drop it, or define a copy as a separate team with its own knowledge and runs.
6. **Group chat.** A button in the mockup. Remove it, or define it as a session you host with several agents that is explicitly not a team.
7. **Incognito sessions.** The app has them today: no personal-memory recall. Proposed: no session history and no writes to any memory scope, while dispositions and runs are still audited.
