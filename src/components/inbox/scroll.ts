/** Bring a freshly added bubble (always inserted at the top) into view. */
export function scrollToTop(el: HTMLElement | null): void {
  if (!el || el.scrollTop <= 0) return;
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
}
