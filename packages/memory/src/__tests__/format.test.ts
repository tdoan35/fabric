// ANY-75 M1 — the Agent Skills folder format (agentskills.io): SKILL.md with
// YAML frontmatter, the name/description rules, the file walk (dotfiles
// skipped, symlinks rejected) and the size limits. Every rejection is a
// SkillFormatError naming its rule and path.
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { parseSkillFolder, readSkillFolder, SkillFormatError } from "../skills";

const FIXTURES = fileURLToPath(new URL("./fixtures/skills", import.meta.url));
const MiB = 1024 * 1024;

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A folder holding only SKILL.md, with the given frontmatter lines and a short body. */
function skillMdOnly(frontmatter: string[], body = "# Body\n"): Map<string, Uint8Array> {
  return new Map([["SKILL.md", utf8(["---", ...frontmatter, "---", "", body].join("\n"))]]);
}

/** Runs a parse that must fail, returning its SkillFormatError. */
async function rejection(run: () => unknown): Promise<SkillFormatError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof SkillFormatError) return error;
    throw error;
  }
  throw new Error("expected a SkillFormatError, but the folder parsed");
}

async function expectRejected(
  run: () => unknown,
  rule: string,
  where: string
): Promise<SkillFormatError> {
  const error = await rejection(run);
  expect(error.rule).toBe(rule);
  expect(error.path).toBe(where);
  expect(error.message).toContain(rule);
  expect(error.message).toContain(where);
  return error;
}

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A copy of a fixture folder under a fresh temp root, keeping its folder name. */
async function fixtureCopy(name: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "memory-format-"));
  tmpDirs.push(root);
  const dir = path.join(root, name);
  await cp(path.join(FIXTURES, name), dir, { recursive: true });
  return dir;
}

