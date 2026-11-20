/**
 * Edge auto-scroll for the calendar scroller (month scroller / week view). Runs from the drag (and
 * resize) frame loop using the live pointer, so it works whatever the drag started from: a calendar
 * card, an Inbox bubble or a Tasks list row. dnd-kit's own auto-scroller is told to leave these
 * elements alone.
 */

export interface ScrollerOptions {
  /** Pixels at the top covered by sticky content (the weekday header); the zone starts below it. */
  insetTop?: number;
}

interface ScrollerEntry {
  el: HTMLElement;
  opts: ScrollerOptions;
  seq: number;
}

const scrollers = new Map<HTMLElement, ScrollerEntry>();
let seq = 0;

/** Registers a calendar scroll container; returns the unregister function. */
export function registerCalendarScroller(el: HTMLElement, opts: ScrollerOptions = {}): () => void {
  scrollers.set(el, { el, opts, seq: ++seq });
  return () => {
    if (scrollers.get(el)?.el === el) scrollers.delete(el);
  };
}

export function isCalendarScroller(el: Element): boolean {
  return scrollers.has(el as HTMLElement);
}

/** The live, visible calendar scroller (the newest one when a view crossfade briefly mounts two). */
export function activeCalendarScroller(): { el: HTMLElement; insetTop: number } | null {
  let best: ScrollerEntry | null = null;
  for (const s of scrollers.values()) {
    if (!s.el.isConnected || s.el.closest('[inert]')) continue;
    if (!best || s.seq > best.seq) best = s;
  }
  return best ? { el: best.el, insetTop: best.opts.insetTop ?? 0 } : null;
}

const ZONE = 64;
/** Sub-pixel remainder carried between frames (browsers may round scrollTop). */
let carry = 0;
/**
 * An edge zone only scrolls once the pointer has been outside it during this gesture: a drag that
 * STARTS in a zone (phone: a Tasks-list row near the top once the drawer slides away, a bubble low in
 * the Inbox sheet) must not send the calendar flying before the finger has moved anywhere.
 */
let armed = { top: false, bottom: false };

/** Call at the start of every drag / resize gesture. */
export function resetAutoScroll(): void {
  armed = { top: false, bottom: false };
  carry = 0;
}

/** px per second at the very edge. */
const MAX_SPEED = 1500;
const MIN_SPEED = 90;

/**
 * Scrolls the calendar when the pointer is within 64px of its top/bottom edge (speed grows with
 * proximity). Returns true if it scrolled.
 */
export function autoScrollCalendar(x: number, y: number, dtMs: number): boolean {
  const s = activeCalendarScroller();
  if (!s) return false;
  const { el, insetTop } = s;
  const r = el.getBoundingClientRect();
  if (x < r.left || x > r.right) {
    // Beside the calendar (a sidebar): entering it near an edge is a deliberate move.
    armed = { top: true, bottom: true };
    carry = 0;
    return false;
  }
  const top = r.top + insetTop;
  const bottom = r.bottom;
  let dir = 0;
  let p = 0;
  const inTop = y >= r.top && y < top + ZONE;
  const inBottom = !inTop && y > bottom - ZONE && y <= bottom + 24;
  if (!inTop) armed.top = true;
  if (!inBottom) armed.bottom = true;
  if (inTop && armed.top) {
    dir = -1;
    p = Math.min(1, (top + ZONE - y) / ZONE);
  } else if (inBottom && armed.bottom) {
    dir = 1;
    p = Math.min(1, (y - (bottom - ZONE)) / ZONE);
  }
  if (dir === 0 || p <= 0) {
    carry = 0;
    return false;
  }
  const max = el.scrollHeight - el.clientHeight;
  if ((dir < 0 && el.scrollTop <= 0) || (dir > 0 && el.scrollTop >= max - 0.5)) return false;
  const speed = MIN_SPEED + (MAX_SPEED - MIN_SPEED) * p * p;
  const dt = Math.min(Math.max(dtMs, 0), 50);
  const delta = (dir * speed * dt) / 1000 + carry;
  const before = el.scrollTop;
  const want = Math.max(0, Math.min(max, before + delta));
  el.scrollTop = want;
  const moved = el.scrollTop - before;
  carry = Math.abs(want - el.scrollTop) < 2 ? want - el.scrollTop : 0;
  return moved !== 0;
}
