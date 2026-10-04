# TOOLS status — updated Sun Oct 4, ~10:21 PDT (branch `seq/tools`)

Step 6 of §7.0: TOOLS 1–6 plus the brief's decisions 1–7. 6 commits on `seq/tools`, nothing merged
or pushed. Gates: typecheck · test (server 18 / agents 54 / db 26 / integrations 11) ·
`build -w web` · `check:data` (55.3 s) · `check:chat` fixture (97.9 s) all green;
`check:tools` PASSED (40.7 s, real services); the UI dev-route check PASSED (Exa line in
Megan's lane at 4.5–5.3 s, Jonah's terminal streaming, the blocked fetch in the Tools tab);
CARD-3 verified with the flag off (nothing) and on (`sana-fabric@agentmail.to` on the card).
Screenshots: `/tmp/fabric-tools/shots/`.

## Spikes

- **S2 (Sprites) — pass.** `@fly/sprites` 0.2.3 against the two pre-created Sprites
  (`fabric-coder`, `fabric-validator`, both `cold` when idle). Numbers from `npm run check:tools`
  (sequential, home network):

  | what | time |
  |---|---|
  | raw cold start (attach + policy apply + boot + `true`) | **552 ms** |
  | raw warm exec (`echo`) | **467 ms** |
  | sprite.exec through the tool (versions cmd, incl. streamed term events) | 1 958 ms |
  | sprite.exec through the tool (3-line loop, 0.4 s sleeps) | 2 429 ms |

  The tool-layer gap is the throttled `tool.result` term events (25 ms floor each + the Neon
  write) and the exec round trips — tune `ToolIO.minGapMs` if the demo needs faster terminals.
  Egress is real: the policy (6 allow rules, applied idempotently before every exec) turns
  `curl https://example.com` into `Could not resolve host` (DNS REFUSED) while `pypi.org`
  returns 200; the failed fetch surfaces as `tool.denied {network.fetch, example.com,
  "not on the egress list"}`. Files: `workspace.write` + read helper round-trip through the
  Sprite filesystem (`/root`).
- **S5 (AgentMail) — pass, no email sent.** `agentmail` 0.5.35 with the org-wide key.
  `createInbox("sana")` is idempotent on the fixed username `sana-fabric` (lookup before
  create; the list endpoint can lag a create, so "already exists" is treated as success —
  verified by the check calling it twice: 2 inboxes on the account afterwards, the owner's and
  Sana's; one slot spare). The address lands in Sana's existing AgentMail connector
  (`available → connected`, no schema change), `readRegistry` maps it to `StudioProfile.inbox`,
  and `registry.changed` fires — CARD-3 verified both ways (below). `sendReportEmail` renders
  the whole report as text and sends from Sana's inbox with the owner's as send-only fallback;
  unit-tested with a mocked client. **No real email was sent** — that stays behind the owner's
  explicit yes.
- **S6 (Executor) — fail for phase 1, fallback in place** (time-boxed ~30 min, after everything
  else passed):
  - Executor Cloud (`EXECUTOR_URL`): MCP `initialize` → **401 Unauthorized**; sign-in is
    OAuth-only and `EXECUTOR_KEY` is empty, so no refresh token to use.
  - Local Executor (Docker `ghcr.io/rhyssullivan/executor-selfhost:latest`): boots headlessly
    (`EXECUTOR_BOOTSTRAP_ADMIN_*`), email sign-in returns a session token that works as the MCP
    Bearer; `initialize` + `tools/list` succeed (`execute`, `skills`). But policies are **per
    tool, org-wide** (`/api/policies`) — no per-agent scoping, matching the integrator's finding —
    and the policy-write API shape isn't documented (my three guesses all 400'd) within the box.
    Probe container and volume deleted afterwards.
  - **Fallback (kept):** our own allowlist enforced in the tool wrapper — labelled
    **"behavioral scoping"** wherever enforcement isn't real. What IS real: the Sprite's DNS
    egress policy (S2) and blocked/approval tool policies at the tool layer (they deny and the
    model sees the error). `agentmail.send` stays approval-denied in phase 1.
