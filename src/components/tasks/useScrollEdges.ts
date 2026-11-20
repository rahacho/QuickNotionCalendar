import { useEffect, useState, type RefObject } from 'react';

/**
 * Whether a scroll container has content hidden above (`scrolled`) or below (`moreBelow`). Used to show
 * Notion-style hairlines only where the list actually runs under a fixed header/footer.
 */
export function useScrollEdges(ref: RefObject<HTMLElement | null>): { scrolled: boolean; moreBelow: boolean } {
  const [edges, setEdges] = useState({ scrolled: false, moreBelow: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const scrolled = el.scrollTop > 0;
      const moreBelow = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
      setEdges((prev) => (prev.scrolled === scrolled && prev.moreBelow === moreBelow ? prev : { scrolled, moreBelow }));
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    el.addEventListener('scroll', schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    // Content height changes (rows added/removed/animating) don't resize the scroller itself.
    const mo = new MutationObserver(schedule);
    mo.observe(el, { childList: true, subtree: true });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      el.removeEventListener('scroll', schedule);
      ro.disconnect();
      mo.disconnect();
    };
  }, [ref]);
  return edges;
}
