/**
 * The whole of the dashboard's data layer.
 *
 * NO STATE LIBRARY, DELIBERATELY. Armada's console is single-operator on a trusted
 * network, REST is authoritative for every entity (Requirement 118), and no two surfaces
 * share mutable client state — a list page owns its list, a drawer owns its detail. There
 * is no cache to invalidate across tabs and no optimistic update anywhere, because
 * Requirement 104 forbids implying an undo window that does not exist. A cache library
 * would be solving problems this application does not have, and every one of its
 * invalidation rules would be a place for the list and the server to disagree.
 *
 * What IS needed is the three-state discipline of Requirement 13's inverse: an operator
 * must never see a degraded view rendered as a healthy one. So `useResource` never
 * collapses loading, error, and empty into one falsy branch — each is a distinct field and
 * callers are forced to handle them separately.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface Resource<T> {
  data: T | undefined;
  /** True only before the FIRST successful load. A refresh does not blank the view. */
  loading: boolean;
  error: Error | undefined;
  /** Re-runs the fetch. Used after every mutation — nothing is updated optimistically. */
  reload: () => void;
}

/**
 * Fetches once on mount and whenever `deps` change.
 *
 * The generation counter is not a nicety: an operator clicking three rows in the detail
 * drawer fires three fetches, and without it the slowest response wins and the drawer
 * shows a different entity from the selected row. Requirement 38c makes swapping the
 * drawer's contents the normal interaction, so this race is the common case, not the edge.
 */
export function useResource<T>(fetcher: () => Promise<T>, deps: unknown[]): Resource<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const generation = useRef(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    const mine = ++generation.current;
    let cancelled = false;

    fetcherRef
      .current()
      .then((value) => {
        // Two guards, not one. `cancelled` handles unmount; the generation check handles a
        // stale-but-still-mounted response, which is the drawer-swap race above.
        if (cancelled || mine !== generation.current) return;
        setData(value);
        setError(undefined);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled || mine !== generation.current) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, loading, error, reload };
}

/**
 * Runs a mutation and reports the three states a destructive action needs.
 *
 * Kept separate from `useResource` because a mutation is not a resource: it has no value
 * until invoked, it must surface the server's error BODY rather than a message (a 409 from
 * cancel carries the existing outcome, a 400 from save carries the whole error list), and
 * it must not re-run when its dependencies change.
 */
export function useAction<A extends unknown[], R>(
  action: (...args: A) => Promise<R>,
): {
  run: (...args: A) => Promise<R | undefined>;
  pending: boolean;
  error: unknown;
  clearError: () => void;
} {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const actionRef = useRef(action);
  actionRef.current = action;

  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    setPending(true);
    setError(undefined);
    try {
      return await actionRef.current(...args);
    } catch (err) {
      setError(err);
      return undefined;
    } finally {
      setPending(false);
    }
  }, []);

  return { run, pending, error, clearError: useCallback(() => setError(undefined), []) };
}