- **S7 (Exa) — pass.** `exa-js` 2.25.0, the skill's recommended shape only:
  `{contents: {highlights: true}}`, `type: "fast"` on the live-start path. `fast` **475–1 305 ms**
  across runs (10 results, highlights on all; the Engram paper is the top hit for the demo
  query), `auto` ~1 081 ms. Narration lines match the mock's
  (`exa.search "…" · fast`, `10 results · 10 highlights kept`). The `.cache/exa/` fallback
  serves the last results per query when Exa errors or exceeds 8 s, labelled `(cached)`.


### UI verification (dev route, headless Chrome over CDP, fresh profile)

- `node ui-check.mjs` (PASS): `POST /api/dev/tools` → the loop view live — the Exa narration in
  Megan's panel at **4.5–5.3 s** from the POST (target: 10 s), Jonah's terminal streaming
  (`$ python3 --version` → `Python 3.13.7`, `uv 0.12.13`, `check 1/3…3/3`,
  `wrote tools-check.md · 43 chars`), and the Tools tab showing
  `Blocked at 9s: network.fetch → files.example.org (not on the egress list)` over the four
  policies. Shots: `ui-0-board`, `ui-1-megan-exa` (Live badge), `ui-2-jonah-terminal`,
  `ui-3-tools-tab-blocked`, `ui-4-loop-after`.
- `node card3.mjs off|on` (PASS both): fixture Dana approves Sana's card; with
  `FEATURE_AGENTMAIL=off` the registry has no inbox and the card shows none
  (`card3-off-…png`); with `=on` the connector updates, `registry.changed` fires and the card
  shows `✉ Inbox sana-fabric@agentmail.to · created` (`card3-on-…png`).

## Done

- **Tool registry** (`packages/integrations`): every tool is an AI SDK tool object built by
  `toolsFor(agent, ctx)` from the agent row's `agents.tools[].policy`:
  - `names.ts`: provider-safe keys (`sprite_exec`, `exa_search`, … — Anthropic/OpenAI reject
    dots) with `TOOL_KEYS` / `toolKeyOf` / `toolNameOf` mapping back to canonical `ToolName`s
    for policies and events.
  - `tool-context.ts`: the shared spine. Every call emits `tool.call {tool, summary}` before
    anything else; terminal output streams as line-buffered, throttled `tool.result
    {line, kind: "term"}` (25 ms floor, 400-line cap with one truncation note); narration goes
    out as `agent.message`; blocked and approval-only policies emit `tool.denied` and return
    `{ok: false, error}` to the model ("needs approval" for approval — a Weave ask in phase 2).
    `RunClosedError` from `writer.emit` is swallowed with one log line and further events drop
    (the work itself continues).
  - `tools/`: `sprite.exec` (streams, `$ <cmd>` echo like the mock, timeout default 120 s /
    max 600 s, exit code + 2 KB tail to the model, blocked-fetch detection), `workspace.write`
    (Sprite file, or a run artifact for agents without a sandbox), `artifacts.read`/`.write`
    (RunWriter.saveArtifact — which also emits `artifact.created`; read lists/reads by name via
    the new `ctx.db` dep), `exa.search`, `network.fetch` (policy + the same egress allowlist),
    `agentmail.send`, and `teamAssignTool(agent, policy, ctx, teamCallback)` — TEAM's factory.
- **Sprites** (`sprites.ts`): memoized `SpritesClient`; `jonah → SPRITE_CODER`,
  `sana → SPRITE_VALIDATOR`; `sandbox = sprite/<name> · egress: package index + model host only`;
  `EGRESS_ALLOWLIST` = pypi.org, files.pythonhosted.org, huggingface.co, cdn-lfs(±us-1),
  cas-bridge.xethub.hf.co; `ensureEgressPolicy` diffs and applies before every exec.
- **AgentMail** (`agentmail.ts`): `createInbox(agentId, {db?, publish?})` — persona-guarded
  (phase 1: Sana only), idempotent, records into the connector, publishes `registry.changed`;
  `sendReportEmail(report, to)` + `renderReportEmail`; `OWNER_INBOX` send-only fallback.
