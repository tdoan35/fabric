import { useCallback, useEffect, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";

export interface PollState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  /** Immediate re-fetch for pull-to-refresh; also un-busys a tick that overlapped a poll. */
  refresh: () => void;
}

/**
 * Focus-aware poll (MOBILE-PLAN §2): fetches immediately, then every `intervalMs` while the
 * screen is focused, and stops when it isn't. `refresh()` drives RefreshControl. Errors keep
 * the last `data` (a flaky venue network must not blank the screen) and clear on the next hit.
 */
export function usePoll<T>(fn: () => Promise<T>, intervalMs = 3000): PollState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  const busy = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const tick = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const value = await fnRef.current();
      if (!alive.current) return;
      setData(value);
      setError(undefined);
    } catch (err) {
      if (!alive.current) return;
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      busy.current = false;
      if (alive.current) setLoading(false);
    }
  }, []);

  const refresh = useCallback(() => {
    setLoading(true);
    void tick();
  }, [tick]);

  useFocusEffect(
    useCallback(() => {
      void tick();
      const timer = setInterval(() => void tick(), intervalMs);
      return () => clearInterval(timer);
    }, [tick, intervalMs]),
  );

  return { data, error, loading, refresh };
}
