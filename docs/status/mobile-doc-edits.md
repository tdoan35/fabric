# Proposed doc edits from MOB-D (for the owner to apply)

MOB-D may not edit `CONCEPT.md` / `WORK-PLAN.md` directly. Below are the two MOBILE-PLAN §8
amendments as exact drop-in text. Nothing else in either file needs to change.

## 1. CONCEPT.md §10 — "Non-goals (v1)"

Keep the existing "Mobile-first" bullet unchanged, and add one bullet directly after it:

```markdown
- Mobile-first (assumed desktop/tablet first; challenge if wrong).
+ - A mobile **companion** (asks, status, results) is in scope; creation and inspection stay desktop.
```

Resulting passage:

```markdown
- Mobile-first (assumed desktop/tablet first; challenge if wrong).
- A mobile **companion** (asks, status, results) is in scope; creation and inspection stay desktop.
```

## 2. WORK-PLAN.md §6 — workstream table

Add one row to the §6 table, directly after the **DESKTOP** row (both are platform rows; "Needs"
points at the workstreams this one waits on):

```markdown
| **DESKTOP** — Platform | Settings persisted and applied; server URL configurable in Electron (or the server embedded in Electron); packaging for macOS and Windows; single-user auth; server deployed to Fly | — | FND |
+ | **MOBILE** — Companion app | Dev build (EAS), push notifications for asks / blocked runs / results, decisions from the phone, approving proposals from the phone, workspace merge | CONCEPT §8.3.5 | WEAVE, DESKTOP |
```

Resulting table tail:

```markdown
| **DESKTOP** — Platform | Settings persisted and applied; … | — | FND |
| **MOBILE** — Companion app | Dev build (EAS), push notifications for asks / blocked runs / results, decisions from the phone, approving proposals from the phone, workspace merge | CONCEPT §8.3.5 | WEAVE, DESKTOP |
| **ORG** — Organizations and registry | … | CONCEPT A-4; ORG-3 | STUDIO |
| **QUALITY** — Evals and durability | … | CONCEPT §9.2.1, §9.2.8 | TEAM, DANA |
| **MODELS** — Model and context | … | CONCEPT A-10; CHAT-8, CHAT-9 | DANA |
```

## Already applied elsewhere (no owner action needed)

- `DEMO-SCRIPT.md` §3/§4/§5 — the optional 4:40 phone beat (cuttable, 14:00 cut rule), the
  real-or-seeded disclosure for phone-side decisions, and the mobile checklist lines were added
  directly by MOB-D (explicitly allowed for this step).
- `MOBILE-PLAN.md` §8 lists a third item ("DEMO-SCRIPT §3 / §5"); those edits are in, so §8 of the
  plan can be ticked off whenever the owner next touches it.