- **Wiring**: Sana's fixture connector no longer seeds the fake `sana@fabric.mail` (the registry
  shows `available` with no address until `createInbox` succeeds); `readRegistry` maps a
  connected AgentMail connector to `StudioProfile.inbox`; `services/runtime.ts` gates
  `createAssistant`'s `createInbox` on `FEATURE_AGENTMAIL=on` + `AGENTMAIL_API_KEY` (off → an
  explicit no-op, so dev runs never spend an inbox or a daily send).
- **`POST /api/dev/tools`** (non-production mount): sim-style scratch run through the REAL
  tools — Megan's `exa.search` and Jonah's `sprite.exec` / `workspace.write` / blocked
  `network.fetch` — with CTX snapshots saved first (what TEAM will do), events streaming over
  SSE, ending as `stopped`.
- **`npm run check:tools`** (`scripts/check-tools.ts`): seeds demo, starts its own server, and
  asserts everything above plus the CARD-3 chain, reading events back via
  `GET /api/runs/:id/events`; ends with the latency table. Reseeds demo to leave it clean.
- **Unit tests** (11): idempotent `createInbox`, persona guard, email render/from-fallback,
  and the policy wrapper's events (blocked → `tool.denied` + model error, approval → "needs
  approval", allowed → runs; provider-key shape; policies mirror the row).

## Next

- TEAM (step 7) consumes `toolsFor` + `teamAssignTool` (notes below).
- OPS: turn `FEATURE_AGENTMAIL=on` for rehearsals and the demo (email + inbox on approval);
  it stays off in dev.

## Blocked (on whom)

- A real `sendReportEmail` send needs the owner's explicit yes in-session (100/day budget,
  owner's inbox involved). Not asked yet; nothing sent.

## Requests (contract / path / decision)

- **No `contracts:` commits** — nothing needed adding; the frozen `ToolName`/event payloads
  covered everything.
- **Path notes (§7.0 allows these; for review):**
  - `packages/fixtures/src/studio.ts`: Sana's connector `available` + Dana's lived-in profile
    declares its illustrative `inbox` (parity with the new registry mapping).
  - `packages/db/src/read.ts`: the connector → `inbox` mapping in `profileFromRow` (2 lines).
  - `apps/server/src/services/runtime.ts` (the FEATURE_AGENTMAIL gate),
    `apps/server/src/routes/dev.ts` + `services/dev-tools.ts` (new dev route),
    `apps/server/package.json` (+`@fabric/agents` dep for the dev route's snapshots).
  - Root `package.json` (+`check:tools`), `.gitignore` (+`.cache/`),
    `packages/integrations/package.json` + lockfile (deps: ai, zod, @fly/sprites, exa-js,
    agentmail; devDeps vitest, @fabric/fixtures, @types/node).

## Deviations

- **`AgentTools.tools` is keyed by provider-safe names** (`sprite_exec`), not `ToolName` — the
  brief's decision 1; the set then goes straight into `generateText`/`streamText` `tools`.
- **`workspace.write` without a sandbox writes an artifact** (Elliot): the lead can still write
  the plan; `sprite.exec`/sandbox tools are simply absent for agents without a Sprite.
- **Blocked-fetch detection in `sprite.exec` is a bounded heuristic**: URLs in the command +
  network-failure markers in the output (exit code alone misses `; true` tails) → one
  `tool.denied` per off-allowlist host. The egress enforcement itself is the Sprite's and real.
- **`team.assign` is not in `toolsFor`'s set** — it needs TEAM's callback; `policies` still
  lists it so snapshots show it. Build it with the exported `teamAssignTool`.
- **The dev route ends its run as `stopped`** (board stays clean; finalize is a no-op for
  stopped runs, so no report/weave noise from dev runs).
- **`createInbox`'s signature grew additively** (`{db?, publish?}` + an injectable client for
  tests); the §4.6 `createInbox(agentId)` call still works.
- **Dana's lived-in fixture declares `inbox: "dana@fabric.mail"`** — illustrative, same world
  data the connector already showed; keeps `registry == fixtures` true under the new mapping.
- **S6's label**: our tool-policy layer is "behavioral scoping" (ARCH §1.3); the inspector
  footer line still mentions Executor — OPS may want to reword it to name the real enforcers
  (tool layer + Sprite egress) for the demo.

