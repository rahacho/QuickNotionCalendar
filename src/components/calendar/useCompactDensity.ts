import { useLayoutEffect, useState, type RefObject } from 'react';

/** Below this cell width the grid switches to Notion's compact (phone) density. */
export const COMPACT_CELL_W = 96;
/** Horizontal chrome around the 7 columns in regular density: 5px gutters + the grid's left line. */
const REGULAR_CHROME = 11;

function guess(): boolean {
  return typeof window !== 'undefined' && (window.innerWidth - REGULAR_CHROME) / 7 < COMPACT_CELL_W;
}

/**
 * True when a day column would be narrower than 96px. Measured on the scroll container (its
 * clientWidth doesn't depend on our own padding, so switching density can't oscillate).
 */
export function useCompactDensity(ref: RefObject<HTMLElement | null>): boolean {
  const [compact, setCompact] = useState(guess);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      if (w > 0) setCompact((w - REGULAR_CHROME) / 7 < COMPACT_CELL_W);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return compact;
}
