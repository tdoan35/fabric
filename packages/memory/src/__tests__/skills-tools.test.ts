// ANY-76 M2 — the skills read tools through T1's registry port, on a PGlite
// store from M1 with fixture skills for `dana` and `researcher`. Both tools
// act as scope.agentId only, and every failure is an { ok: false } result.
// L11 is the seam: the registry port behind R9b's handleToolExecJob.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  append,
  handleToolExecJob,
  MemoryQueue,
  openStore,
  type EventInput,
  type RuntimeStore,
  type ToolPort,
} from "@fabric/runtime";
import { createRegistry } from "@fabric/tools";
import {
  ensureSkillsSchema,
  importSkills,
  parseSkillFolder,
  readSkillFolder,
  skillsStore,
  skillTools,
  type SkillsStore,
} from "../skills";

const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));
const WORKSPACE = "ws-m2";
const KB = 1024;

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A dana skill holding a 100 KB and a 101 KB text file. */
function bigFilesSkill() {
  return parseSkillFolder(
    new Map([
      [
        "SKILL.md",
        utf8("---\nname: big-files\ndescription: Holds two large reference files.\n---\n\n# Big files\n"),
      ],
      ["references/max.md", utf8("m".repeat(100 * KB))],
      ["references/big.md", utf8("b".repeat(101 * KB))],
    ]),
    "big-files"
  );
}

let store: RuntimeStore;
let skills: SkillsStore;

beforeEach(async () => {
  store = await openStore({ driver: "pglite" });
  await ensureSkillsSchema(store);
  skills = skillsStore(store, WORKSPACE);
  await importSkills(skills, path.join(FIXTURES, "skills"), { agentId: "dana" });
  await importSkills(skills, path.join(FIXTURES, "researcher-skills"), { agentId: "researcher" });
  await skills.write("dana", bigFilesSkill(), { origin: "test", source: "user" });
});

afterEach(async () => {
  await store.close();
});

const portFor = (agentId: string): ToolPort =>
  createRegistry(skillTools(skills)).toolPort({ workspaceId: WORKSPACE, streamId: `run:${agentId}`, agentId });

