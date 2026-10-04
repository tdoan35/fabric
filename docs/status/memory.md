# MEM status — Mnemosyne → Fabric memory layer (updated 2026-10-04, ~15:00 PT)

Ty's Hermes Agent memory (the Mnemosyne plugin's SQLite store) is now Fabric's personal memory
layer: a `memories` table on Neon, an import script, Dana's recall in chat, the Memory tabs +
Weave Keep/Forget, and a Personal memory section in the inspector. Branch `seq/memory`.

## Import counts (the numbers)

Source: `~/Desktop/fabric/mnemosyne/mnemosyne.db` (opened read-only; never copied; `session_id`
never read — some values embed a phone number).

| Rule | Rows |
|---|---|
| `working_memory` non-chat (`[USER]`/`[ASSISTANT]` dropped), `superseded_by IS NULL` | 26 |
| `episodic_memory` (all) | 93 |
| `canonical_facts` `valid_until IS NULL` | 7 (1 identity → sensitive, 6 task:progress) |
| `memoria_instructions` active ≥ 25 chars, deduped | 17 |
| `memoria_preferences` ≥ 25 chars, deduped | 67 |
| **Imported total** | **210** |

Per kind as imported: `episode 93 · preference 68 · instruction 22 · context 10 · canonical 7 ·
fact 4 · relationship 3 · error 2 · event 1`.

Sensitive: **15** rows flagged (2 by the address rule — `mnemo:canonical_facts:1` identity and
`mnemo:episodic_memory:2ed69e2bf4604e22` — 12 by the credential-word rule, which is a literal
`password/api key/token/secret` match and therefore over-inclusive by design; 1 email). Phone: the
number exists **only** in `session_id` values, which the importer never reads — 0 imported rows
contain it.

## Gates (all run)

1. **Dry-run** (`npm run memory:import -- --dry-run`): 210 rows, kind counts above, sensitive 15;
   samples show no `[USER]` rows; address rows print as `sensitive (withheld)`.
2. **Neon branch first**: created branch `memory` from `production` (expires 2026-11-03), seeded
   lived-in, then imported. **Idempotent: two runs → `upserted 210 memories` both times, count
   210 after each.** Production was not touched.
3. **Tests** (vitest, against the migrated branches):
   - `@fabric/db` 33/33 — new `memory.test.ts`: ranking weights (0.5/0.3/0.2), pinned boost
     measured at exactly 0.1, sensitive/forgotten/minImportance/scope filters, upsert idempotency,
     Keep un-forgets + pins.
   - `@fabric/agents` 81/81 — new `memory.test.ts`: `recallForDana` with an injected fake embedder
     (one embed call, ranked items, rendered section), prompt carries the section and never the
     sensitive text, `measureAssistantContext`/`assistantContextSections` include the memory row.
   - `@fabric/server` 13 passed / 8 skipped (on the migrated `demo` branch) — new
     `memory.test.ts`: decision route 400/404/200, kept pins + forgotten soft-deletes, `/registry`
     memory ids validate against `RegistrySchema`.
   - Fixture-parity note: on a lived-in branch **with** the import, the two "matches the mock
     world" tests fail because Dana now serves real rows and the pulse carries real memory cards —
     the intended change; the zod contract additions are optional (`id?`, `memoryId?`), so
     un-imported branches still match the fixtures (verified on `dev`). `dev`'s remaining parity
     failures (projects/tasks/runs/sessions, stale smoke data) pre-date this work.
   - `npm run typecheck`: green except one **pre-existing** error in the tree's uncommitted work
     (`packages/integrations/src/sprites.ts:28` — `env("SPRITE_ASSISTANT")` before the name is
     declared). Not part of this branch; left alone.
