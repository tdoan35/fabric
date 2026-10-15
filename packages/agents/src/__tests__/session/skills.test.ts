// ANY-83 M3 — the listed cases N1, N2, N5 and N6, verbatim from the card.
// N1/N2: the pure layer — the toolset defaults give every agent the two
// skills tools (a row can still block one), and withSkillsIndex stamps the
// rendered index onto the definition's system prompt. N5/N6: the session
// loop with M2's skillTools behind the registry — a read runs unasked in
// mode ask and lands its body; another agent's skill is an unknown skill.
// Embedded PGlite, scripted model, temp dirs — no network.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { append, MemoryQueue, openStore, runUntilIdle, type EventInput } from "@fabric/runtime";
import type { RuntimeStore } from "@fabric/runtime";
import { expect, test } from "vitest";
import { createRegistry, type ToolRegistry } from "@fabric/tools";
import {
  ensureSkillsSchema,
  importSkills,
  renderSkillIndex,
  skillTools,
  skillsStore,
  SKILL_INDEX_HEADER,
  type SkillIndex,
  type SkillsStore,
} from "@fabric/memory/skills";
import {
  SKILL_TOOL_DEFAULTS,
  definitionAccess,
  sessionTools,
  specialistSessionDef,
  withSkillsIndex,
  withToolset,
  type SpecialistAgent,
  type SpecialistSessionDef,
} from "../../assistant/session";

const WORKSPACE = "ws-m3";
const AGENT: SpecialistAgent = {
  id: "researcher",
  name: "Renna",
  role: "Research",
  instructions: "# SOUL.md\n\nYou are the studio's researcher.",
};

/** The stamp's def shape beyond SpecialistSessionDef (T14's test twin). */
type StampedDef = SpecialistSessionDef & {
  toolSchemas?: { name: string }[];
  toolEffects?: Record<string, unknown>;
  toolPolicy?: Record<string, unknown>;
};

/** A store with no skills: skillTools only ever reads it here. */
const EMPTY_SKILLS: SkillsStore = {
  write: async () => {
    throw new Error("not used in this fixture");
  },
  list: async () => [],
  read: async () => undefined,
  readFile: async () => undefined,
  versions: async () => [],
};

// -- N1 ------------------------------------------------------------------------

test("N1 Toolset: an agent with no rows gets skills_list and skills_read as allowed reads; a blocked skills_read row leaves only skills_list", () => {
  const registry = createRegistry(skillTools(EMPTY_SKILLS));
  const names = new Set(registry.names());
  expect(names).toContain("skills_list");
  expect(names).toContain("skills_read");

  const open = definitionAccess([], names, SKILL_TOOL_DEFAULTS);
  expect(open).toEqual({ skills_list: "allowed", skills_read: "allowed" });

  const def = withToolset(specialistSessionDef(AGENT), { registry, access: open }) as unknown as StampedDef;
  expect(def.tools).toEqual(["ask_user", "skills_list", "skills_read"]);
  expect(def.toolPolicy?.skills_list).toEqual({ access: "allowed", gate: "none", kind: "read" });
  expect(def.toolPolicy?.skills_read).toEqual({ access: "allowed", gate: "none", kind: "read" });
  expect(def.toolEffects?.skills_list).toBe("read");
  expect(def.toolEffects?.skills_read).toBe("read");

  // a row naming either tool overrides the default: blocked removes it
  const blocked = definitionAccess([{ name: "skills_read", policy: "blocked" }], names, SKILL_TOOL_DEFAULTS);
  expect(blocked).toEqual({ skills_list: "allowed", skills_read: "blocked" });
  const narrowed = withToolset(specialistSessionDef(AGENT), { registry, access: blocked }) as unknown as StampedDef;
  expect(narrowed.tools).toEqual(["ask_user", "skills_list"]);
  expect("skills_read" in (narrowed.toolPolicy ?? {})).toBe(false);
});

// -- N2 ------------------------------------------------------------------------