describe("skills format (ANY-75 M1)", () => {
  test("K1 a valid fixture folder parses: name, description, body without frontmatter, and its files", async () => {
    const folder = await readSkillFolder(path.join(FIXTURES, "pdf-report"));

    expect(folder.name).toBe("pdf-report");
    expect(folder.description).toBe(
      "Build a one-page PDF report from a table of numbers. Use when the user asks for a printable summary."
    );
    expect(folder.body).toBe(
      "# PDF report\n\nRead `references/guide.md` first, then put `assets/logo.png` in the header.\n"
    );
    expect(folder.body).not.toContain("---");
    expect(folder.body).not.toContain("description:");

    expect([...folder.files.keys()].sort()).toEqual([
      "SKILL.md",
      "assets/logo.png",
      "references/guide.md",
    ]);
    const logo = await readFile(path.join(FIXTURES, "pdf-report", "assets", "logo.png"));
    expect(Buffer.from(folder.files.get("assets/logo.png") ?? []).equals(logo)).toBe(true);

    // parseSkillFolder over the same bytes gives the same result.
    const parsed = parseSkillFolder(folder.files, "pdf-report");
    expect(parsed.name).toBe(folder.name);
    expect(parsed.body).toBe(folder.body);
    expect(parsed.frontmatter).toEqual(folder.frontmatter);
  });

  test("K2 rejects a folder without SKILL.md", async () => {
    await expectRejected(
      () => parseSkillFolder(new Map([["references/guide.md", utf8("# guide\n")]]), "pdf-report"),
      "skill-md-required",
      "pdf-report/SKILL.md"
    );
    const root = await mkdtemp(path.join(tmpdir(), "memory-format-"));
    tmpDirs.push(root);
    await mkdir(path.join(root, "empty-skill"));
    await writeFile(path.join(root, "empty-skill", "notes.md"), "# notes\n");
    await expectRejected(
      () => readSkillFolder(path.join(root, "empty-skill")),
      "skill-md-required",
      "empty-skill/SKILL.md"
    );
  });

  test("K2 rejects SKILL.md without frontmatter, or with frontmatter that never closes", async () => {
    await expectRejected(
      () => parseSkillFolder(new Map([["SKILL.md", utf8("# Just a title\n\nNo frontmatter.\n")]]), "x"),
      "frontmatter-required",
      "x/SKILL.md"
    );
    await expectRejected(
      () => parseSkillFolder(new Map([["SKILL.md", utf8("---\nname: x\ndescription: d\n# body\n")]]), "x"),
      "frontmatter-required",
      "x/SKILL.md"
    );
  });

  test("K2 rejects names that break the pattern: Bad_Name, -lead, a--b", async () => {
    for (const name of ["Bad_Name", "-lead", "a--b", "trail-"]) {
      await expectRejected(
        () => parseSkillFolder(skillMdOnly([`name: "${name}"`, "description: d"]), name),
        "name-pattern",
        `${name}/SKILL.md`
      );
    }
  });

  test("K2 rejects a 65-character name and accepts 64", async () => {
    const long = "a".repeat(65);
    await expectRejected(
      () => parseSkillFolder(skillMdOnly([`name: ${long}`, "description: d"]), long),
      "name-length",
      `${long}/SKILL.md`
    );
    const max = "a".repeat(64);
    expect(parseSkillFolder(skillMdOnly([`name: ${max}`, "description: d"]), max).name).toBe(max);
  });

  test("K2 rejects a name that differs from the folder name", async () => {
    await expectRejected(
      () => parseSkillFolder(skillMdOnly(["name: pdf-report", "description: d"]), "pdf-reports"),
      "name-matches-folder",
      "pdf-reports/SKILL.md"
    );
  });

  test("K2 rejects an empty and a 1,025-character description, and accepts 1,024", async () => {
    await expectRejected(
      () => parseSkillFolder(skillMdOnly(["name: x", 'description: ""']), "x"),
      "description-length",
      "x/SKILL.md"
    );
    await expectRejected(
      () => parseSkillFolder(skillMdOnly(["name: x", `description: ${"d".repeat(1025)}`]), "x"),
      "description-length",
      "x/SKILL.md"
    );
    const max = "d".repeat(1024);
    expect(parseSkillFolder(skillMdOnly(["name: x", `description: ${max}`]), "x").description).toBe(max);
    await expectRejected(
      () => parseSkillFolder(skillMdOnly(["name: x"]), "x"),
      "description-required",
      "x/SKILL.md"
    );
  });

  test("K3 a symlink inside the folder is rejected, naming its path", async () => {
    const dir = await fixtureCopy("pdf-report");
    await symlink("guide.md", path.join(dir, "references", "link.md"));
    await expectRejected(
      () => readSkillFolder(dir),
      "no-symlinks",
      "pdf-report/references/link.md"
    );
  });

  test("K3 .git/ and .DS_Store are skipped", async () => {
    const dir = await fixtureCopy("pdf-report");
    await mkdir(path.join(dir, ".git", "objects"), { recursive: true });
    await writeFile(path.join(dir, ".git", "config"), "[core]\n");
    await writeFile(path.join(dir, ".git", "objects", "ab"), "blob");
    await writeFile(path.join(dir, ".DS_Store"), Buffer.from([0, 0, 0, 1]));
    await writeFile(path.join(dir, "references", ".DS_Store"), Buffer.from([0, 0, 0, 1]));

    const folder = await readSkillFolder(dir);
    expect([...folder.files.keys()].sort()).toEqual([
      "SKILL.md",
      "assets/logo.png",
      "references/guide.md",
    ]);

    // The same rule holds for a file map handed to parseSkillFolder.
    const files = new Map(folder.files);
    files.set(".DS_Store", new Uint8Array([0]));
    files.set(".git/config", utf8("[core]\n"));
    expect([...parseSkillFolder(files, "pdf-report").files.keys()].sort()).toEqual([
      "SKILL.md",
      "assets/logo.png",
      "references/guide.md",
    ]);
  });

  test("K3 201 files are rejected; 200 are accepted", async () => {
    const dir = await fixtureCopy("release-notes");
    await mkdir(path.join(dir, "refs"));
    for (let i = 0; i < 200; i += 1) {
      await writeFile(path.join(dir, "refs", `f${String(i).padStart(3, "0")}.md`), `# ${i}\n`);
    }
    await expectRejected(() => readSkillFolder(dir), "max-files", "release-notes");

    const files = skillMdOnly(["name: x", "description: d"]);
    for (let i = 0; i < 199; i += 1) files.set(`refs/f${i}.md`, utf8(`# ${i}\n`));
    expect(parseSkillFolder(files, "x").files.size).toBe(200);
    files.set("refs/one-more.md", utf8("# one more\n"));
    await expectRejected(() => parseSkillFolder(files, "x"), "max-files", "x");
  });

  test("K3 more than 5 MB in total is rejected; exactly 5 MB is accepted", async () => {
    const files = skillMdOnly(["name: x", "description: d"]);
    const skillMdBytes = files.get("SKILL.md")?.length ?? 0;
    files.set("assets/big.bin", new Uint8Array(5 * MiB - skillMdBytes));
    expect(parseSkillFolder(files, "x").files.size).toBe(2);

    files.set("assets/big.bin", new Uint8Array(5 * MiB - skillMdBytes + 1));
    await expectRejected(() => parseSkillFolder(files, "x"), "max-bytes", "x");

    const dir = await fixtureCopy("release-notes");
    await writeFile(path.join(dir, "big.bin"), new Uint8Array(5 * MiB + 1));
    await expectRejected(() => readSkillFolder(dir), "max-bytes", "release-notes");
  });

  test("K4 unknown frontmatter keys are kept, and the optional fields are kept", async () => {
    const folder = await readSkillFolder(path.join(FIXTURES, "pdf-report"));
    expect(folder.frontmatter).toEqual({
      name: "pdf-report",
      description:
        "Build a one-page PDF report from a table of numbers. Use when the user asks for a printable summary.",
      license: "MIT",
      compatibility: "Needs python3 with reportlab installed.",
      "allowed-tools": "Bash Read",
      metadata: { author: "fabric", version: "1.0" },
      "x-team": "research",
    });

    const parsed = parseSkillFolder(
      skillMdOnly(["name: x", "description: d", "tags: [alpha, beta]", "owner:", "  team: lab"]),
      "x"
    );
    expect(parsed.frontmatter.tags).toEqual(["alpha", "beta"]);
    expect(parsed.frontmatter.owner).toEqual({ team: "lab" });
  });

  test("K4 a metadata value that isn't a string map is rejected", async () => {
    await expectRejected(
      () => parseSkillFolder(skillMdOnly(["name: x", "description: d", "metadata:", "  count: 3"]), "x"),
      "metadata-string-map",
      "x/SKILL.md"
    );
    await expectRejected(
      () => parseSkillFolder(skillMdOnly(["name: x", "description: d", "metadata: [a, b]"]), "x"),
      "metadata-string-map",
      "x/SKILL.md"
    );
    await expectRejected(
      () => parseSkillFolder(skillMdOnly(["name: x", "description: d", "metadata: plain"]), "x"),
      "metadata-string-map",
      "x/SKILL.md"
    );
  });

  test("K4 compatibility over 500 characters is rejected", async () => {
    await expectRejected(
      () =>
        parseSkillFolder(
          skillMdOnly(["name: x", "description: d", `compatibility: ${"c".repeat(501)}`]),
          "x"
        ),
      "compatibility-length",
      "x/SKILL.md"
    );
    const ok = parseSkillFolder(
      skillMdOnly(["name: x", "description: d", `compatibility: ${"c".repeat(500)}`]),
      "x"
    );
    expect(ok.frontmatter.compatibility).toBe("c".repeat(500));
  });
});
