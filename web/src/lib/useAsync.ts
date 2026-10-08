import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';

import { errorMessage } from './api';

export interface AsyncState<T> {
  data: T | null;
  error: unknown;
  errorText: string | null;
  loading: boolean;
  reload: () => void;
}

// Loads data and keeps the previous result while reloading (no flash back to a skeleton).
// Results of superseded requests are dropped.
export function useAsync<T>(load: () => Promise<T>, deps: DependencyList): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const requestId = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const id = ++requestId.current;
    setLoading(true);
    loadRef
      .current()
      .then((value) => {
        if (id !== requestId.current) return;
        setData(value);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (id !== requestId.current) return;
        setError(cause);
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false);
      });
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  return { data, error, errorText: error ? errorMessage(error) : null, loading, reload };
}