describe("skills tools (ANY-76 M2)", () => {
  test("L1 skills_list as dana returns only dana's skills, in name order", async () => {
    const result = await portFor("dana").run("skills_list", {}, {});
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({
      skills: [
        { name: "big-files", description: "Holds two large reference files." },
        {
          name: "pdf-report",
          description:
            "Build a one-page PDF report from a table of numbers. Use when the user asks for a printable summary.",
        },
        { name: "release-notes", description: "Draft release notes from merged pull requests, grouped by area." },
      ],
    });

    const researcher = await portFor("researcher").run("skills_list", {}, {});
    expect(researcher.result).toEqual({
      skills: [
        {
          name: "lit-review",
          description: "Survey the literature on a question and summarise the strongest sources.",
        },
      ],
    });
  });

  test("L2 query matches name or description case-insensitively; no match is an empty list", async () => {
    const port = portFor("dana");
    const names = async (query: string) => {
      const result = await port.run("skills_list", { query }, {});
      expect(result.ok).toBe(true);
      return (result.result as { skills: { name: string }[] }).skills.map((s) => s.name);
    };

    expect(await names("RELEASE")).toEqual(["release-notes"]); // name
    expect(await names("Printable")).toEqual(["pdf-report"]); // description only
    expect(await names("pdf")).toEqual(["pdf-report"]);
    expect(await names("-")).toEqual(["big-files", "pdf-report", "release-notes"]);
    // researcher's skill matches "literature", but dana can't see it.
    expect(await names("literature")).toEqual([]);
    expect((await port.run("skills_list", { query: "no-such-thing" }, {})).result).toEqual({ skills: [] });
  });

  test("L3 skills_read { name } returns the body without frontmatter, the latest version and the file list", async () => {
    const port = portFor("dana");
    const first = await port.run("skills_read", { name: "pdf-report" }, {});
    expect(first).toEqual({
      ok: true,
      result: {
        name: "pdf-report",
        version: 1,
        body: "# PDF report\n\nRead `references/guide.md` first, then put `assets/logo.png` in the header.\n",
        files: ["assets/logo.png", "references/guide.md"],
      },
    });

    // A patch makes version 2 the one the tool reads.
    const folder = await readSkillFolder(path.join(FIXTURES, "skills", "pdf-report"));
    const files = new Map(folder.files);
    files.set(
      "SKILL.md",
      utf8("---\nname: pdf-report\ndescription: Build a PDF report.\n---\n\n# PDF report v2\n")
    );
    await skills.write("dana", parseSkillFolder(files, "pdf-report"), { origin: "test", source: "user" });

    const latest = await port.run("skills_read", { name: "pdf-report" }, {});
    expect(latest.ok).toBe(true);
    expect(latest.result).toMatchObject({ name: "pdf-report", version: 2, body: "# PDF report v2\n" });
  });

  test("L4 skills_read with a path returns the text; bad paths, binary and oversized files are { ok: false }", async () => {
    const port = portFor("dana");
    const guide = await readFile(path.join(FIXTURES, "skills", "pdf-report", "references", "guide.md"), "utf8");
    expect(await port.run("skills_read", { name: "pdf-report", path: "references/guide.md" }, {})).toEqual({
      ok: true,
      result: { name: "pdf-report", version: 1, path: "references/guide.md", text: guide },
    });
    // A path that normalises inside the folder is fine.
    const normalised = await port.run("skills_read", { name: "pdf-report", path: "assets/../references/guide.md" }, {});
    expect(normalised.ok).toBe(true);
    expect((normalised.result as { text: string }).text).toBe(guide);

    for (const bad of ["../x", "a/../../x", "/etc/passwd"]) {
      expect(await port.run("skills_read", { name: "pdf-report", path: bad }, {})).toEqual({
        ok: false,
        error: `invalid path: ${bad}`,
      });
    }
    expect(await port.run("skills_read", { name: "pdf-report", path: "assets/logo.png" }, {})).toEqual({
      ok: false,
      error: "binary file: assets/logo.png",
    });
    expect(await port.run("skills_read", { name: "big-files", path: "references/big.md" }, {})).toEqual({
      ok: false,
      error: "file too large: references/big.md",
    });
    // Exactly 100 KB is not over the limit.
    const max = await port.run("skills_read", { name: "big-files", path: "references/max.md" }, {});
    expect(max.ok).toBe(true);
    expect((max.result as { text: string }).text).toHaveLength(100 * KB);
  });

  test("L5 an unknown name, or another agent's skill, is unknown skill", async () => {
    const port = portFor("dana");
    expect(await port.run("skills_read", { name: "no-such-skill" }, {})).toEqual({
      ok: false,
      error: "unknown skill: no-such-skill",
    });
    expect(await port.run("skills_read", { name: "lit-review" }, {})).toEqual({
      ok: false,
      error: "unknown skill: lit-review",
    });
    expect(await port.run("skills_read", { name: "lit-review", path: "SKILL.md" }, {})).toEqual({
      ok: false,
      error: "unknown skill: lit-review",
    });

    // The owner reads it.
    const own = await portFor("researcher").run("skills_read", { name: "lit-review" }, {});
    expect(own.ok).toBe(true);
    expect(own.result).toMatchObject({ name: "lit-review", version: 1 });
  });

  test("L6 the registry accepts both tools; meta is read / none / read / 0 for each", () => {
    const registry = createRegistry(skillTools(skills));
    expect(registry.names().sort()).toEqual(["skills_list", "skills_read"]);
    for (const name of ["skills_list", "skills_read"]) {
      expect(registry.meta(name)).toEqual({ effect: "read", gate: "none", kind: "read", step: 0 });
    }
    // The model sees JSON Schema for both.
    const declared = registry.modelTools(["skills_list", "skills_read"]);
    expect(declared.map((tool) => tool.name)).toEqual(["skills_list", "skills_read"]);
    expect(JSON.stringify(declared[1].parameters)).toContain('"name"');
  });
});

// -- L11: the seam with the runtime --------------------------------------------

const runCreated: EventInput = {
  type: "run.created",
  actor: "api",
  payload: {
    definition: { systemPrompt: "SYS", tools: ["skills_read"] },
    engineVersion: "v1",
    brief: "",
    grants: ["skills_read"],
    budgets: {},
    parent: null,
  },
};

test("L11 a registry port behind handleToolExecJob runs skills_read and tool.completed carries the body", async () => {
  const streamId = "run:m2-seam";
  await store.transaction((tx) =>
    append(tx, WORKSPACE, [
      {
        streamId,
        events: [
          runCreated,
          {
            type: "tool.call",
            actor: "decide",
            payload: { tool: "skills_read", summary: "load pdf-report", callId: "c1", args: { name: "pdf-report" } },
          },
        ],
      },
    ])
  );

  const queue = new MemoryQueue();
  await store.transaction((tx) =>
    queue.enqueue(tx, { type: "tool.exec", key: `${streamId}:c1`, streamId, workspaceId: WORKSPACE })
  );
  const lease = await queue.claim("worker-1", ["tool.exec"], 0);
  if (lease === null) throw new Error("expected a claimable tool.exec job");

  const tools = createRegistry(skillTools(skills)).toolPort({ workspaceId: WORKSPACE, streamId, agentId: "dana" });
  await handleToolExecJob(lease, { store, queue, tools, now: () => 0 });

  const events = await store.readStream(streamId, { workspaceId: WORKSPACE });
  const completed = events.filter((event) => event.type === "tool.completed");
  expect(completed).toHaveLength(1);
  expect(completed[0].payload).toMatchObject({
    callId: "c1",
    ok: true,
    result: {
      name: "pdf-report",
      version: 1,
      body: "# PDF report\n\nRead `references/guide.md` first, then put `assets/logo.png` in the header.\n",
    },
  });
});
