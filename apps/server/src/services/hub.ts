// In-process pub/sub hub feeding SSE (DATA). RunWriter's onEvent publishes run events (instant
// for same-process emits); AppEvents come from routes and services. Cross-process writes (sim)
// are picked up by each stream's DB poll — the hub only makes delivery faster.
import type { AppEvent, RunEvent } from "@fabric/contracts";

type RunListener = (e: RunEvent) => void;
type AppListener = (e: AppEvent) => void;

const runListeners = new Map<string, Set<RunListener>>();
const appListeners = new Set<AppListener>();

export const hub = {
  publishRun(e: RunEvent): void {
    for (const l of runListeners.get(e.runId) ?? []) l(e);
  },
  publishApp(ev: AppEvent): void {
    for (const l of appListeners) l(ev);
  },
  subscribeRun(runId: string, l: RunListener): () => void {
    const set = runListeners.get(runId) ?? new Set<RunListener>();
    set.add(l);
    runListeners.set(runId, set);
    return () => {
      set.delete(l);
      if (set.size === 0) runListeners.delete(runId);
    };
  },
  subscribeApp(l: AppListener): () => void {
    appListeners.add(l);
    return () => appListeners.delete(l);
  },
};
