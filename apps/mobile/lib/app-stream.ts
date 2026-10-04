// The React layer over lib/stream.ts (pure): one shared /api/stream connection for the whole app,
// plus the useAppEvents / useStreamStatus hooks. Everything here uses STATIC named imports —
// a dynamic `import("react-native")` compiles to a Metro async require that eagerly evaluates
// every export getter of react-native's index.js (metroImportAll), which constructs
// PushNotificationIOS's NativeEventEmitter and red-screens in Expo Go (found on-device, MOB-E).
import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { fetch as expoFetch } from "expo/fetch";
import type { AppEvent } from "@fabric/contracts";

import { apiBase } from "./api";
import { createAppStream, type AppStream, type FetchLike, type StreamStatus } from "./stream";

let shared: AppStream | undefined;

/** The app-wide stream: one connection shared by every subscriber (refcounted in createAppStream —
 * the first subscriber connects, the last one stops it). A suspended phone drops the socket without
 * an error; `reconnect()` is a no-op while live, so foregrounding just retries immediately. */
export function appStream(): AppStream {
  if (!shared) {
    shared = createAppStream(expoFetch as FetchLike, apiBase);
    AppState.addEventListener("change", (state) => {
      if (state === "active") shared?.reconnect();
    });
  }
  return shared;
}

/**
 * Subscribes to matching AppEvents from the shared connection. Both arguments may be fresh closures
 * every render — they are kept in a ref, like the web's revalidateRef pattern.
 */
export function useAppEvents(filter: (e: AppEvent) => boolean, cb: (e: AppEvent) => void): void {
  const handlers = useRef({ filter, cb });
  useEffect(() => {
    handlers.current = { filter, cb };
  }, [filter, cb]);
  useEffect(() => {
    const off = appStream().subscribe(
      (e) => handlers.current.filter(e),
      (e) => handlers.current.cb(e),
    );
    return off;
  }, []);
}

/** Live connection status, for the debug screen (app/debug.tsx). */
export function useStreamStatus(): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>({ state: "connecting", attempts: 0, lastEventAt: undefined, lastEvent: undefined });
  useEffect(() => appStream().onStatus(setStatus), []);
  return status;
}
