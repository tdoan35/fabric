// The toolset (ANY-81 T14): the pure layer between an agent's registry row and
// the session definition. The row is the definition layer (D5): its names —
// legacy (`agents.tools` display rows) or new (tool names, used verbatim) —
// expand through LEGACY_TOOL_MAP, intersect with the registry's available
// tools in `definitionAccess`, and the survivors are appended to the definition
// by `withToolset` in registry order, metas and all. Pure: the same row, the
// same registry, the same definition — a re-stamp cannot fork a turn's shape.
import { effectiveAccess } from "@fabric/core/policy";
import type { ToolRegistry } from "@fabric/tools";

/** The access a row declares; `blocked` loses to nothing, wins over all. */
export type ToolAccessLevel = "allowed" | "approval" | "blocked";

/** Legacy registry-row name -> the session tools it maps to. Rows whose name
 * is itself a tool name (the new style) map to themselves and are not here.
 * The other legacy names (`artifacts.*`, `team.assign`, `browser.task`,
 * `recall`) keep their own paths or wait for their epics. */
export const LEGACY_TOOL_MAP: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "exa.search": ["web_search"],
  "network.fetch": ["web_fetch"],
  "agentmail.send": ["send"],
  "sprite.exec": ["shell", "read_file", "write_file", "edit_file", "search_files"],
  "workspace.write": ["write_file", "edit_file"],
});

const STRICTNESS: Record<ToolAccessLevel, number> = { allowed: 0, approval: 1, blocked: 2 };

/** The strictest of two declared accesses: blocked > approval > allowed. */
function strictest(a: ToolAccessLevel | undefined, b: ToolAccessLevel): ToolAccessLevel {
  if (a === undefined) return b;
  return STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}

/**
 * The definition layer's access map: each row expands through the map (or
 * names itself, when the row is already a tool name), names outside
 * `available` are dropped — unknown names, display-only rows, `send` when it
 * is not registered — several rows reaching one tool resolve strictest-wins,
 * and `defaults` fills only the tools no row mentions.
 */
export function definitionAccess(
  rows: readonly { name: string; policy: ToolAccessLevel }[],
  available: ReadonlySet<string>,
  defaults?: Readonly<Record<string, ToolAccessLevel>>,
): Record<string, ToolAccessLevel> {
  const access: Record<string, ToolAccessLevel> = {};
  for (const row of rows) {
    const names = available.has(row.name) ? [row.name] : (LEGACY_TOOL_MAP[row.name] ?? []);
    for (const name of names) {
      if (!available.has(name)) continue;
      access[name] = strictest(access[name], row.policy);
    }
  }
  if (defaults !== undefined) {
    for (const [name, level] of Object.entries(defaults)) {
      if (!(name in access) && available.has(name)) access[name] = level;
    }
  }
  return access;
}

/** The definition shape withToolset appends to: the session definitions plus
 * the bare DecideDef the placeholder stamp carries. */
type ToolsetDef = {
  tools: readonly string[];
  toolSchemas?: unknown[];
  toolEffects?: Record<string, unknown>;
  toolPolicy?: Record<string, unknown>;
};

/**
 * Append the surviving tools to the definition: `effectiveAccess` over the
 * definition layer (no workspace layer yet, no grants), the survivors in
 * registry order — names into `tools`, `modelTools` into `toolSchemas`, each
 * `meta.effect` into `toolEffects` and `{ access, gate, kind }` into
 * `toolPolicy`. A blocked tool appears in none of the four. A survivor the
 * definition already carries (a session tool such as `recall`) keeps its own
 * slot — the base's entry wins, as with the bridges; the name is not appended
 * twice. An access that survives nothing but already-carried names throws,
 * naming the first: the row maps to no new tool, which is a stamping mistake.
 * No survivor at all: the definition returns untouched, so every stamp without
 * mapped rows is unchanged.
 */
export function withToolset<D extends ToolsetDef>(
  def: D,
  deps: { registry: ToolRegistry; access: Record<string, ToolAccessLevel> },
): D {
  const effective = effectiveAccess({ definition: deps.access });
  const carried = new Set(def.tools as readonly string[]);
  const surviving = deps.registry.names().filter((name) => effective[name] !== undefined);
  const fresh = surviving.filter((name) => !carried.has(name));
  if (fresh.length === 0 && surviving.length > 0) {
    throw new Error(`tool already in the definition: ${surviving[0]}`);
  }
  if (fresh.length === 0) return def;

  const next = {
    ...def,
    tools: [...(def.tools as readonly string[]), ...fresh],
    toolSchemas: [...(def.toolSchemas ?? []), ...deps.registry.modelTools(fresh)],
    toolEffects: { ...(def.toolEffects ?? {}) },
    toolPolicy: { ...(def.toolPolicy ?? {}) },
  } as D;

  for (const name of fresh) {
    const meta = deps.registry.meta(name);
    if (meta === undefined) continue; // unreachable: surviving names are registry names
    (next.toolEffects as Record<string, unknown>)[name] = meta.effect;
    (next.toolPolicy as Record<string, unknown>)[name] = {
      access: effective[name],
      gate: meta.gate,
      kind: meta.kind,
    };
  }
  return next;
}
