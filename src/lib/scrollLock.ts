/**
 * Ref-counted background scroll lock. While any lock is held, <html> gets `data-scroll-locked`
 * (global.css freezes inner scroll panes that opt in and kills overscroll), and touchmove events
 * outside an allowed scroll container are cancelled so iOS can't rubber-band the page behind a sheet.
 */
let count = 0;
const allowed = new Set<HTMLElement>();

function isInsideAllowed(target: EventTarget | null): boolean {
  if (!(target instanceof Node)) return false;
  for (const el of allowed) if (el.contains(target)) return true;
  // Floating content (popovers/menus) portaled outside the locked overlay may scroll too.
  const el = target instanceof Element ? target : target.parentElement;
  return el?.closest('[data-scroll-lock-allow]') != null;
}

function onTouchMove(e: TouchEvent): void {
  if (e.touches.length > 1) return; // allow pinch handling elsewhere
  if (!isInsideAllowed(e.target) && e.cancelable) e.preventDefault();
}

/**
 * Locks background scrolling. `allow` is the overlay element whose own content may still scroll.
 * Returns the unlock function (idempotent).
 */
export function lockScroll(allow?: HTMLElement | null): () => void {
  if (typeof document === 'undefined') return () => {};
  if (allow) allowed.add(allow);
  if (count === 0) {
    document.documentElement.setAttribute('data-scroll-locked', '');
    document.addEventListener('touchmove', onTouchMove, { passive: false });
  }
  count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (allow) allowed.delete(allow);
    count = Math.max(0, count - 1);
    if (count === 0) {
      document.documentElement.removeAttribute('data-scroll-locked');
      document.removeEventListener('touchmove', onTouchMove);
    }
  };
}
