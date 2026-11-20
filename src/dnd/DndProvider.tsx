import { useCallback, useEffect, useMemo, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  defaultDropAnimationSideEffects,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  type DropAnimation,
  type KeyboardCoordinateGetter,
  type MeasuringConfiguration,
} from '@dnd-kit/core';
import { getEventCoordinates } from '@dnd-kit/utilities';
import type { ISODate, Occurrence } from '@shared/types';
import { addDays, diffDays } from '@shared/dates';
import { refOf, isOverdue } from '@shared/occurrences';
import { formatDateLong } from '@shared/format';
import { useStore } from '@/store/store';
import { goNext, goPrev, moveOccurrence, setDragging, setDrawer } from '@/store/actions';
import { usePrefersReducedMotion } from '@/hooks/useReducedMotion';
import { TaskCard } from '@/components/card/TaskCard';
import { cx } from '@/lib/cx';
import { markKeyboardFocused } from '@/components/calendar/focusOrigin';
import { autoScrollCalendar, isCalendarScroller, resetAutoScroll } from './autoscroll';
import { dayAt, resolveDrop } from './geometry';
import { isTaskDragData } from './ids';
import { nodeForId } from './registry';
import { getDndState, markSortDrop, resetDndState, setDndState, useDndSelector, type ActiveDrag } from './state';
import styles from './dnd.module.css';

// ---------------------------------------------------------------------------------------------
// Drag session (module state: there is exactly one DndProvider)
// ---------------------------------------------------------------------------------------------

interface Point {
  x: number;
  y: number;
}

let pointer: Point | null = null;
let raf = 0;
let lastFrame = 0;
let flip: { el: Element; since: number } | null = null;
let touchDrag = false;
/** The element a touch drag started on: touch events keep targeting it even if it leaves the DOM. */
let touchTarget: EventTarget | null = null;
let touchOnDraggable = false;
let suppressClicksUntil = 0;
/** Where the last drop went ("November 21, 2026", "the Inbox"), for the screen-reader announcement. */
let lastDropLabel: string | null = null;

const FLIP_DWELL_MS = 600;

if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __dnd?: unknown }).__dnd = {
    pointer: () => pointer,
    state: () => getDndState(),
    resolve: () => {
      const a = getDndState().active;
      return a && pointer ? resolveDrop(a, pointer.x, pointer.y) : null;
    },
  };
}

