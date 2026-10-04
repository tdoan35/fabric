import { useSyncExternalStore } from "react";
import type { ItemAction } from "@fabric/contracts";

/**
 * Local-only Weave decisions (MOBILE-PLAN §2): there is no server decision endpoint yet — the
 * same as the web today (apps/web/src/lib/weave-store.ts, module store + useSyncExternalStore).
 * Module-level state survives polling, navigation and remounts; a poll merges over it and never
 * clears it. Snooze/undo/pulse stay desktop-only in M0.
 */

/** What resolving left on the item: `effect.outcome` is the label it keeps once it's done. */
export interface Resolution {
  actionId: string;
  outcome: string;
  at: string;
}

export interface WeaveLocalState {
  resolved: Readonly<Record<string, Resolution | undefined>>;
  /** Items opened on this device — clears the unread dot (web: weave.markRead). */
  read: Readonly<Record<string, boolean>>;
}

let state: WeaveLocalState = { resolved: {}, read: {} };
const listeners = new Set<() => void>();

function set(patch: Partial<WeaveLocalState>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useWeaveLocal(): WeaveLocalState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

/** Records the chosen action: its `effect.outcome` becomes the item's label (web: weave.resolve). */
export function resolve(itemId: string, action: ItemAction) {
  if (state.resolved[itemId]) return;
  const outcome = action.effect?.outcome ?? action.label;
  set({
    resolved: { ...state.resolved, [itemId]: { actionId: action.id, outcome, at: new Date().toISOString() } },
  });
}

export function markRead(itemId: string) {
  if (!state.read[itemId]) set({ read: { ...state.read, [itemId]: true } });
}
