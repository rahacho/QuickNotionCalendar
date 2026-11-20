/**
 * Keyboard access to the calendar grid: ONE tab stop (roving tabindex). Tab enters the calendar on a
 * single day cell — the last one used, else today (when it is in the month / week on screen), else the
 * first day shown — instead of walking every mounted day (hundreds of stops, and the browser scrolling
 * months away to reach the first one). Arrow keys move between days; the cards of the active day are
 * the next tab stops; Tab again leaves the calendar.
 */
import { useSyncExternalStore } from 'react';
import type { ISODate } from '@shared/types';
import { addDays, startOfMonth, startOfWeek } from '@shared/dates';
import { useStore } from '@/store/store';
import { scrollCalendarTo } from '@/store/actions';
import { markKeyboardFocused } from './focusOrigin';

let explicit: ISODate | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** The day the keyboard is on (null: back to the default — today / the first day shown). */
export function setActiveCell(date: ISODate | null): void {
  if (explicit === date) return;
  explicit = date;
  emit();
}

/** The calendar's tab stop right now. */
export function activeCell(): ISODate {
  if (explicit) return explicit;
  const { today, ui, settings } = useStore.getState();
  if (ui.view === 'week') {
    const ws = startOfWeek(ui.weekAnchor, settings.weekStart);
    return today >= ws && today <= addDays(ws, 6) ? today : ws;
  }
  return startOfMonth(today) === ui.visibleMonth ? today : ui.visibleMonth;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  const unsub = useStore.subscribe(fn);
  return () => {
    listeners.delete(fn);
    unsub();
  };
}

/** The active day if it lies in [first, last] (else null): only the rows it enters/leaves re-render. */
export function useActiveCellIn(first: ISODate, last: ISODate): ISODate | null {
  return useSyncExternalStore(
    subscribe,
    () => {
      const a = activeCell();
      return a >= first && a <= last ? a : null;
    },
    () => null,
  );
}

function liveCell(date: ISODate): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-testid="day-cell"][data-date="${date}"]`)) {
    if (!el.closest('[inert]') && el.isConnected) return el;
  }
  return null;
}

/** Moves keyboard focus to a day's cell, bringing it into view (and mounting it) when needed. */
export function focusCell(date: ISODate): void {
  setActiveCell(date);
  const go = (el: HTMLElement) => {
    el.focus();
    markKeyboardFocused(el);
  };
  const el = liveCell(date);
  if (el) {
    go(el);
    return;
  }
  scrollCalendarTo(date, 'instant');
  let tries = 0;
  const retry = () => {
    const next = liveCell(date);
    if (next) go(next);
    else if (++tries < 30) requestAnimationFrame(retry);
  };
  requestAnimationFrame(retry);
}

/** Arrow keys on a focused day cell: ±1 day, ±1 week. */
export const CELL_STEP: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
