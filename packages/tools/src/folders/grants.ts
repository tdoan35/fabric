// Folder grants (ANY-44 D2, T10): which agent may touch which project folder,
// in the workspace-scoped `folder_grants` table. The table is this package's
// own DDL — the runtime's migrations are untouched (the vault's
// ensureVaultSchema pattern). The local-disk folder itself is always the
// agent's to write; grants govern the shared project folders, and mountsFor
// turns a grant set into the ref list a session mounts.
import type { RuntimeStore } from "@fabric/runtime";
import type { FolderRef } from "./folders";

/** Read or write; write implies read. */
export type FolderAccess = "read" | "write";

/** One grant row, minus the workspace and bookkeeping columns. */
export interface FolderGrant {
  project: string;
  access: FolderAccess;
}

/** A mount point: the folder plus the access it is mounted with. */
export interface FolderMount {
  ref: FolderRef;
  access: FolderAccess;
}

/** The grants port, scoped to one workspace. */
export interface FolderGrants {
  /** Grants the agent access to a project folder; granting again changes the access. */
  grant(project: string, agentId: string, access?: FolderAccess): Promise<void>;

  /** Removes the grant, if any. */
  revoke(project: string, agentId: string): Promise<void>;

  /** The agent's project grants, in name order. */
  grantsFor(agentId: string): Promise<FolderGrant[]>;

  /** The agents granted a project, in name order. */
  agentsFor(project: string): Promise<string[]>;

  /** The agent's own folder (`write`) first, then its projects in name order. */
  mountsFor(agentId: string): Promise<FolderMount[]>;

  /** Drops every grant for the project. The caller removes the directory. */
  removeProject(project: string): Promise<void>;
}

function accessOf(value: unknown, context: string): FolderAccess {
  if (value === "read" || value === "write") return value;
  throw new Error(`folder_grants.${context}: expected "read" or "write", got ${String(value)}`);
}

/** The grants schema, idempotent; safe to call on every boot. */
export async function ensureFoldersSchema(store: RuntimeStore): Promise<void> {
  await store.transaction((tx) =>
    tx.query(`create table if not exists folder_grants (
      workspace_id text not null,
      project text not null,
      agent_id text not null,
      access text not null,
      granted_at timestamptz not null,
      primary key (workspace_id, project, agent_id)
    )`)
  );
}

/** Folder grants over `folder_grants`, scoped to one workspace. Call
 * `ensureFoldersSchema` first; grants never run DDL per operation. */
export function folderGrants(store: RuntimeStore, workspaceId: string): FolderGrants {
  return {
    async grant(project, agentId, access = "read") {
      if (access !== "read" && access !== "write") {
        throw new Error(`folder grant: access must be "read" or "write", got ${String(access)}`);
      }
      await store.transaction((tx) =>
        tx.query(
          `insert into folder_grants (workspace_id, project, agent_id, access, granted_at)
           values ($1, $2, $3, $4, $5)
           on conflict (workspace_id, project, agent_id) do update set
             access = excluded.access,
             granted_at = excluded.granted_at`,
          [workspaceId, project, agentId, access, new Date()]
        )
      );
    },

    async revoke(project, agentId) {
      await store.transaction((tx) =>
        tx.query(`delete from folder_grants where workspace_id = $1 and project = $2 and agent_id = $3`, [
          workspaceId,
          project,
          agentId,
        ])
      );
    },

    async grantsFor(agentId) {
      const rows = await store.transaction((tx) =>
        tx.query(
          `select project, access from folder_grants
           where workspace_id = $1 and agent_id = $2 order by project`,
          [workspaceId, agentId]
        )
      );
      return rows.map((row: Record<string, unknown>) => ({
        project: row.project as string,
        access: accessOf(row.access, "access"),
      }));
    },

    async agentsFor(project) {
      const rows = await store.transaction((tx) =>
        tx.query(
          `select agent_id from folder_grants
           where workspace_id = $1 and project = $2 order by agent_id`,
          [workspaceId, project]
        )
      );
      return rows.map((row: Record<string, unknown>) => row.agent_id as string);
    },

    async mountsFor(agentId) {
      const grants = await this.grantsFor(agentId);
      const mounts: FolderMount[] = [
        { ref: { kind: "agent", name: agentId }, access: "write" },
        ...grants.map((grant): FolderMount => ({
          ref: { kind: "project", name: grant.project },
          access: grant.access,
        })),
      ];
      return mounts;
    },

    async removeProject(project) {
      await store.transaction((tx) =>
        tx.query(`delete from folder_grants where workspace_id = $1 and project = $2`, [
          workspaceId,
          project,
        ])
      );
    },
  };
}
