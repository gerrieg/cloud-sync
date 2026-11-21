import { useCallback, useState } from 'react';

/** Tracks the busy/error state of user-triggered async actions (one at a time per component). */
export function useAsyncAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (action: () => Promise<void>, fallbackMessage = 'Request failed') => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : fallbackMessage);
    } finally {
      setBusy(false);
    }
  }, []);

  const reset = useCallback(() => setError(null), []);

  return { busy, error, run, reset };
}
