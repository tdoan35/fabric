// The skills store's own DDL (ANY-75 M1), following the vault's
// ensureVaultSchema: idempotent, safe on every boot, and the runtime's
// migrations are untouched. Versions and their content are immutable rows;
// `skills` only tracks the latest version per (workspace, agent, name).
import type { RuntimeStore } from "@fabric/runtime";

const DDL = [
  `create table if not exists skills (
    workspace_id text not null,
    skill_id text not null,
    agent_id text not null,
    name text not null,
    latest_version integer not null,
    created_at timestamptz not null,
    updated_at timestamptz not null,
    primary key (workspace_id, skill_id),
    unique (workspace_id, agent_id, name)
  )`,
  `create table if not exists skill_versions (
    workspace_id text not null,
    skill_id text not null,
    version integer not null,
    content_ref text not null,
    content_hash text not null,
    description text not null,
    created_at timestamptz not null,
    primary key (workspace_id, skill_id, version)
  )`,
  `create table if not exists skill_content (
    workspace_id text not null,
    content_ref text not null,
    path text not null,
    bytes bytea not null,
    primary key (workspace_id, content_ref, path)
  )`,
];

/** The skills tables, idempotent; safe to call on every boot. */
export async function ensureSkillsSchema(store: RuntimeStore): Promise<void> {
  await store.transaction(async (tx) => {
    for (const statement of DDL) await tx.query(statement);
  });
}
