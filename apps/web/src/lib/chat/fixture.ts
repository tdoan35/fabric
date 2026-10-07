// The fixture hotkey (RUN-12): Ctrl+Shift+F arms scripted Dana for the next turn — the request goes
// out with `fixture: true`, same stream, same side effects. The demo's fallback when a live
// proposal doesn't come. One flag for the page; the next turn consumes it.
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
/** Read by the http adapter as a turn starts: true once, then disarmed. */
export function takeFixture(): boolean {
  const was = armed;
  set(false);
  return was;
}
export const useFixtureArmed = () => useSyncExternalStore(subscribe, () => armed);

export const isFixtureHotkey = (e: KeyboardEvent) => e.ctrlKey && e.shiftKey && !e.altKey && e.code === "KeyF";
