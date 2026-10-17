// The fixture hotkey's UI state (RUN-12). Scripted Dana retired with S14: the one-response
// chat path and its fixture flag are gone, so arming no longer changes any turn — nothing
// reads the flag anymore. Only the components' toggle/chip remain (they live outside this
// card's file scope); this module stays so they keep compiling, and a card that owns
// apps/web/src/components/chat can delete both together.
import { useSyncExternalStore } from "react";

let armed = false;
const listeners = new Set<() => void>();
const set = (next: boolean) => {
  if (armed === next) return;
  armed = next;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); };

export const toggleFixture = () => set(!armed);
export const disarmFixture = () => set(false);
export const useFixtureArmed = () => useSyncExternalStore(subscribe, () => armed);

export const isFixtureHotkey = (e: KeyboardEvent) => e.ctrlKey && e.shiftKey && !e.altKey && e.code === "KeyF";