## Notes for TEAM

- **toolsFor**: `toolsFor(agent, { runId, step, writer, db? })` → `{ tools, policies, sandbox }`.
  Pass `tools` straight to the AI SDK (`generateText({ tools: set.tools, … })`); the keys are
  provider-safe, so map back with `toolNameOf(key)` anywhere you switch on names. `db` (the
  server's `Db`) enables `artifacts.read`; `sandbox` is the full inspector line
  (`sprite/fabric-coder · egress: …`), ready for `assembleContext`'s `sandbox` field — the dev
  route's `snapshotFor` in `services/dev-tools.ts` is the pattern, including saving the
  snapshot BEFORE the step (otherwise the Inspector's Tools tab stays empty).
- **team.assign**: `teamAssignTool(agent, policyFrom(set.policies), tctx, yourAssign)` where
  `tctx = {runId, step, writer, actor: agent.agent.id}`; your callback gets
  `{agentId, step, note?}` and whatever it resolves to is returned to the model.
- **Events per tool** (canonical names in events, always): every call → `tool.call {tool,
  summary}`; `sprite.exec` → `tool.result {line, kind:"term"}` per line (first line is
  `$ <command>`) and `tool.denied {network.fetch, host}` for refused egress;
  `exa.search` → two `agent.message` narration lines; `artifacts.write` → `artifact.created`
  (from `RunWriter.saveArtifact`); `workspace.write` in a sandbox → one term line, else
  `artifact.created`; blocked/approval policies → `tool.denied {tool, target, reason}` with
  reason "blocked by policy" / "not on the egress list" (network.fetch) / "needs approval".
- **Sandbox ids**: `jonah → sprite/<SPRITE_CODER>`, `sana → sprite/<SPRITE_VALIDATOR>` (env
  names, `fabric-coder`/`fabric-validator` today); nobody else has one.
- **Exa cache**: `.cache/exa/<sha256(mode,query)>.json`, gitignored, written on success, read
  on error or after an 8 s timeout, result flagged `cached: true` and the narration labelled
  "(cached)" — ARCH §11's labelled fallback. Delete the dir to force fresh searches.
- **Timeouts**: `sprite.exec` 120 s default (arg `timeoutMs`, ≤ 600 s, exit 124 on kill);
  `network.fetch` 10 s; Exa 8 s. Nothing else bounds a tool call — wrap steps with your own
  per-step timeout (WORK-PLAN TEAM 5).
- **RunClosedError**: event emission inside tools swallows it (one log line, narration stops,
  work continues) — but `writer.saveArtifact`, `startRun` and friends still THROW it to you, so
  wrap step bodies; `cancelRun` should be yours, and note an in-flight `sprite.exec` is not
  killed by closing the run (we don't expose a kill handle; the command finishes server-side).
- **Policies** come from the agent row and are enforced in the wrapper; unlisted tools are
  absent from the set (a call attempt can't happen), listed-but-blocked ones deny loudly.

## How to verify

```bash
git checkout seq/tools && npm i
npm run typecheck && npm test && npm run build -w web     # all green
npm run check:data && npm run check:chat                  # unchanged (55.3 s / 97.9 s)
npm run check:tools                                       # real services, ~41 s, latency table
# the dev route + UI (screenshots in /tmp/fabric-tools/shots):
npm run seed -- --profile demo --branch demo
/tmp/fabric-tools/server.sh &                             # demo branch, never prints the URL
VITE_API_MODE=http npm run dev -w web &                   # :3000
/opt/google/chrome/chrome --headless=new --remote-debugging-port=9344 \
  --user-data-dir=/tmp/fabric-tools/chrome-$(date +%s) about:blank &
cd /tmp/fabric-tools && node ui-check.mjs                 # terminal, exa lane <10 s, Tools tab
node card3.mjs off                                        # approve Sana fixture-style: no inbox
# then restart the server with FEATURE_AGENTMAIL=on in the env and
node card3.mjs on                                         # card shows sana-fabric@agentmail.to
npm run seed -- --profile demo --branch demo              # leave demo clean
```
