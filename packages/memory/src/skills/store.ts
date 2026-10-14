// The skills store (ANY-75 M1; LEARNING §5.1, §10.4) on the runtime store,
// scoped to one workspace. A skill belongs to one agent; its versions are
// immutable, addressed by `skill:<skillId>:<version>`, and every create or
// patch lands in one transaction with its `skill.written` on `agent:<id>`.
// Read and load only: states, strength, search and erasure come with ANY-47.
import { createHash, randomUUID } from "node:crypto";
import { streamId } from "@fabric/core";
import { append, type RuntimeStore, type RuntimeTx } from "@fabric/runtime";
import { SKILL_MD, splitFrontmatter, type SkillFolder } from "./format";

export interface SkillWriteOptions {
  /** Where the content came from, e.g. `import:<folder name>`. */
  origin: string;
  /** Who it came from: `user` for imports. */
  source: string;
}

export interface SkillWriteResult {
  skillId: string;
  version: number;
  op: "create" | "patch" | "unchanged";
}

export interface SkillSummary {
  skillId: string;
  name: string;
  description: string;
  version: number;
  /** ISO timestamp of the latest version. */
  updatedAt: string;
}

export interface SkillRead {
  skillId: string;
  name: string;
  description: string;
  version: number;
  /** SKILL.md without its frontmatter. */
  body: string;
  /** Every stored path other than SKILL.md, sorted. */
  files: string[];
}

export interface SkillVersion {
  version: number;
  contentRef: string;
  /** ISO timestamp. */
  createdAt: string;
}

export interface SkillsStore {
  write(agentId: string, folder: SkillFolder, options: SkillWriteOptions): Promise<SkillWriteResult>;
  list(agentId: string): Promise<SkillSummary[]>;
  read(agentId: string, name: string, options?: { version?: number }): Promise<SkillRead | undefined>;
  readFile(
    agentId: string,
    name: string,
    path: string,
    options?: { version?: number }
  ): Promise<Uint8Array | undefined>;
  versions(agentId: string, name: string): Promise<SkillVersion[]>;
}

export const contentRefOf = (skillId: string, version: number): string => `skill:${skillId}:${version}`;

/** sha256 over every path and its bytes in path order, each length-prefixed. */
export function skillContentHash(files: ReadonlyMap<string, Uint8Array>): string {
  const hash = createHash("sha256");
  const length = Buffer.alloc(8);
  for (const rel of [...files.keys()].sort()) {
    const name = Buffer.from(rel, "utf8");
    const bytes = files.get(rel) as Uint8Array;
    length.writeBigUInt64BE(BigInt(name.length));
    hash.update(length).update(name);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    hash.update(length).update(bytes);
  }
  return hash.digest("hex");
}

// -- driver row narrowing -----------------------------------------------------
// pg and PGlite hand back `unknown` columns; these check what they read.

function textOf(value: unknown, column: string): string {
  if (typeof value !== "string") throw new Error(`skills: ${column}: expected text, got ${typeof value}`);
  return value;
}

function intOf(value: unknown, column: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`skills: ${column}: expected integer, got ${typeof value}`);
  }
  return value;
}

function isoOf(value: unknown, column: string): string {
  if (!(value instanceof Date)) throw new Error(`skills: ${column}: expected timestamptz, got ${typeof value}`);
  return value.toISOString();
}

