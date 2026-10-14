// S5 (ANY-54) runtime bootstrap — RED stub. The real bootstrap lands in the
// green commit; this exists only so the B-cases bind to the module shape.
export const RUNTIME_WORKSPACE = "local";

export type RuntimeEnv = {
  RUNTIME_DATABASE_URL?: string;
  RUNTIME_PGLITE_DIR?: string;
  RUNTIME_CONCURRENCY?: number;
  MODEL_PORT?: "ai" | "test";
};

export type FabricRuntime = {
  stop: () => Promise<void>;
};

export async function startRuntime(_env: RuntimeEnv, _opts: { worker?: boolean } = {}): Promise<FabricRuntime> {
  throw new Error("startRuntime: not implemented (S5 red)");
}

let active: FabricRuntime | undefined;

export function setRuntime(runtime: FabricRuntime | undefined): void {
  active = runtime;
}

export function getRuntime(): FabricRuntime | undefined {
  return active;
}
