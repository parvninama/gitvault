import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

export interface AsyncState<T> {
  status: 'loading' | 'success' | 'error';
  data?: T;
  error?: string;
  reload: () => void;
}

/** One consistent loading / success / error model for every page. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [state, setState] = useState<{ status: 'loading' | 'success' | 'error'; data?: T; error?: string }>({ status: 'loading' });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, status: 'loading', error: undefined }));
    fn().then(
      (data) => alive && setState({ status: 'success', data }),
      (e: Error) => alive && setState({ status: 'error', error: e.message }),
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

export function Async<T>({ state, children }: { state: AsyncState<T>; children: (data: T) => ReactNode }) {
  if (state.status === 'error') {
    return <div className="error" role="alert">Error: {state.error} <button onClick={state.reload}>Retry</button></div>;
  }
  if (state.data === undefined) return <div className="muted" aria-busy="true">Loading…</div>;
  return <>{state.status === 'loading' && <div className="muted">Refreshing…</div>}{children(state.data)}</>;
}

export function Tag({ kind, children, title }: { kind: 'estimate' | 'measured' | 'inferred' | 'warn' | 'ok' | 'muted'; children: ReactNode; title?: string }) {
  return <span className={`tag tag-${kind}`} title={title}>{children}</span>;
}
