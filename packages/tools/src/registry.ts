// The registry (ANY-44 T1): one home for declared tools that serves both
// sides — the model, with JSON Schema declarations (zod v4's z.toJSONSchema),
// and the runtime, with a scope-bound ToolPort adapter. The port validates
// arguments against each tool's zod schema, hands execute the parsed values
// and never rejects: every failure is an { ok: false } result, because a tool
// failure is a result, not a job failure (RUNTIME §6).
import type { ModelTool, ToolDescriptor, ToolPort } from "@fabric/runtime";
import { z } from "zod";
import type { ToolDef, ToolScope } from "./define";

/** The policy-facing summary T2 reads: what the tool is, not how it runs. */
export type ToolMeta = {
  effect: ToolDef["effect"];
  gate: ToolDef["gate"];
  kind: ToolDef["kind"];
  step: ToolDef["step"];
};

export type ToolRegistry = {
  get(name: string): ToolDef | undefined;
  names(): string[];
  meta(name: string): ToolMeta | undefined;
  /** The model's declarations for the named tools, JSON Schema parameters. */
  modelTools(names: readonly string[]): ModelTool[];
  /** A run-scoped ToolPort bound to the caller's scope and allowed list. */
  toolPort(scope: ToolScope, allowed?: readonly string[]): ToolPort;
};

export function createRegistry(defs: readonly ToolDef[]): ToolRegistry {
  const byName = new Map<string, ToolDef>();
  for (const def of defs) {
    if (byName.has(def.name)) throw new Error(`duplicate tool name: ${def.name}`);
    byName.set(def.name, def);
  }

  return {
    get: (name) => byName.get(name),
    names: () => [...byName.keys()],
    meta(name) {
      const def = byName.get(name);
      return def === undefined
        ? undefined
        : { effect: def.effect, gate: def.gate, kind: def.kind, step: def.step };
    },
    modelTools(names) {
      return names.map((name) => {
        const def = byName.get(name);
        if (def === undefined) throw new Error(`unknown tool: ${name}`);
        return {
          name: def.name,
          description: def.description,
          parameters: z.toJSONSchema(def.parameters),
        };
      });
    },
    toolPort(scope, allowed) {
      const allowedNames = allowed === undefined ? undefined : new Set(allowed);
      const visible = (name: string): ToolDef | undefined => {
        const def = byName.get(name);
        if (def === undefined) return undefined;
        return allowedNames !== undefined && !allowedNames.has(name) ? undefined : def;
      };
      return {
        describe(name): ToolDescriptor | undefined {
          const def = visible(name);
          return def === undefined
            ? undefined
            : {
                name: def.name,
                effect: def.effect,
                description: def.description,
                parameters: z.toJSONSchema(def.parameters),
              };
        },
        async run(name, args, io) {
          const def = visible(name);
          if (def === undefined) return { ok: false, error: `unknown tool: ${name}` };

          const parsed = def.parameters.safeParse(args);
          if (!parsed.success) {
            return { ok: false, error: `invalid arguments: ${parsed.error.message}` };
          }

          try {
            const result = await def.execute(parsed.data, {
              scope,
              onLine: io.onLine ?? (() => {}),
            });
            return { ok: true, result };
          } catch (error) {
            return {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        },
      };
    },
  };
}
