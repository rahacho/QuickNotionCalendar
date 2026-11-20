import { memo, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { ISODate } from '@shared/types';
import { addDays, diffDays, startOfMonth, startOfWeek } from '@shared/dates';
import { useStore } from '@/store/store';
import { setVisibleMonth } from '@/store/actions';
import { registerCalendarScroller } from '@/dnd';
import { usePrefersReducedMotion } from '@/hooks/useReducedMotion';
import { platform } from '@/lib/platform';
import { cx } from '@/lib/cx';
import { WeekRow } from './WeekRow';
import { WeekdayHeader } from './WeekdayHeader';
import type { AddMode } from './DayCell';
import { useCompactDensity } from './useCompactDensity';
import styles from './Calendar.module.css';

/** Rows mounted around the anchor on first render. */
const INITIAL_BEFORE = 20;
const INITIAL_AFTER = 24;
/** Rows added when the viewport gets within 1.5 viewport heights of an end. */
const EXTEND_BY = 8;
/** Soft cap of mounted rows (far rows are trimmed when scrolling settles). */
const MAX_ROWS = 60;
const KEEP_ABOVE = 16;
const KEEP_BELOW = 24;
/** A request whose target is further than this from the mounted window jumps instead of animating. */
const SMOOTH_REACH = 26;
const IDLE_MS = 160;

/** scrollRequest nonces already honored (module-level: survives remounts on view switches). */
let handledNonce = 0;

interface Range {
  first: ISODate;
  count: number;
}

interface Target {
  /** Week row to bring to the top (the month's first week). */
  week: ISODate;
  /** Week row that must be visible (the requested date's week). */
  dateWeek: ISODate;
  /** "YYYY-MM-01" of the requested month (the title while the view rests where it landed). */
  month: ISODate;
}

/** Rows (from the top one) that vote for the dominant month. */
const VOTE_ROWS = 5;

function weeksBetween(a: ISODate, b: ISODate): number {
  return Math.round(diffDays(a, b) / 7);
}

function targetFor(date: ISODate, weekStart: 0 | 1): Target {
  const month = startOfMonth(date);
  return { week: startOfWeek(month, weekStart), dateWeek: startOfWeek(date, weekStart), month };
}

function rangeAround(t: Target): Range {
  return { first: addDays(t.week, -INITIAL_BEFORE * 7), count: INITIAL_BEFORE + INITIAL_AFTER + 1 };
}

function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

export interface MonthScrollerProps {
  weekStart: 0 | 1;
  addMode: AddMode;
  inlineComposer: boolean;
  resizable: boolean;
}

/**
 * Notion's continuous month view: an endless vertical scroll of week rows under a sticky weekday header.
 *  - A window of rows is mounted and grown by 8 weeks near either end; when rows are added above,
 *    scrollTop is compensated in a layout effect before paint (Safari has no scroll anchoring, so the
 *    native one is disabled everywhere and this is the single source of truth). The same anchor logic
 *    keeps the view still when rows above the viewport change height (e.g. a synced task appears).
 *  - The dominant month (most visible days among the top rows) drives the title and the dimming; after
 *    Prev/Next/Today the requested month stays the title until the user scrolls to another row.
 *  - store.ui.scrollRequest (by nonce) scrolls a month's first week to the top.
 */
export const MonthScroller = memo(function MonthScroller({ weekStart, addMode, inlineComposer, resizable }: MonthScrollerProps) {
  const reduced = usePrefersReducedMotion();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const rowEls = useRef(new Map<ISODate, HTMLDivElement>());
  const compact = useCompactDensity(scrollerRef);

  // Initial anchor: a pending scroll request (e.g. switching from week view, a deep link); else, on the
  // current month, today (its month's first week on top only while today's week still fits below it —
  // busy earlier weeks must never push today's plan below the fold); else the visible month.
  const initialTarget = useRef<Target | null>(null);
  /** Until the user's first input, layout growth (late sync, fonts) re-applies the initial position. */
  const holdInitial = useRef(false);
  /** scrollTop after our own last write: any other scroll position comes from the user. */
  const ownTop = useRef(-1);
  if (initialTarget.current === null) {
    const { ui, today } = useStore.getState();
    const req = ui.scrollRequest;
    if (req && req.nonce > handledNonce) {
      initialTarget.current = targetFor(req.date, weekStart);
    } else if (ui.visibleMonth === startOfMonth(today)) {
      initialTarget.current = targetFor(today, weekStart);
      holdInitial.current = true;
    } else {
      initialTarget.current = targetFor(ui.visibleMonth, weekStart);
    }
  }
  const [range, setRange] = useState<Range>(() => rangeAround(initialTarget.current as Target));
  const weeks = useMemo(() => {
    const out: ISODate[] = [];
    for (let i = 0; i < range.count; i++) out.push(addDays(range.first, i * 7));
    return out;
  }, [range]);
  // The COMMITTED window (what is mounted), published in a layout effect: a time-sliced transition
  // render must never expose its not-yet-mounted rows to the scroll handlers (an anchor captured
  // against them would be lost and the prepend left uncompensated).
  const rangeRef = useRef(range);
  const weeksRef = useRef(weeks);
  useLayoutEffect(() => {
    rangeRef.current = range;
    weeksRef.current = weeks;
  }, [range, weeks]);

  /**
   * First visible row and its content offset, re-checked to keep it still across layout changes.
   * `st` is the last scrollTop seen (refreshed on every scroll event): when content shrinks under the
   * view the browser clamps scrollTop during layout, before we can correct it.
   */
  const anchor = useRef<{ week: ISODate; top: number; st: number } | null>(null);
  const extending = useRef(false);
  const pending = useRef<{ target: Target; smooth: boolean } | null>(null);
  const anim = useRef<{ target: Target; from: number; t0: number; dur: number; raf: number } | null>(null);
  /** Where a programmatic scroll landed: its month is the title while that row stays on top. */
  const landed = useRef<{ topWeek: ISODate; month: ISODate } | null>(null);
  const lastScrollAt = useRef(0);
  const idleTimer = useRef(0);
  const scrollRaf = useRef(0);

  const registerRow = useCallback((week: ISODate, el: HTMLDivElement | null) => {
    if (el) rowEls.current.set(week, el);
    else rowEls.current.delete(week);
  }, []);

  // ------------------------------------------------------------------ geometry helpers
  const headerH = () => headerRef.current?.offsetHeight ?? 0;

  /**
   * Index of the row containing content offset y (binary search over mounted rows; the first mounted
   * row when y is above all of them). Rows that aren't mounted are skipped, never answered.
   */
  const rowIndexAt = useCallback((y: number): number => {
    const list = weeksRef.current;
    let lo = 0;
    let hi = list.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const el = rowEls.current.get(list[mid] as ISODate);
      if (!el) {
        // Not mounted (shouldn't happen with the committed list): linear scan over the mounted ones.
        let best = -1;
        for (let i = 0; i < list.length; i++) {
          const r = rowEls.current.get(list[i] as ISODate);
          if (!r) continue;
          if (best < 0 || r.offsetTop <= y) best = i;
          else break;
        }
        return Math.max(0, best);
      }
      if (el.offsetTop <= y) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }, []);

  const captureAnchor = useCallback(() => {
    const sc = scrollerRef.current;
    if (!sc) return;
    const st = sc.scrollTop;
    const idx = rowIndexAt(st + headerH() + 1);
    const week = weeksRef.current[idx];
    const el = week ? rowEls.current.get(week) : undefined;
    if (week && el) {
      anchor.current = { week, top: el.offsetTop, st };
    } else if (anchor.current && rowEls.current.has(anchor.current.week)) {
      // Never trade a valid anchor for none: its content offset still describes the committed layout.
      anchor.current.st = st;
    }
  }, [rowIndexAt]);

  /**
   * Keeps the anchor row where it was on screen (before paint). Relative (`+= shift`) so scrolling
   * that happened since the anchor was taken is kept — except when the content shrank under the last
   * known position: the browser has then already clamped scrollTop to the new maximum during layout,
   * and the correction must start from where the view really was.
   */
  const compensate = useCallback(() => {
    const sc = scrollerRef.current;
    const a = anchor.current;
    if (!sc || !a) return;
    const el = rowEls.current.get(a.week);
    if (!el) {
      captureAnchor();
      return;
    }
    const shift = el.offsetTop - a.top;
    if (shift !== 0) {
      const live = sc.scrollTop;
      const max = sc.scrollHeight - sc.clientHeight;
      const clamped = a.st > max + 0.5 && live >= max - 0.5;
      sc.scrollTop = (clamped ? a.st : live) + shift;
      ownTop.current = sc.scrollTop;
      if (anim.current) anim.current.from += shift;
    }
    a.top = el.offsetTop;
    a.st = sc.scrollTop;
  }, [captureAnchor]);

  /** scrollTop that puts the target month's first week right under the header (date week kept visible). */
  const desiredTop = useCallback((t: Target): number | null => {
    const sc = scrollerRef.current;
    const el = rowEls.current.get(t.week);
    if (!sc || !el) return null;
    const h = headerH();
    let top = el.offsetTop - h;
    const dEl = rowEls.current.get(t.dateWeek);
    if (dEl) {
      const bottom = dEl.offsetTop + dEl.offsetHeight;
      if (bottom > top + sc.clientHeight) top = Math.min(dEl.offsetTop - h, bottom - sc.clientHeight);
    }
    return Math.max(0, Math.min(sc.scrollHeight - sc.clientHeight, top));
  }, []);

  /** Week row at the top of the viewport (under the sticky weekday header). */
  const topWeek = useCallback((): ISODate | undefined => {
    const sc = scrollerRef.current;
    if (!sc) return undefined;
    return weeksRef.current[rowIndexAt(sc.scrollTop + headerH() + 24)];
  }, [rowIndexAt]);

  const reportMonth = useCallback(() => {
    const sc = scrollerRef.current;
    if (!sc || sc.clientHeight === 0) return;
    // Right after Prev/Next/Today the requested month is the title, even on a short landscape phone
    // where the month's first row (mostly the previous month's days) fills the view.
    const l = landed.current;
    if (l) {
      if (topWeek() === l.topWeek) {
        setVisibleMonth(l.month);
        return;
      }
      landed.current = null;
    }
    // Otherwise the month with the most visible days among the top rows wins (later month on a tie).
    // Only the first rows vote: on tall screens (tablet portrait, ~12 rows) a month aligned to the top
    // must not lose to the next month filling the lower half.
    const h = headerH();
    const viewTop = sc.scrollTop + h;
    const viewBottom = sc.scrollTop + sc.clientHeight;
    const weeks = weeksRef.current;
    const votes = new Map<ISODate, number>();
    for (let i = rowIndexAt(viewTop + 1), n = 0; i < weeks.length && n < VOTE_ROWS; i++, n++) {
      const week = weeks[i] as ISODate;
      const el = rowEls.current.get(week);
      if (!el || el.offsetTop >= viewBottom) break;
      const shown = Math.min(el.offsetTop + el.offsetHeight, viewBottom) - Math.max(el.offsetTop, viewTop);
      const weight = Math.max(0, shown) / Math.max(1, el.offsetHeight);
      for (let d = 0; d < 7; d++) {
        const m = startOfMonth(addDays(week, d));
        votes.set(m, (votes.get(m) ?? 0) + weight);
      }
    }
    let best: ISODate | null = null;
    let bestVotes = -1;
    for (const [m, v] of votes) {
      if (v > bestVotes + 1e-6 || (Math.abs(v - bestVotes) <= 1e-6 && best !== null && m > best)) {
        best = m;
        bestVotes = v;
      }
    }
    if (best) setVisibleMonth(best);
  }, [rowIndexAt, topWeek]);

  /** A programmatic scroll finished at its target: remember the row it landed on. */
  const markLanded = useCallback(
    (t: Target) => {
      const w = topWeek();
      landed.current = w ? { topWeek: w, month: t.month } : null;
    },
    [topWeek],
  );

  // ------------------------------------------------------------------ window growth
  const maybeExtend = useCallback(() => {
    const sc = scrollerRef.current;
    if (!sc || extending.current || sc.clientHeight === 0) return;
    const { scrollTop, clientHeight, scrollHeight } = sc;
    const margin = clientHeight * 1.5;
    if (scrollTop < margin) {
      // iOS stops momentum scrolling when scrollTop is written: while the finger/momentum is moving,
      // wait for the scroll to settle unless the top is really close.
      const moving = performance.now() - lastScrollAt.current < 120;
      if (platform.isTouch && moving && !anim.current && scrollTop > clientHeight * 0.35) return;
      captureAnchor();
      extending.current = true;
      // A transition: the new rows render in slices instead of one long task mid-scroll; the commit
      // (and the compensation in its layout effect) still lands atomically before paint. Functional, so
      // it composes with a window change committed in between (a scroll request).
      startTransition(() => setRange((p) => ({ first: addDays(p.first, -EXTEND_BY * 7), count: p.count + EXTEND_BY })));
      return;
    }
    if (scrollHeight - clientHeight - scrollTop < margin) {
      extending.current = true;
      startTransition(() => setRange((p) => ({ first: p.first, count: p.count + EXTEND_BY })));
    }
  }, [captureAnchor]);

  const maybeTrim = useCallback(() => {
    const sc = scrollerRef.current;
    const r = rangeRef.current;
    if (!sc || extending.current || anim.current || r.count <= MAX_ROWS) return;
    const s = useStore.getState().ui;
    if (s.dragging || s.composer || document.documentElement.hasAttribute('data-cal-resizing')) return;
    const h = headerH();
    const firstVisible = rowIndexAt(sc.scrollTop + h + 1);
    const lastVisible = rowIndexAt(sc.scrollTop + sc.clientHeight - 1);
    const excess = r.count - MAX_ROWS;
    const trimTop = Math.min(excess, Math.max(0, firstVisible - KEEP_ABOVE));
    const trimBottom = Math.min(excess - trimTop, Math.max(0, r.count - 1 - lastVisible - KEEP_BELOW));
    if (trimTop + trimBottom <= 0) return;
    // Synchronous: the anchor (and the scrollTop it was taken at) and the commit + compensation happen
    // in this one task, so no scroll can slip in between. Removing rows is cheap.
    captureAnchor();
    extending.current = true;
    flushSync(() => setRange({ first: addDays(r.first, trimTop * 7), count: r.count - trimTop - trimBottom }));
  }, [captureAnchor, rowIndexAt]);

  // ------------------------------------------------------------------ programmatic scrolling
  const cancelAnim = useCallback(() => {
    const a = anim.current;
    if (!a) return;
    cancelAnimationFrame(a.raf);
    anim.current = null;
  }, []);

  const step = useCallback(
    (now: number) => {
      const a = anim.current;
      const sc = scrollerRef.current;
      if (!a || !sc) return;
      const to = desiredTop(a.target);
      if (to === null) {
        anim.current = null;
        return;
      }
      const t = Math.min(1, (now - a.t0) / a.dur);
      sc.scrollTop = a.from + (to - a.from) * easeInOut(t);
      ownTop.current = sc.scrollTop;
      if (t < 1) {
        a.raf = requestAnimationFrame(step);
        return;
      }
      anim.current = null;
      captureAnchor();
      markLanded(a.target);
      reportMonth();
      maybeExtend();
    },
    [captureAnchor, desiredTop, markLanded, maybeExtend, reportMonth],
  );

  const positionNow = useCallback(
    (target: Target, smooth: boolean) => {
      const sc = scrollerRef.current;
      if (!sc) return;
      cancelAnim();
      const to = desiredTop(target);
      if (to === null) return;
      const from = sc.scrollTop;
      const dist = Math.abs(to - from);
      if (!smooth || dist < 2) {
        sc.scrollTop = to;
        ownTop.current = sc.scrollTop;
        captureAnchor();
        markLanded(target);
        reportMonth();
        return;
      }
      landed.current = null;
      const dur = Math.min(520, Math.max(280, 220 + dist * 0.1));
      anim.current = { target, from, t0: performance.now(), dur, raf: requestAnimationFrame(step) };
    },
    [cancelAnim, captureAnchor, desiredTop, markLanded, reportMonth, step],
  );

  const scrollToDate = useCallback(
    (date: ISODate, smooth: boolean) => {
      const target = targetFor(date, weekStart);
      const r = rangeRef.current;
      const idx = weeksBetween(target.week, r.first);
      const dateIdx = weeksBetween(target.dateWeek, r.first);
      if (idx >= 4 && dateIdx <= r.count - 12) {
        positionNow(target, smooth);
        return;
      }
      cancelAnim();
      if (smooth && idx >= -SMOOTH_REACH && dateIdx <= r.count + SMOOTH_REACH) {
        // Grow the window to include the target (rows added above are compensated), then animate.
        const startIdx = Math.min(0, idx - 8);
        const endIdx = Math.max(r.count - 1, dateIdx + 16);
        captureAnchor();
        pending.current = { target, smooth: true };
        extending.current = true;
        setRange({ first: addDays(r.first, startIdx * 7), count: endIdx - startIdx + 1 });
        return;
      }
      // Far away: rebuild the window around the target and jump.
      anchor.current = null;
      pending.current = { target, smooth: false };
      extending.current = true;
      setRange(rangeAround(target));
    },
    [cancelAnim, captureAnchor, positionNow, weekStart],
  );

  // ------------------------------------------------------------------ effects
  // First paint: jump to the initial month (before the browser paints anything).
  useLayoutEffect(() => {
    const t = initialTarget.current;
    if (t) positionNow(t, false);
    const req = useStore.getState().ui.scrollRequest;
    if (req && req.nonce > handledNonce) handledNonce = req.nonce;
  }, [positionNow]);

  // After every window change: compensate (prepend/trim), then honor a pending position.
  useLayoutEffect(() => {
    compensate();
    extending.current = false;
    const p = pending.current;
    if (p) {
      pending.current = null;
      positionNow(p.target, p.smooth);
    }
    const id = requestAnimationFrame(() => maybeExtend());
    return () => cancelAnimationFrame(id);
  }, [range, compensate, positionNow, maybeExtend]);

  // Rows above the viewport changing height (cards added/removed, wraps on resize) → stay put.
  // The viewport itself resizing (window, sidebars) may also need more rows.
  useLayoutEffect(() => {
    const grid = gridRef.current;
    const sc = scrollerRef.current;
    if (!grid || !sc || typeof ResizeObserver === 'undefined') return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      compensate();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        // Before the user has touched anything, rows growing late (a sync snapshot, fonts) must not
        // push today out of view: re-apply the opening position. Next frame, not inside the observer
        // callback (re-laying out from there trips WebKit's "ResizeObserver loop" error).
        const t = initialTarget.current;
        if (holdInitial.current && t && !anim.current) positionNow(t, false);
        maybeExtend();
      });
    });
    ro.observe(grid);
    ro.observe(sc);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [compensate, maybeExtend, positionNow]);

  // The first input anywhere (or any navigation) ends the opening hold.
  useEffect(() => {
    if (!holdInitial.current) return;
    const release = () => {
      holdInitial.current = false;
      stopListening();
    };
    const opts = { capture: true, passive: true } as const;
    const kinds = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    function stopListening() {
      for (const k of kinds) window.removeEventListener(k, release, opts);
    }
    for (const k of kinds) window.addEventListener(k, release, opts);
    const unsub = useStore.subscribe((s, prev) => {
      if (s.ui.scrollRequest !== prev.ui.scrollRequest || (s.ui.dragging && !prev.ui.dragging)) release();
    });
    return () => {
      stopListening();
      unsub();
    };
  }, []);

  // Scroll requests (prev/next/Today/deep links).
  const request = useStore((s) => s.ui.scrollRequest);
  useLayoutEffect(() => {
    if (!request || request.nonce <= handledNonce) return;
    handledNonce = request.nonce;
    holdInitial.current = false;
    scrollToDate(request.date, request.behavior === 'smooth' && !reduced);
  }, [request, reduced, scrollToDate]);

  // Edge auto-scroll target while dragging.
  useEffect(() => {
    const sc = scrollerRef.current;
    if (!sc) return;
    return registerCalendarScroller(sc, { insetTop: headerRef.current?.offsetHeight ?? 0 });
  }, []);

  // A user gesture interrupts a programmatic scroll.
  useEffect(() => {
    const sc = scrollerRef.current;
    if (!sc) return;
    const stop = () => {
      if (!anim.current) return;
      cancelAnim();
      reportMonth();
    };
    const onKey = (e: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) stop();
    };
    sc.addEventListener('wheel', stop, { passive: true });
    sc.addEventListener('touchstart', stop, { passive: true });
    sc.addEventListener('pointerdown', stop, { passive: true });
    sc.addEventListener('keydown', onKey);
    return () => {
      sc.removeEventListener('wheel', stop);
      sc.removeEventListener('touchstart', stop);
      sc.removeEventListener('pointerdown', stop);
      sc.removeEventListener('keydown', onKey);
    };
  }, [cancelAnim, reportMonth]);

  useEffect(
    () => () => {
      cancelAnim();
      cancelAnimationFrame(scrollRaf.current);
      window.clearTimeout(idleTimer.current);
    },
    [cancelAnim],
  );

  const onIdle = useCallback(() => {
    if (anim.current) return;
    reportMonth();
    maybeExtend();
    maybeTrim();
  }, [maybeExtend, maybeTrim, reportMonth]);

  const onScroll = useCallback(() => {
    lastScrollAt.current = performance.now();
    const sc = scrollerRef.current;
    if (sc && anchor.current) anchor.current.st = sc.scrollTop;
    // A scroll we didn't make (VoiceOver, find-in-page, …) also ends the opening hold.
    if (sc && holdInitial.current && Math.abs(sc.scrollTop - ownTop.current) > 1) holdInitial.current = false;
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(onIdle, IDLE_MS);
    if (scrollRaf.current) return;
    scrollRaf.current = requestAnimationFrame(() => {
      scrollRaf.current = 0;
      captureAnchor();
      // While a programmatic scroll runs the header already shows its target month.
      if (!anim.current) reportMonth();
      maybeExtend();
    });
  }, [captureAnchor, maybeExtend, onIdle, reportMonth]);

  return (
    <div
      ref={scrollerRef}
      className={cx(styles.scroller, compact && styles.compact)}
      data-density={compact ? 'compact' : 'regular'}
      data-cal-scroller=""
      data-testid="month-scroller"
      onScroll={onScroll}
    >
      <WeekdayHeader ref={headerRef} weekStart={weekStart} compact={compact} />
      <div ref={gridRef} className={styles.grid}>
        {weeks.map((w) => (
          <WeekRow
            key={w}
            weekStart={w}
            variant="month"
            compact={compact}
            addMode={addMode}
            inlineComposer={inlineComposer}
            resizable={resizable}
            registerRow={registerRow}
          />
        ))}
      </div>
    </div>
  );
});
