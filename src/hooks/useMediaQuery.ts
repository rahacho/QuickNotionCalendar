import { useCallback, useSyncExternalStore } from 'react';

function getMql(q: string): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(q) : null;
}

/** Live boolean for a CSS media query (e.g. "(pointer: fine)"). */
export function useMediaQuery(q: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = getMql(q);
      if (!mql) return () => {};
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    [q],
  );
  const get = useCallback(() => getMql(q)?.matches ?? false, [q]);
  return useSyncExternalStore(subscribe, get, () => false);
}
