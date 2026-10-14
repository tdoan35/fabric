// ANY-75 M1 — the skills store on the runtime store, both drivers via
// @fabric/runtime/testing (PGlite always, Postgres when
// RUNTIME_TEST_DATABASE_URL is set — the CI leg). Versions are immutable,
// every create/patch lands with its `skill.written` on `agent:<id>` in one
// transaction, and a skill belongs to one agent.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import type { RuntimeStore, RuntimeTx } from "@fabric/runtime";
import { describeDrivers, postgresUrlFromEnv, type DriverHarness } from "@fabric/runtime/testing";
import {
  ensureSkillsSchema,
  parseSkillFolder,
  readSkillFolder,
  skillsStore,
  type SkillFolder,
} from "../skills";

const FIXTURES = fileURLToPath(new URL("./fixtures/skills", import.meta.url));
const WORKSPACE = "ws-skills";
const WRITE_OPTS = { origin: "import:pdf-report", source: "user" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const pdfReport = (): Promise<SkillFolder> => readSkillFolder(path.join(FIXTURES, "pdf-report"));

/** The pdf-report fixture with its body replaced. */
async function pdfReportWithBody(body: string): Promise<SkillFolder> {
  const folder = await pdfReport();
  const skillMd = new TextDecoder().decode(folder.files.get("SKILL.md"));
  const head = skillMd.slice(0, skillMd.indexOf("\n---\n") + "\n---\n".length);
  const files = new Map(folder.files);
  files.set("SKILL.md", new TextEncoder().encode(`${head}\n${body}`));
  return parseSkillFolder(files, "pdf-report");
}

async function rowCounts(store: RuntimeStore): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of ["skills", "skill_versions", "skill_content"]) {
    const rows = await store.transaction((tx) =>
      tx.query(`select count(*)::int as n from ${table} where workspace_id = $1`, [WORKSPACE])
    );
    counts[table] = Number(rows[0].n);
  }
  return counts;
}

/** A store whose transactions run the callback, then throw: the commit never happens. */
function failingAfterCallback(inner: RuntimeStore): RuntimeStore {
  return {
    transaction<T>(run: (tx: RuntimeTx) => Promise<T>): Promise<T> {
      return inner.transaction(async (tx) => {
        await run(tx);
        throw new Error("injected failure after the transaction callback");
      });
    },
    readStream: (streamId, options) => inner.readStream(streamId, options),
    close: () => inner.close(),
  };
}

// K14: every driver case records itself once its assertions pass; the K14 test
// below checks that K5–K11 completed on each configured driver.
const STORE_CASES = ["K5", "K6", "K7", "K8", "K9", "K10", "K11"] as const;
const completed = new Set<string>();

function driverCase(
  h: DriverHarness,
  id: (typeof STORE_CASES)[number],
  title: string,
  run: () => Promise<void>
): void {
  test(`${id} ${title}`, async () => {
    await run();
    completed.add(`${h.driver}:${id}`);
  });
}