test("N2 withSkillsIndex: an empty index is the identity; a non-empty index ends the system with it; the same inputs agree", () => {
  const def = specialistSessionDef(AGENT);

  const empty: SkillIndex = { text: "", included: [], omitted: 0 };
  expect(withSkillsIndex(def, empty)).toEqual(def);

  const text = [
    SKILL_INDEX_HEADER,
    "- lit-review — Run a structured literature review and summarize findings with citations.",
    "- release-notes — Draft release notes from merged pull requests, grouped by area.",
  ].join("\n");
  const index: SkillIndex = { text, included: ["lit-review", "release-notes"], omitted: 0 };

  const stamped = withSkillsIndex(def, index);
  expect(stamped.system.endsWith(`\n\n${text}`)).toBe(true);
  expect(stamped.system).toBe(`${def.system}\n\n${text}`);
  // only system moved; the rest is byte-identical
  expect({ ...stamped, system: undefined }).toEqual({ ...def, system: undefined });

  // pure: the same inputs twice stamp the same definition
  expect(withSkillsIndex(def, index)).toEqual(stamped);
});

// -- the loop harness (N5/N6) ---------------------------------------------------

interface FakeResult {
  text: string;
  toolCalls: readonly Record<string, unknown>[];
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  finishReason: string;
}

/** The scripted model: one entry per call, verbatim; every request recorded
 * (duck-typed — the decide port's request carries the stamped system). */
class FakeModel {
  calls = 0;
  readonly requests: { system?: unknown }[] = [];
  readonly #script: FakeResult[];
  constructor(script: FakeResult[]) {
    this.#script = [...script];
  }
  async call(request: unknown): Promise<FakeResult> {
    this.requests.push(request as { system?: unknown });
    this.calls += 1;
    const entry = this.#script.shift();
    if (entry === undefined) throw new Error("FakeModel: no scripted entry left");
    return { ...entry, toolCalls: [...entry.toolCalls] };
  }
}

const callResult = (id: string, name: string, args: Record<string, unknown>): FakeResult => ({
  text: "",
  toolCalls: [{ id, name, args }],
  usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
  finishReason: "tool-calls",
});

const textResult = (text: string): FakeResult => ({
  text,
  toolCalls: [],
  usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
  finishReason: "stop",
});

const LIT_BODY = "# Literature review\n\nSearch, screen abstracts, then summarize each paper with its citation.";

/** One valid SKILL.md: frontmatter naming the folder, then the body. */
const skillMd = (name: string, description: string, body: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;

/** A temp root with the two M3 fixtures, for importSkills. */
async function fixturesRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "fabric-m3-agents-"));
  await mkdir(path.join(root, "lit-review"));
  await writeFile(
    path.join(root, "lit-review", "SKILL.md"),
    skillMd("lit-review", "Run a structured literature review and summarize findings with citations.", LIT_BODY),
  );
  await mkdir(path.join(root, "release-notes"));
  await writeFile(
    path.join(root, "release-notes", "SKILL.md"),
    skillMd("release-notes", "Draft release notes from merged pull requests, grouped by area.", "# Release notes\n\nGroup by area."),
  );
  return root;
}

interface StoredEventLike {
  type: string;
  payload: Record<string, unknown>;
}

/**
 * The M3 turn definition, composed as the server's stamp composes it: the
 * toolset over the registry (defaults give both skills tools), then the index
 * rendered from the agent's live skills onto the system prompt.
 */
async function m3TurnDefinition(skills: SkillsStore, registry: ToolRegistry): Promise<Record<string, unknown>> {
  const access = definitionAccess([], new Set(registry.names()), SKILL_TOOL_DEFAULTS);
  const tooled = withToolset(specialistSessionDef(AGENT), { registry, access });
  const index = renderSkillIndex(await skills.list(AGENT.id), { role: "specialist" });
  return withSkillsIndex(tooled, index) as unknown as Record<string, unknown>;
}

/** Boots the researcher's stream, imports the fixtures for `importFor`,
 * stamps the M3 definition over that store's live skills, and drains the turn. */