function bytesOf(value: unknown, column: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error(`skills: ${column}: expected bytea, got ${typeof value}`);
  // A plain copy: pg hands back a Buffer over a shared pool.
  return new Uint8Array(value);
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A skills store over the runtime store, scoped to one workspace. Call
 * `ensureSkillsSchema` first; the store never runs DDL per operation. */
export function skillsStore(store: RuntimeStore, workspaceId: string): SkillsStore {
  /** The skill's id and the version a read targets: the latest unless pinned. */
  async function locate(
    tx: RuntimeTx,
    agentId: string,
    name: string,
    version: number | undefined
  ): Promise<{ skillId: string; version: number; contentRef: string; description: string } | undefined> {
    if (version !== undefined && (!Number.isInteger(version) || version < 1)) return undefined;
    const rows = await tx.query(
      `select s.skill_id, v.version, v.content_ref, v.description
         from skills s
         join skill_versions v
           on v.workspace_id = s.workspace_id
          and v.skill_id = s.skill_id
          and v.version = coalesce($4::integer, s.latest_version)
        where s.workspace_id = $1 and s.agent_id = $2 and s.name = $3`,
      [workspaceId, agentId, name, version ?? null]
    );
    if (rows.length === 0) return undefined;
    return {
      skillId: textOf(rows[0].skill_id, "skill_id"),
      version: intOf(rows[0].version, "version"),
      contentRef: textOf(rows[0].content_ref, "content_ref"),
      description: textOf(rows[0].description, "description"),
    };
  }

  async function contentFile(tx: RuntimeTx, contentRef: string, rel: string): Promise<Uint8Array | undefined> {
    const rows = await tx.query(
      "select bytes from skill_content where workspace_id = $1 and content_ref = $2 and path = $3",
      [workspaceId, contentRef, rel]
    );
    return rows.length === 0 ? undefined : bytesOf(rows[0].bytes, "bytes");
  }

  return {
    async write(agentId, folder, { origin, source }) {
      const contentHash = skillContentHash(folder.files);
      return store.transaction(async (tx) => {
        const now = new Date().toISOString();
        // Claim the name; a concurrent create of the same name falls through to the lock.
        const inserted = await tx.query(
          `insert into skills (workspace_id, skill_id, agent_id, name, latest_version, created_at, updated_at)
           values ($1, $2, $3, $4, 1, $5, $5)
           on conflict (workspace_id, agent_id, name) do nothing
           returning skill_id`,
          [workspaceId, randomUUID(), agentId, folder.name, now]
        );

        let skillId: string;
        let version: number;
        let op: "create" | "patch";
        if (inserted.length === 1) {
          skillId = textOf(inserted[0].skill_id, "skill_id");
          version = 1;
          op = "create";
        } else {
          const [current] = await tx.query(
            `select s.skill_id, s.latest_version, v.content_hash
               from skills s
               join skill_versions v
                 on v.workspace_id = s.workspace_id
                and v.skill_id = s.skill_id
                and v.version = s.latest_version
              where s.workspace_id = $1 and s.agent_id = $2 and s.name = $3
              for update of s`,
            [workspaceId, agentId, folder.name]
          );
          skillId = textOf(current.skill_id, "skill_id");
          const latest = intOf(current.latest_version, "latest_version");
          if (textOf(current.content_hash, "content_hash") === contentHash) {
            return { skillId, version: latest, op: "unchanged" as const };
          }
          version = latest + 1;
          op = "patch";
          await tx.query(
            `update skills set latest_version = $3, updated_at = $4
              where workspace_id = $1 and skill_id = $2`,
            [workspaceId, skillId, version, now]
          );
        }

        const contentRef = contentRefOf(skillId, version);
        await tx.query(
          `insert into skill_versions
             (workspace_id, skill_id, version, content_ref, content_hash, description, created_at)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [workspaceId, skillId, version, contentRef, contentHash, folder.description, now]
        );
        for (const [rel, bytes] of folder.files) {
          await tx.query(
            "insert into skill_content (workspace_id, content_ref, path, bytes) values ($1, $2, $3, $4)",
            [workspaceId, contentRef, rel, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)]
          );
        }
        await append(tx, workspaceId, [
          {
            streamId: streamId.agent(agentId),
            events: [
              {
                type: "skill.written",
                actor: "user",
                payload: { skillId, version, op, contentRef, scope: "agent", origin, source },
              },
            ],
          },
        ]);
        return { skillId, version, op };
      });
    },

    async list(agentId) {
      const rows = await store.transaction((tx) =>
        tx.query(
          `select s.skill_id, s.name, v.description, s.latest_version, s.updated_at
             from skills s
             join skill_versions v
               on v.workspace_id = s.workspace_id
              and v.skill_id = s.skill_id
              and v.version = s.latest_version
            where s.workspace_id = $1 and s.agent_id = $2`,
          [workspaceId, agentId]
        )
      );
      return rows
        .map((row) => ({
          skillId: textOf(row.skill_id, "skill_id"),
          name: textOf(row.name, "name"),
          description: textOf(row.description, "description"),
          version: intOf(row.latest_version, "latest_version"),
          updatedAt: isoOf(row.updated_at, "updated_at"),
        }))
        .sort((a, b) => byText(a.name, b.name));
    },

    async read(agentId, name, options = {}) {
      return store.transaction(async (tx) => {
        const found = await locate(tx, agentId, name, options.version);
        if (found === undefined) return undefined;
        const skillMd = await contentFile(tx, found.contentRef, SKILL_MD);
        const paths = await tx.query(
          "select path from skill_content where workspace_id = $1 and content_ref = $2 and path <> $3",
          [workspaceId, found.contentRef, SKILL_MD]
        );
        const split = skillMd === undefined ? undefined : splitFrontmatter(new TextDecoder().decode(skillMd));
        return {
          skillId: found.skillId,
          name,
          description: found.description,
          version: found.version,
          body: split?.body ?? "",
          files: paths.map((row) => textOf(row.path, "path")).sort(byText),
        };
      });
    },

    async readFile(agentId, name, rel, options = {}) {
      return store.transaction(async (tx) => {
        const found = await locate(tx, agentId, name, options.version);
        return found === undefined ? undefined : contentFile(tx, found.contentRef, rel);
      });
    },

    async versions(agentId, name) {
      const rows = await store.transaction((tx) =>
        tx.query(
          `select v.version, v.content_ref, v.created_at
             from skills s
             join skill_versions v on v.workspace_id = s.workspace_id and v.skill_id = s.skill_id
            where s.workspace_id = $1 and s.agent_id = $2 and s.name = $3
            order by v.version`,
          [workspaceId, agentId, name]
        )
      );
      return rows.map((row) => ({
        version: intOf(row.version, "version"),
        contentRef: textOf(row.content_ref, "content_ref"),
        createdAt: isoOf(row.created_at, "created_at"),
      }));
    },
  };
}
