// Tool definitions (ANY-44 T1, ARCHITECTURE §9): the one shape every
// built-in tool declares — name, description, zod parameters, effect class
// (RUNTIME §6), approval gate, kind and the lowest execution step it needs
// (D1). The name rule ^[a-z][a-z0-9_]*$ is provider-safe, so the name is used
// verbatim as the model's tool name and in DecideDef.tools, with no key
// mapping.
import type { ToolEffect } from "@fabric/runtime";
import { z } from "zod";

/** The caller's opaque scope, handed through to execute untouched. */
export type ToolScope = {
  workspaceId: string;
  streamId: string;
  agentId: string;
  /** The run's working folder, when the caller has one. */
  runDir?: string;
};

/** `mode` follows the session's approval mode; `always` always asks a human. */
export type ToolGate = "none" | "mode" | "always";

/** What the tool touches; "Auto-approve edits" covers read and edit (D5). */
export type ToolKind = "read" | "edit" | "command" | "external";

/** The cheapest ladder step that can run the tool: the host, or 0–2 (ARCH §9). */
export type ToolStep = "host" | 0 | 1 | 2;

/** What execute receives: the caller's scope and a terminal-line stream. */
export type ToolExecCtx = {
  scope: ToolScope;
  onLine: (line: string) => void;
};

/** A declared tool. `execute` is method-typed so ToolDef<SomeSchema> stays
 * assignable to the erased ToolDef the registry stores (parameter
 * bivariance), giving execute its inferred argument type at define sites. */
export type ToolDef<A extends z.ZodType = z.ZodType> = {
  readonly name: string;
  readonly description: string;
  readonly parameters: A;
  readonly effect: ToolEffect;
  readonly gate: ToolGate;
  readonly kind: ToolKind;
  readonly step: ToolStep;
  execute(args: z.output<A>, ctx: ToolExecCtx): unknown | Promise<unknown>;
};

/** Tool names the model providers all accept, used verbatim. */
const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/** Declare one tool. The name is validated here, at define time, so a bad
 * name can never reach a registry or a model declaration. */
export function defineTool<A extends z.ZodType>(spec: {
  name: string;
  description: string;
  parameters: A;
  effect: ToolEffect;
  gate: ToolGate;
  kind: ToolKind;
  step: ToolStep;
  execute(args: z.output<A>, ctx: ToolExecCtx): unknown | Promise<unknown>;
}): ToolDef<A> {
  if (!NAME_PATTERN.test(spec.name)) {
    throw new Error(
      `invalid tool name ${JSON.stringify(spec.name)}: must match ^[a-z][a-z0-9_]*$`
    );
  }
  return Object.freeze({ ...spec });
}
