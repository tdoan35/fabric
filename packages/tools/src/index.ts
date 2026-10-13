// @fabric/tools — tool definitions, registry and the runtime ToolPort
// adapter (ANY-44 T1, ARCHITECTURE §9). Later tracks add areas as subpath
// exports (@fabric/tools/vault, /broker, /host, …) and never edit this file,
// so the parallel tracks' file scopes stay disjoint.
export {
  defineTool,
  type ToolDef,
  type ToolExecCtx,
  type ToolGate,
  type ToolKind,
  type ToolScope,
  type ToolStep,
} from "./define";
export { createRegistry, type ToolMeta, type ToolRegistry } from "./registry";