function center(r: { left: number; top: number; width: number; height: number }): Point {
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** Re-resolves the drop target under the live pointer and publishes it (no-op if unchanged). */
function updateHit(): void {
  const active = getDndState().active;
  if (!active || !pointer) return;
  const res = resolveDrop(active, pointer.x, pointer.y);
  if (!res) {
    setDndState({ hit: null, range: null, indicator: null, refused: false, sort: null });
    return;
  }
  setDndState({
    sort: res.offsets && active.containerId ? { containerId: active.containerId, offsets: res.offsets } : null,
    hit: res.hit,
    range: res.noop && active.occ.multiDay ? null : res.range,
    indicator: res.indicator,
    refused: res.refused,
  });
}

function setFlipHover(el: Element | null): void {
  if (flip?.el === el) return;
  if (flip) flip.el.removeAttribute('data-dnd-hover');
  flip = el ? { el, since: performance.now() } : null;
  if (el) el.setAttribute('data-dnd-hover', '');
}

/** Hovering ‹ / › for 600ms while dragging flips the month (or week); keeps flipping while held. */
function checkFlip(now: number): void {
  if (!pointer) return;
  const top = document.elementFromPoint(pointer.x, pointer.y);
  const btn = top?.closest('[data-dnd-flip]') ?? null;
  setFlipHover(btn);
  if (!flip || !btn) return;
  if (now - flip.since >= FLIP_DWELL_MS) {
    flip.since = now;
    if (btn.getAttribute('data-dnd-flip') === 'prev') goPrev();
    else goNext();
  }
}

function frame(now: number): void {
  raf = 0;
  const st = getDndState();
  if (!st.active) return;
  const dt = lastFrame ? now - lastFrame : 16;
  lastFrame = now;
  if (pointer) {
    if (!(st.hit && st.hit.kind === 'inbox')) autoScrollCalendar(pointer.x, pointer.y, dt);
    checkFlip(now);
    updateHit();
  }
  raf = requestAnimationFrame(frame);
}

function startLoop(): void {
  lastFrame = 0;
  resetAutoScroll();
  if (!raf) raf = requestAnimationFrame(frame);
}

function stopLoop(): void {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  setFlipHover(null);
}

function onTargetTouchMove(e: TouchEvent): void {
  trackPointer(e);
  if (touchDrag && e.cancelable) e.preventDefault();
}

function trackPointer(e: Event): void {
  const active = getDndState().active;
  // Keyboard drags follow the overlay (onDragMove), not a resting mouse.
  if (!active || active.input === 'keyboard') return;
  if (typeof TouchEvent !== 'undefined' && e instanceof TouchEvent) {
    if (active.input !== 'touch') return;
    const t = e.touches[0] ?? e.changedTouches[0];
    if (t) pointer = { x: t.clientX, y: t.clientY };
  } else if (e instanceof MouseEvent) {
    // PointerEvent extends MouseEvent. A touch drag follows the finger only: browsers fire synthetic
    // mousemoves at a resting cursor when content scrolls under it (iPad with a trackpad), which
    // would otherwise yank the drop target back under the cursor.
    if (active.input !== 'mouse') return;
    pointer = { x: e.clientX, y: e.clientY };
  }
}

// ---------------------------------------------------------------------------------------------
// dnd-kit configuration
// ---------------------------------------------------------------------------------------------

/**
 * dnd-kit's collision pipeline is unused: drop targets are hit-tested live under the pointer by the
 * frame loop (resolveDrop), and no dnd-kit droppables are registered at all (registering hundreds of
 * them is O(n²) in dnd-kit's reducer). `over` therefore stays null.
 */
const noCollisions: CollisionDetection = () => [];

const measuring: MeasuringConfiguration = {
  droppable: { strategy: MeasuringStrategy.Always },
};

const SETTLE_MS = 220;
let settleTimer = 0;

const autoScroll = {
  // Our own edge scroller drives the calendar; dnd-kit keeps scrolling everything else (Inbox, list).
  canScroll: (el: Element) => !isCalendarScroller(el),
  threshold: { x: 0, y: 0.15 },
};

const KEY_STEP: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };

