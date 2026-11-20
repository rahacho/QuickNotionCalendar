/**
 * Desktop resize of multi-day bars and single cards: 6px edge handles, day snapping by hit-testing the
 * day cell under the pointer, live preview (rows re-layout with the patched occurrence), Esc cancels,
 * commit via actions.resizeTask. Listeners live on window, so the preview may re-render or even
 * unmount the handle (a single card turning into a bar) without losing the gesture.
 */
import { useSyncExternalStore } from 'react';
import type { ISODate, Occurrence, WeekLayout } from '@shared/types';
import { layoutWeek } from '@shared/layout';
import { resizeTask } from '@/store/actions';
import { autoScrollCalendar, dayAt, resetAutoScroll } from '@/dnd';

export interface ResizePreview {
  /** The occurrence as stored. */
  orig: Occurrence;
  /** The occurrence with the previewed range (same key). */
  patched: Occurrence;
}

let preview: ResizePreview | null = null;
const listeners = new Set<() => void>();
let suppressClickUntil = 0;

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function overlaps(o: Occurrence, first: ISODate, last: ISODate): boolean {
  if (o.date === null) return false;
  const end = o.endDate !== null && o.endDate > o.date ? o.endDate : o.date;
  return o.date <= last && end >= first;
}

/** The live preview when it touches the row [first, last] (stable reference while unchanged). */
export function useResizePreviewFor(first: ISODate | undefined, last: ISODate | undefined): ResizePreview | null {
  return useSyncExternalStore(
    subscribe,
    () => {
      const p = preview;
      if (!p || first === undefined || last === undefined) return null;
      return overlaps(p.orig, first, last) || overlaps(p.patched, first, last) ? p : null;
    },
    () => null,
  );
}

/** True while this occurrence is being resized (for the "lifted" look). */
export function useIsResizing(key: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => preview !== null && preview.orig.key === key,
    () => false,
  );
}

/** Row layout with the previewed occurrence swapped in. */
export function applyPreview(layout: WeekLayout, p: ResizePreview): WeekLayout {
  const days = layout.days;
  const first = days[0];
  const last = days[days.length - 1];
  if (first === undefined || last === undefined) return layout;
  const all: Occurrence[] = [];
  for (const b of layout.bars) if (b.occ.key !== p.orig.key) all.push(b.occ);
  for (const d of days) for (const o of layout.singles[d] ?? []) if (o.key !== p.orig.key) all.push(o);
  if (overlaps(p.patched, first, last)) all.push(p.patched);
  return layoutWeek(days, all);
}

/** A click that ends a resize must not open the peek. */
export function resizeJustEnded(): boolean {
  return performance.now() < suppressClickUntil;
}

let active = false;

/** Starts a resize gesture from a handle's pointerdown. */
export function beginResize(e: { button: number; clientX: number; clientY: number; pointerId: number; preventDefault(): void; stopPropagation(): void }, occ: Occurrence, edge: 'start' | 'end'): void {
  if (e.button !== 0 || active || occ.recurring || occ.date === null) return;
  e.preventDefault();
  e.stopPropagation();
  active = true;
  const origStart = occ.date;
  const origEnd = occ.endDate !== null && occ.endDate > occ.date ? occ.endDate : occ.date;
  let start = origStart;
  let end = origEnd;
  let x = e.clientX;
  let y = e.clientY;
  let raf = 0;
  let last = 0;
  const pointerId = e.pointerId;
  const root = document.documentElement;
  root.setAttribute('data-cal-resizing', edge);
  resetAutoScroll();

  const publish = () => {
    preview = { orig: occ, patched: { ...occ, date: start, endDate: end, multiDay: end > start } };
    emit();
  };
  publish();

  const update = () => {
    const d = dayAt(x, y);
    if (!d) return;
    const ns = edge === 'start' ? (d > origEnd ? origEnd : d) : start;
    const ne = edge === 'end' ? (d < origStart ? origStart : d) : end;
    if (ns !== start || ne !== end) {
      start = ns;
      end = ne;
      publish();
    }
  };

  const frame = (now: number) => {
    const dt = last ? now - last : 16;
    last = now;
    if (autoScrollCalendar(x, y, dt)) update();
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    x = ev.clientX;
    y = ev.clientY;
    update();
  };

  const cleanup = () => {
    active = false;
    cancelAnimationFrame(raf);
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onCancel, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', onCancel);
    root.removeAttribute('data-cal-resizing');
    suppressClickUntil = performance.now() + 250;
    preview = null;
    emit();
  };

  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    x = ev.clientX;
    y = ev.clientY;
    update();
    const changed = start !== origStart || end !== origEnd;
    cleanup();
    if (changed) resizeTask(occ.taskId, start, end);
  };

  const onCancel = () => cleanup();

  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopPropagation();
    cleanup();
  };

  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onCancel, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', onCancel);
}