async function runTurn(opts: { script: FakeResult[]; importFor: string }) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "fabric-m3-loop-"));
  const runDir = path.join(dataDir, "agent");
  const store: RuntimeStore = await openStore({ driver: "pglite", dataDir });
  try {
    await ensureSkillsSchema(store);
    const skills = skillsStore(store, WORKSPACE);
    const fixtures = await fixturesRoot();
    try {
      await importSkills(skills, fixtures, { agentId: opts.importFor });
    } finally {
      await rm(fixtures, { recursive: true, force: true });
    }

    const queue = new MemoryQueue();
    const registry = createRegistry(skillTools(skills));
    const definition = await m3TurnDefinition(skills, registry);
    const model = new FakeModel(opts.script);
    const tools = sessionTools({
      recall: async () => [],
      registry: {
        tools: registry,
        scope: async (io) => ({
          workspaceId: io.workspaceId,
          streamId: io.streamId,
          agentId: io.agentId,
          callId: io.callId,
          runDir,
          secret: async () => {
            throw new Error("no secret in this fixture");
          },
        }),
      },
    });

    const streamId = `session:${AGENT.id}`;
    await store.transaction((tx) =>
      append(tx, WORKSPACE, [
        {
          streamId,
          events: [
            { type: "session.created", actor: "api", payload: { agentId: AGENT.id, incognito: false, surfaces: ["app"] } },
            {
              type: "run.created",
              actor: "api",
              payload: { definition, engineVersion: "m3", brief: "", grants: [], budgets: {}, parent: null },
            },
            {
              type: "message.received",
              actor: "user",
              payload: { text: "load the skill", attachments: [], surface: "app", sender: "tester", platformMessageId: "pm-1" },
            },
          ] satisfies EventInput[],
        },
      ]),
    );
    await store.transaction((tx) =>
      queue.enqueue(tx, { type: "decide", key: `decide:${streamId}:boot`, streamId, workspaceId: WORKSPACE }),
    );

    await runUntilIdle({ store, queue, ports: { model, tools, surface: { send: async () => ({}) } }, workerId: "worker-m3" }, 100);

    const events = (await store.readStream(streamId, { workspaceId: WORKSPACE })) as unknown as StoredEventLike[];
    return {
      events,
      model,
      cleanup: async () => {
        await store.close();
        await rm(dataDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }
}

const of = (events: StoredEventLike[], type: string) => events.filter((event) => event.type === type);

// -- N5 ------------------------------------------------------------------------

test("N5 loop, mode ask: skills_read runs as a read with no approval wait and its completion carries the skill's body", async () => {
  const { events, model, cleanup } = await runTurn({
    script: [callResult("c1", "skills_read", { name: "lit-review" }), textResult("done")],
    importFor: AGENT.id,
  });
  try {
    // the stamped definition reached the model: the index is on the system
    const system = model.requests[0]?.system;
    expect(typeof system === "string" ? system : "").toContain(SKILL_INDEX_HEADER);

    // a read, gate none: no approval wait in mode ask
    expect(of(events, "human.requested")).toEqual([]);

    const calls = of(events, "tool.call");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.payload).toMatchObject({ callId: "c1", tool: "skills_read", effect: "read" });

    const completed = of(events, "tool.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]!.payload).toMatchObject({ callId: "c1", ok: true });
    const result: unknown = completed[0]!.payload.result;
    const body =
      typeof result === "object" && result !== null && "body" in result && typeof result.body === "string"
        ? result.body
        : undefined;
    expect(body).toBe(LIT_BODY);

    // the scripted reply ends the turn
    expect(of(events, "agent.message").length).toBeGreaterThanOrEqual(1);
  } finally {
    await cleanup();
  }
});

// -- N6 ------------------------------------------------------------------------

test("N6 skills_read for a skill only writer owns, in researcher's session: ok false, unknown skill", async () => {
  // the fixtures land for writer only: researcher's list stays empty, so the
  // definition stamps no index — and the session is researcher's
  const { events, cleanup } = await runTurn({
    script: [callResult("c1", "skills_read", { name: "lit-review" }), textResult("done")],
    importFor: "writer",
  });
  try {
    expect(of(events, "human.requested")).toEqual([]);

    const completed = of(events, "tool.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]!.payload).toMatchObject({ callId: "c1", ok: false });
    expect(String(completed[0]!.payload.error)).toContain("unknown skill");
  } finally {
    await cleanup();
  }
});