/** Arrow keys move a keyboard-dragged card day by day (↑/↓ by week) when the target day is on screen. */
const keyboardCoordinates: KeyboardCoordinateGetter = (event, { currentCoordinates, context }) => {
  const step = KEY_STEP[event.code];
  if (step === undefined) return undefined;
  event.preventDefault();
  const rect = context.collisionRect;
  if (rect) {
    const c = center(rect);
    const from = dayAt(c.x, c.y);
    // Not over the calendar yet (a Tasks-list row, an Inbox bubble): the first arrow lands on today.
    const target = from ? addDays(from, step) : useStore.getState().today;
    for (const el of document.querySelectorAll<HTMLElement>(`[data-testid="day-cell"][data-date="${target}"]`)) {
      if (el.closest('[inert]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      if (!from && (r.bottom < 0 || r.top > window.innerHeight)) continue;
      const cx = r.left + r.width / 2;
      const cy = r.top + Math.min(r.height / 2, 48);
      return { x: cx - rect.width / 2, y: cy - rect.height / 2 };
    }
  }
  const dx = step === -1 ? -25 : step === 1 ? 25 : 0;
  const dy = step === -7 ? -25 : step === 7 ? 25 : 0;
  return { x: currentCoordinates.x + dx, y: currentCoordinates.y + dy };
};

function titleOf(data: unknown): string {
  if (!isTaskDragData(data)) return 'Task';
  const t = data.occ.title.trim();
  return t ? `“${t}”` : 'Untitled task';
}

function targetLabel(): string | null {
  const hit = getDndState().hit;
  if (!hit) return null;
  if (hit.kind === 'inbox') return 'the Inbox';
  return hit.date ? formatDateLong(hit.date) : null;
}

const announcements: Announcements = {
  onDragStart: ({ active }) => `Picked up ${titleOf(active.data.current)}.`,
  onDragOver: ({ active }) => {
    const t = targetLabel();
    return t ? `${titleOf(active.data.current)} is over ${t}.` : undefined;
  },
  onDragEnd: ({ active }) => {
    // dnd-kit announces after our onDragEnd has reset the live drag state: use what it resolved.
    const t = lastDropLabel ?? targetLabel();
    lastDropLabel = null;
    return t ? `${titleOf(active.data.current)} was dropped on ${t}.` : `${titleOf(active.data.current)} was dropped.`;
  },
  onDragCancel: ({ active }) => `Moving ${titleOf(active.data.current)} was cancelled.`,
};

const screenReaderInstructions = {
  draggable:
    'To move a task, press Space. Use the arrow keys to move it between days, Space or Enter to drop it, and Escape to cancel.',
};

/**
 * After a keyboard drop the moved item has re-mounted in its new place (another day, the Inbox, another
 * Tasks-list group), so dnd-kit's own focus restore finds a detached node and focus would fall to
 * <body>. Put it on the moved item instead (after dnd-kit's restore frame), as keyboard focus.
 */
function refocusAfterKeyboardDrop(active: ActiveDrag, toInbox: boolean): void {
  const key = CSS.escape(active.occ.key);
  const selectors: string[] = [];
  if (toInbox) selectors.push(`[data-testid="inbox-bubble"][data-task-id="${CSS.escape(active.occ.taskId)}"]`);
  else if (active.source === 'list') selectors.push(`[data-testid="list-row"][data-occ-key="${key}"] [data-row-focus]`);
  selectors.push(`[data-testid="calendar"] [data-occ-key="${key}"]`);
  const find = (): HTMLElement | null => {
    for (const sel of selectors) {
      for (const el of document.querySelectorAll<HTMLElement>(sel)) {
        if (el.isConnected && !el.closest('[inert]') && el.getClientRects().length > 0) return el;
      }
    }
    return null;
  };
  let tries = 0;
  const go = () => {
    const el = find();
    if (el) {
      el.focus();
      markKeyboardFocused(el);
    } else if (++tries < 10) {
      requestAnimationFrame(go);
    }
  };
  requestAnimationFrame(() => requestAnimationFrame(go));
}

// ---------------------------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------------------------

export function DndProvider(props: { children: ReactNode }) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 300, tolerance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: keyboardCoordinates,
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter'] },
    }),
  );

  // Document listeners that must exist before any touch starts (iOS decides at touchstart whether
  // touchmove can be cancelled), plus click / context-menu suppression around drags.
  useEffect(() => {
    const onTouchMove = (e: TouchEvent) => {
      trackPointer(e);
      if (touchDrag && e.cancelable) e.preventDefault();
    };
    const onTouchStart = (e: TouchEvent) => {
      const t = e.target;
      touchOnDraggable = t instanceof Element && t.closest('[data-dnd-draggable]') !== null;
    };
    const onTouchEnd = () => {
      touchOnDraggable = false;
    };
    const onContextMenu = (e: Event) => {
      if (touchOnDraggable || touchDrag || getDndState().active) e.preventDefault();
    };
    const onClick = (e: MouseEvent) => {
      if (performance.now() < suppressClicksUntil) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onMove = (e: Event) => trackPointer(e);
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
    document.addEventListener('touchend', onTouchEnd, { passive: true, capture: true });
    document.addEventListener('touchcancel', onTouchEnd, { passive: true, capture: true });
    document.addEventListener('contextmenu', onContextMenu, { capture: true });
    window.addEventListener('click', onClick, { capture: true });
    window.addEventListener('pointermove', onMove, { passive: true, capture: true });
    window.addEventListener('mousemove', onMove, { passive: true, capture: true });
    return () => {
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchstart', onTouchStart, { capture: true });
      document.removeEventListener('touchend', onTouchEnd, { capture: true });
      document.removeEventListener('touchcancel', onTouchEnd, { capture: true });
      document.removeEventListener('contextmenu', onContextMenu, { capture: true });
      window.removeEventListener('click', onClick, { capture: true });
      window.removeEventListener('pointermove', onMove, { capture: true });
      window.removeEventListener('mousemove', onMove, { capture: true });
      stopLoop();
      resetDndState();
      document.documentElement.removeAttribute('data-dnd-dragging');
    };
  }, []);

  const finish = useCallback((input: ActiveDrag['input'] | null, dropped: boolean) => {
    const own = getDndState().active?.containerId ?? null;
    stopLoop();
    touchDrag = false;
    pointer = null;
    touchTarget?.removeEventListener('touchmove', onTargetTouchMove as EventListener);
    touchTarget = null;
    if (input === 'mouse' || input === 'touch') suppressClicksUntil = performance.now() + (input === 'touch' ? 450 : 250);
    // The drag's own list: after a drop the new DOM order already matches the shifted look (no
    // animation); after a cancel the shifted cards glide back.
    window.clearTimeout(settleTimer);
    resetDndState(own ? { containerId: own, animate: !dropped } : null);
    if (own) settleTimer = window.setTimeout(() => setDndState({ settle: null }), SETTLE_MS);
    setDragging(null);
    document.documentElement.removeAttribute('data-dnd-dragging');
  }, []);

  const onDragStart = useCallback((e: DragStartEvent) => {
    const data = e.active.data.current;
    if (!isTaskDragData(data)) return;
    const occ = data.occ;
    const ev = e.activatorEvent;
    const input: ActiveDrag['input'] =
      typeof TouchEvent !== 'undefined' && ev instanceof TouchEvent ? 'touch' : ev instanceof KeyboardEvent ? 'keyboard' : 'mouse';
    const coords = getEventCoordinates(ev);
    const initial = e.active.rect.current.initial;
    pointer = coords ?? (initial ? center(initial) : null);

    // Draggables stop hit-testing from here on (CSS), so the day under a grabbed bar can be found.
    document.documentElement.setAttribute('data-dnd-dragging', input);
    const span = occ.multiDay && occ.date && occ.endDate ? Math.max(0, diffDays(occ.endDate, occ.date)) : 0;
    let grabOffset = 0;
    if (span > 0 && pointer && occ.date) {
      const grabbed = dayAt(pointer.x, pointer.y);
      if (grabbed) grabOffset = Math.min(span, Math.max(0, diffDays(grabbed, occ.date)));
    }
    lastDropLabel = null;
    const node = nodeForId(String(e.active.id));
    const variant = node?.getAttribute('data-variant');
    const look: ActiveDrag['look'] = variant === 'bar' ? 'bar' : 'card';
    const compact = variant === 'compact' || node?.closest('[data-density="compact"]') != null;
    const wrap = node?.getAttribute('data-wrap') === 'true';

    touchDrag = input === 'touch';
    if (touchDrag && ev?.target) {
      touchTarget = ev.target;
      touchTarget.addEventListener('touchmove', onTargetTouchMove as EventListener, { passive: false });
    }
    setDndState({
      active: {
        id: String(e.active.id),
        occ,
        source: data.source,
        containerId: data.containerId,
        grabOffset,
        span,
        input,
        look,
        compact,
        wrap,
      },
    });
    setDragging({ occKey: occ.key, source: data.source, recurring: occ.recurring });
    if (useStore.getState().ui.drawerOpen) setDrawer(false);
    updateHit();
    startLoop();
  }, []);

  const onDragMove = useCallback((e: DragMoveEvent) => {
    const active = getDndState().active;
    if (active?.input === 'keyboard') {
      const r = e.active.rect.current.translated;
      if (r) {
        pointer = center(r);
        updateHit();
      }
    }
  }, []);

  const onDragEnd = useCallback(
    (_e: DragEndEvent) => {
      const active = getDndState().active;
      if (!active) {
        finish(null, false);
        return;
      }
      const p = pointer;
      const res = p ? resolveDrop(active, p.x, p.y) : null;
      const dropped = res !== null && !res.noop && !res.refused;
      if (dropped && res.hit.containerId === active.containerId) markSortDrop(active.containerId);
      lastDropLabel = dropped ? (res.hit.kind === 'inbox' ? 'the Inbox' : res.targetDate ? formatDateLong(res.targetDate) : null) : null;
      finish(active.input, dropped);
      if (!res || res.noop) return;
      const ref = refOf(active.occ);
      if (res.hit.kind === 'inbox') {
        // Repeating occurrences are refused by the action itself (it shows the explanatory toast).
        moveOccurrence(ref, null, res.pos);
      } else if (res.targetDate) {
        moveOccurrence(ref, res.targetDate, res.pos);
      }
      if (dropped && active.input === 'keyboard') refocusAfterKeyboardDrop(active, res.hit.kind === 'inbox');
    },
    [finish],
  );

  const onDragCancel = useCallback(() => {
    finish(getDndState().active?.input ?? null, false);
  }, [finish]);

  const accessibility = useMemo(() => ({ announcements, screenReaderInstructions }), []);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={noCollisions}
      measuring={measuring}
      autoScroll={autoScroll}
      accessibility={accessibility}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      {props.children}
      <Overlay />
    </DndContext>
  );
}

