import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Loads data now and then again every `intervalMs`, and again whenever `deps` change. `reload`
 * fetches right away (after an action); a failed refresh keeps the last data and reports `error`.
 */
export function usePolling<T>(load: () => Promise<T>, intervalMs: number, deps: readonly unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const mounted = useRef(true);

  const reload = useCallback(async () => {
    try {
      const loaded = await loadRef.current();
      if (mounted.current) {
        setData(loaded);
        setError(null);
      }
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : 'Could not load data');
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void reload();
    const timer = setInterval(() => void reload(), intervalMs);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [reload, intervalMs, ...deps]);

  return { data, error, reload };
}