4. **Live** (`npm run check:chat -- --live --times 1 --branch memory`, `FABRIC_DEBUG_PROMPT=1`):
   PASSED. Asking "what's running on my DGX Spark right now?" Dana answered from the
   `task:progress` canonical facts ("Qwen3.8-Flash-Next is your live workload — Docker
   `qwen38-flash` on the single head node…"). The logged system prompt contained the
   `## What you remember about Ty` section and **none of the 15 sensitive rows' text**.
5. **UI** (server + web against the `memory` branch, driven in a browser): Dana's Studio Memory
   tab lists real rows with sources/dates; Forget removes one and it stays gone after reload
   (`forgotten_at` set); Weave Keep pins (`pinned = true` in the DB, card flips to "Kept"/Undo);
   the run inspector's Context tab shows Dana's context with **"Personal memory · Mnemosyne ·
   6 items"** while specialists keep "Not loaded: your chat transcript · personal memory · …".

## Latency (first text, live happy path)

| Turn | Before (docs/status/dana.md) | After (this branch) |
|---|---|---|
| idea · disposition | 6.7 s | 6.7 s |
| idea · first text | 11.1 s | **7.8 s** |
| approve-team · first text | 8.5 s | **4.6 s** |
| approve-specialist · first text | 7.7 s | **4.4 s** |

Recall itself (micro-benchmarked, warm): embed **7.7 ms**, search ~80–160 ms (Neon us-east-2 RTT
dominates; a scale-from-zero cold compute once hit ~660 ms), total ≈ 90–170 ms inside the turns'
`Promise.all` — under the model's first-token time. The embedder is warmed at server boot
(`[memory] embedder warm`, ~0.5 s from cache); the prompt grew by only ~140–240 chars/turn
(system prompt 10.0k–10.2k chars logged).

## How it fits

- **`packages/db`**: `memories` table (`mnemo:<table>:<origin id>` ids, `scope/scope_id/kind`,
  `importance/pinned/sensitive`, `event_at/created_at/forgotten_at`, `embedding vector(384)`,
  generated `tsv` + GIN). Migration `0005_memories.sql` (renumbered after schedule's 0004 at the merge) starts with `CREATE EXTENSION IF NOT
  EXISTS vector`. No HNSW (≈210 rows; exact scan). `memories` is **not** in the seed truncate
  list. `memory.ts`: `upsertMemories` (content/embedding track the source; `pinned`/`forgotten_at`
  survive re-imports), `searchMemories` (one query: `0.5·(1−cosine) + 0.3·normalized ts_rank_cd +
  0.2·importance` + 0.1 pinned boost, `forgotten_at IS NULL`, sensitive excluded unless
  `includeSensitive`), `listMemories` (pinned → importance → recency; `recent` order for pulse),
  `decideMemory` (kept pins + clears a past Forget; forgotten soft-deletes). `db` takes raw
  vectors — no embedder dependency.
- **`packages/agents/src/memory`**: lazy singleton `embed`/`embedQuery`
  (`Xenova/bge-small-en-v1.5`, 384-d, q8, `cls`, normalized; queries carry bge's
  "Represent this sentence for searching relevant passages: " prefix), `warmEmbedder` (server
  boot), `recallForDana(db, text, { embed?, k? })` → `{ items, content, tokens }` with the
  injectable embedder for offline tests, `renderMemorySection` (≤ what search returns, source +
  date per item, never-repeat-sensitive instruction).
- **Dana**: `liveLines` runs `recallForDana` in the existing `Promise.all` (newest user text as
  the query; skipped for incognito threads via the additive `incognito` chat-request field;
  failures log and read as no memory). `buildSystemPrompt(dana, registry, memory?)` appends the
  section after her files. No new tools.
- **Tabs + Weave**: `readRegistry` fills Dana's `workspace.memories` from `listMemories(20)`
  (seeded JSON keeps serving on un-imported branches); `POST /memories/:id/decision`; web api
  `decideMemory` (http + mock no-op); Studio + assistant-hero Memory tabs get Forget on `id` rows;
  `weave.decideMemory` writes through when the pulse entry carries `memoryId`; `readWeave` adds
  pulse cards for the 3 newest non-sensitive memories.
- **Inspector**: the handoff records Dana's own `context_snapshots` row
  (`assistantContextSections`: Workspace files · Skills · Connectors · Personal memory
  "Mnemosyne · N items"), and `runs.assistant_tokens` counts the section
  (`measureAssistantContext(profile, memory?)`). Specialists' snapshots are untouched.

## Next / not done

- Production and `demo`/`dev` have migration `0004` applied only where noted (`demo` yes, `dev`
  yes, `memory` yes; **production not migrated — needs Ty's go**). The registry/weave reads
  require the table once this code ships anywhere.
- The credential regex over-flags ~12 rows ("token" in LLM-token contexts); narrowing it to
  assignments (`token = …`, `api_key: …`) would recover ~6% recall if it ever matters.
- No write path from chat yet: memory changes happen in the UI (Keep/Forget), by design for this
  pass.