// ---------------------------------------------------------------------------------------------
// Overlay + insertion line
// ---------------------------------------------------------------------------------------------

function OverlayCard({ active, today, refused }: { active: ActiveDrag; today: ISODate; refused: boolean }) {
  const occ: Occurrence = active.occ;
  const overdue = isOverdue(occ, today);
  if (active.look === 'bar') {
    return (
      <TaskCard
        occ={occ}
        variant="bar"
        compact={active.compact}
        wrap={active.wrap}
        overdue={overdue}
        className={cx(styles.overlayBar, refused && styles.refused)}
        aria-hidden="true"
      />
    );
  }
  return (
    <TaskCard
      occ={occ}
      variant="overlay"
      compact={active.compact}
      overdue={overdue}
      className={cx(styles.overlayCard, refused && styles.refused)}
      aria-hidden="true"
    />
  );
}

function Overlay() {
  const active = useDndSelector((s) => s.active);
  const refused = useDndSelector((s) => s.refused);
  const today = useStore((s) => s.today);
  const reduced = usePrefersReducedMotion();
  const dropAnimation = useMemo<DropAnimation | null>(
    () =>
      reduced
        ? null
        : {
            duration: 180,
            easing: 'cubic-bezier(0.2, 0, 0, 1)',
            sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: '0' } } }),
          },
    [reduced],
  );

  if (typeof document === 'undefined') return null;
  return createPortal(
    <>
      <DragOverlay dropAnimation={dropAnimation} className={styles.overlay} style={{ zIndex: 'var(--z-drag)' }}>
        {active ? <OverlayCard active={active} today={today} refused={refused} /> : null}
      </DragOverlay>
      <InsertionLine />
    </>,
    document.body,
  );
}

function InsertionLine() {
  const indicator = useDndSelector((s) => s.indicator);
  if (!indicator) return null;
  return (
    <div
      className={styles.line}
      aria-hidden="true"
      style={{ transform: `translate3d(${Math.round(indicator.x)}px, ${Math.round(indicator.y) - 1}px, 0)`, width: indicator.width }}
    />
  );
}
