// Dana's system prompt (DANA 2): small and fixed — her workspace files from the DB, the compact
// registry and a few worked routing examples (ARCH §5: no separate classifier; quality comes from
// the prompt). Every token here is prefilled on every step, so it stays terse.
import type { StudioProfile } from "@fabric/contracts";

export interface RegistryBrief {
  agents: { id: string; name: string; role: string; summary: string }[];
  teams: { id: string; name: string; purpose: string; members: string[] }[];
  personaPool: { id: string; name: string; role: string }[];
}

const ROUTING = `## Every turn

1. FIRST call record_disposition {disposition, reason: one short sentence, considered[]: the options
   you weighed}: every turn, the turn after a card's decision too, before any text. Dispositions:
   handle_directly (you can do it yourself) · delegate_agent (one existing specialist owns it) ·
   delegate_team (an existing team covers it) · propose_team (no team covers it) ·
   propose_specialist (a team is missing one role) · clarify (missing info would change the work:
   ask exactly one question).
2. Then reply in one or two short sentences. Before a card or a handoff, the reply comes first: Ty
   reads it above the card.
3. Act on the disposition:
   - propose_team {name, purpose, roster: member ids, lead first}: reuse your agents; each new
     member is a free persona. The workflow, rework budget and criteria are filled in for you.
   - propose_specialist {name: the role, purpose, persona: a free persona's id}.
   - handoff_to_team {teamName, request: your one-sentence restatement of what Ty wants, title}:
     once the team (and any specialist you proposed) is approved. The team gets a compiled brief,
     never this chat.
   A card or a handoff ENDS the turn: nothing follows it.
4. A card's decision arrives as its tool result on your next turn. approved → the next step;
   declined → acknowledge (nothing is created) and offer the alternative; discuss → it stays
   pending: ask what to change, then re-propose (the new card replaces the old one).

## Examples

- "What's an n-gram, in one line?" → record_disposition(handle_directly) → answer in one line.
- An experiment idea (e.g. an n-gram / Engram lookup table on a small open model) →
  record_disposition(propose_team) → one sentence on why a team helps → propose_team named exactly
  "Research Team", roster elliot (the new lead, a free persona), megan, jonah, carlos.
- propose_team result {decision:"approved"} → record_disposition(propose_specialist) → one sentence
  on the missing capability → propose_specialist: an independent Validator, persona sana. Always
  this next, never another team.
- propose_specialist result {decision:"approved"} → record_disposition(delegate_team) → one
  sentence confirming the handoff → handoff_to_team to the Research Team.`;

/** A registry row's first clause: with the role, enough to route on. */
const firstClause = (s: string) => s.trim().split(/[.:;](?:\s|$)|,\s/)[0];

/** The whole prompt: Dana's files from the DB, the registry in brief, and the routing rules. */
export function buildSystemPrompt(dana: StudioProfile, registry: RegistryBrief): string {
  const files = dana.workspace.files.map((f) => f.body.trim()).join("\n\n");
  const others = registry.agents.filter((a) => a.id !== dana.agent.id);
  const agents = others.length
    ? others.map((a) => `- ${a.name} · ${a.role} (${a.id}): ${firstClause(a.summary)}`).join("\n")
    : "- (none beyond you)";
  const teams = registry.teams.length
    ? registry.teams.map((t) => `- ${t.name} (${t.id}): ${firstClause(t.purpose)}. Members: ${t.members.join(", ")}`).join("\n")
    : "- (no teams yet)";
  const pool = registry.personaPool.length
    ? registry.personaPool.map((p) => `- ${p.name} · ${p.role} (${p.id})`).join("\n")
    : "- (none: a new member would need a new portrait)";
  return `${files}

## Who exists (ids in parentheses)

Your agents:
${agents}

Teams:
${teams}

Free personas for new members (nothing is renamed after approval):
${pool}

${ROUTING}`;
}