describeDrivers("skills store (ANY-75 M1)", (h) => {
  async function ready(): Promise<RuntimeStore> {
    const store = await h.openStore();
    await ensureSkillsSchema(store);
    return store;
  }

  driverCase(h, "K5", "ensureSkillsSchema twice in a row is harmless", async () => {
    const store = await h.openStore();
    await ensureSkillsSchema(store);
    await ensureSkillsSchema(store);
    expect(await rowCounts(store)).toEqual({ skills: 0, skill_versions: 0, skill_content: 0 });
  });

  driverCase(h, "K6", "write of a new folder creates version 1 and appends one skill.written", async () => {
    const store = await ready();
    const skills = skillsStore(store, WORKSPACE);

    const result = await skills.write("dana", await pdfReport(), WRITE_OPTS);
    expect(result.op).toBe("create");
    expect(result.version).toBe(1);
    expect(result.skillId).toMatch(UUID);

    const events = await store.readStream("agent:dana", { workspaceId: WORKSPACE });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("skill.written");
    expect(events[0].actor).toBe("user");
    expect(events[0].payload).toEqual({
      skillId: result.skillId,
      version: 1,
      op: "create",
      contentRef: `skill:${result.skillId}:1`,
      scope: "agent",
      origin: "import:pdf-report",
      source: "user",
    });

    // SKILL.md is stored as one of the paths.
    expect(await rowCounts(store)).toEqual({ skills: 1, skill_versions: 1, skill_content: 3 });
  });

  driverCase(h, "K7", "writing the same content again is unchanged: no rows, no event", async () => {
    const store = await ready();
    const skills = skillsStore(store, WORKSPACE);
    const first = await skills.write("dana", await pdfReport(), WRITE_OPTS);
    const before = await rowCounts(store);

    const again = await skills.write("dana", await pdfReport(), { origin: "import:again", source: "user" });
    expect(again).toEqual({ skillId: first.skillId, version: 1, op: "unchanged" });

    expect(await rowCounts(store)).toEqual(before);
    expect(await store.readStream("agent:dana", { workspaceId: WORKSPACE })).toHaveLength(1);
  });

  driverCase(h, "K8", "a changed body patches to version 2; both versions stay readable", async () => {
    const store = await ready();
    const skills = skillsStore(store, WORKSPACE);
    const v1 = await pdfReport();
    const created = await skills.write("dana", v1, WRITE_OPTS);
    const patched = await skills.write("dana", await pdfReportWithBody("# PDF report v2\n"), WRITE_OPTS);

    expect(patched).toEqual({ skillId: created.skillId, version: 2, op: "patch" });

    const latest = await skills.read("dana", "pdf-report");
    expect(latest?.version).toBe(2);
    expect(latest?.body).toBe("# PDF report v2\n");
    expect(latest?.skillId).toBe(created.skillId);

    const first = await skills.read("dana", "pdf-report", { version: 1 });
    expect(first?.version).toBe(1);
    expect(first?.body).toBe(v1.body);
    // Version 1 is immutable: its stored SKILL.md is still the original bytes.
    const v1SkillMd = await skills.readFile("dana", "pdf-report", "SKILL.md", { version: 1 });
    expect(Buffer.from(v1SkillMd ?? []).equals(Buffer.from(v1.files.get("SKILL.md") ?? []))).toBe(true);
    expect(await skills.read("dana", "pdf-report", { version: 3 })).toBeUndefined();

    const versions = await skills.versions("dana", "pdf-report");
    expect(versions.map((v) => [v.version, v.contentRef])).toEqual([
      [1, `skill:${created.skillId}:1`],
      [2, `skill:${created.skillId}:2`],
    ]);
    for (const v of versions) expect(Number.isNaN(Date.parse(v.createdAt))).toBe(false);

    const summaries = await skills.list("dana");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      skillId: created.skillId,
      name: "pdf-report",
      description: v1.description,
      version: 2,
    });

    const events = await store.readStream("agent:dana", { workspaceId: WORKSPACE });
    expect(events.map((e) => (e.payload as { op: string; version: number }).op)).toEqual(["create", "patch"]);
    expect(events[1].payload).toMatchObject({ version: 2, contentRef: `skill:${created.skillId}:2` });
  });

  driverCase(h, "K9", "a transaction that throws after the callback leaves no rows and no event", async () => {
    const store = await ready();
    const skills = skillsStore(failingAfterCallback(store), WORKSPACE);

    await expect(skills.write("dana", await pdfReport(), WRITE_OPTS)).rejects.toThrow(/injected failure/);

    expect(await rowCounts(store)).toEqual({ skills: 0, skill_versions: 0, skill_content: 0 });
    expect(await store.readStream("agent:dana", { workspaceId: WORKSPACE })).toEqual([]);
  });

  driverCase(h, "K10", "a skill belongs to one agent: another agent sees nothing of it", async () => {
    const store = await ready();
    const skills = skillsStore(store, WORKSPACE);
    const dana = await skills.write("dana", await pdfReport(), WRITE_OPTS);

    expect(await skills.list("bob")).toEqual([]);
    expect(await skills.read("bob", "pdf-report")).toBeUndefined();
    expect(await skills.readFile("bob", "pdf-report", "references/guide.md")).toBeUndefined();
    expect(await skills.versions("bob", "pdf-report")).toEqual([]);

    const bob = await skills.write("bob", await pdfReport(), WRITE_OPTS);
    expect(bob.op).toBe("create");
    expect(bob.skillId).not.toBe(dana.skillId);
    expect((await skills.list("dana")).map((s) => s.skillId)).toEqual([dana.skillId]);
    expect((await skills.list("bob")).map((s) => s.skillId)).toEqual([bob.skillId]);

    // Another workspace sees nothing either.
    expect(await skillsStore(store, "ws-other").list("dana")).toEqual([]);
  });

  driverCase(h, "K11", "readFile returns exact bytes, text and binary; an unknown path is undefined", async () => {
    const store = await ready();
    const skills = skillsStore(store, WORKSPACE);
    await skills.write("dana", await pdfReport(), WRITE_OPTS);

    for (const rel of ["references/guide.md", "assets/logo.png"]) {
      const onDisk = await readFile(path.join(FIXTURES, "pdf-report", rel));
      const stored = await skills.readFile("dana", "pdf-report", rel);
      expect(stored).toBeInstanceOf(Uint8Array);
      expect(Buffer.from(stored ?? []).equals(onDisk)).toBe(true);
    }
    expect(await skills.readFile("dana", "pdf-report", "references/missing.md")).toBeUndefined();
    expect(await skills.readFile("dana", "no-such-skill", "references/guide.md")).toBeUndefined();

    const read = await skills.read("dana", "pdf-report");
    expect(read?.files).toEqual(["assets/logo.png", "references/guide.md"]);
  });
});

test("K14 K5–K11 ran on PGlite, and on Postgres when RUNTIME_TEST_DATABASE_URL is set", () => {
  const drivers = postgresUrlFromEnv() === undefined ? ["pglite"] : ["pglite", "postgres"];
  const expected = drivers.flatMap((driver) => STORE_CASES.map((id) => `${driver}:${id}`));
  expect([...completed].sort()).toEqual(expected.sort());
});
