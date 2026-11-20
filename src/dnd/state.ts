/**
 * Tiny external store for live drag state (who is dragging, which container/day range is targeted,
 * where the insertion line goes). Kept outside zustand so pointer-rate updates never touch the app
 * store; components subscribe with a selector and re-render only when their own boolean flips
 * (e.g. one day cell becoming the drop target).
 */
import { useSyncExternalStore } from 'react';
import type { ISODate, Occurrence } from '@shared/types';
import type { DragSource } from '@/store/store';

export interface ActiveDrag {
  /** dnd-kit draggable id. */
  id: string;
  occ: Occurrence;
  source: DragSource;
  /** Sortable container the drag started in (null for bars and list rows). */
  containerId: string | null;
  /** Multi-day bars: days between the bar's start and the day that was grabbed. */
  grabOffset: number;
  /** Length in days − 1 (multi-day bars keep it when dropped). */
  span: number;
  input: 'mouse' | 'touch' | 'keyboard';
  /** How the overlay renders: the source's look at the source's size. */
  look: 'card' | 'bar';
  compact: boolean;
  /** The grabbed bar shows its name wrapped (phone grid, week view, touch): the overlay does too. */
  wrap: boolean;
}

export interface DropHit {
  containerId: string;
  kind: 'day' | 'inbox';
  date: ISODate | null;
}

export interface Indicator {
  x: number;
  y: number;
  width: number;
}

/** In-container sorting preview: translateY per item id of the drag's own list. */
export interface SortPreview {
  containerId: string;
  offsets: Record<string, number>;
}

export interface DndState {
  active: ActiveDrag | null;
  sort: SortPreview | null;
  /** After a drag ends: the list whose items should (cancel) or must not (drop) animate back. */
  settle: { containerId: string; animate: boolean } | null;
  hit: DropHit | null;
  /** Inclusive day range highlighted as the drop target (bars highlight their whole new span). */
  range: { start: ISODate; end: ISODate } | null;
  /** Cross-container insertion line (viewport coordinates). */
  indicator: Indicator | null;
  /** The current target refuses the drop (repeating occurrence over the Inbox). */
  refused: boolean;
}

const INITIAL: DndState = { active: null, sort: null, settle: null, hit: null, range: null, indicator: null, refused: false };

let state: DndState = INITIAL;
const listeners = new Set<() => void>();

function sameHit(a: DropHit | null, b: DropHit | null): boolean {
  return a === b || (a !== null && b !== null && a.containerId === b.containerId && a.kind === b.kind && a.date === b.date);
}

function sameRange(a: DndState['range'], b: DndState['range']): boolean {
  return a === b || (a !== null && b !== null && a.start === b.start && a.end === b.end);
}

function sameSort(a: SortPreview | null, b: SortPreview | null): boolean {
  if (a === b) return true;
  if (a === null || b === null || a.containerId !== b.containerId) return false;
  const ka = Object.keys(a.offsets);
  if (ka.length !== Object.keys(b.offsets).length) return false;
  for (const k of ka) if (Math.abs((a.offsets[k] ?? 0) - (b.offsets[k] ?? 0)) >= 0.5) return false;
  return true;
}

function sameSettle(a: DndState['settle'], b: DndState['settle']): boolean {
  return a === b || (a !== null && b !== null && a.containerId === b.containerId && a.animate === b.animate);
}

function sameIndicator(a: Indicator | null, b: Indicator | null): boolean {
  return (
    a === b ||
    (a !== null && b !== null && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.width - b.width) < 0.5)
  );
}

export function getDndState(): DndState {
  return state;
}

/** Merges a patch; listeners are notified only when something actually changed. */
export function setDndState(patch: Partial<DndState>): void {
  const next: DndState = { ...state, ...patch };
  if (
    next.active === state.active &&
    sameSort(next.sort, state.sort) &&
    sameSettle(next.settle, state.settle) &&
    sameHit(next.hit, state.hit) &&
    sameRange(next.range, state.range) &&
    sameIndicator(next.indicator, state.indicator) &&
    next.refused === state.refused
  ) {
    return;
  }
  if (sameSort(next.sort, state.sort)) next.sort = state.sort;
  if (sameSettle(next.settle, state.settle)) next.settle = state.settle;
  if (sameHit(next.hit, state.hit)) next.hit = state.hit;
  if (sameRange(next.range, state.range)) next.range = state.range;
  if (sameIndicator(next.indicator, state.indicator)) next.indicator = state.indicator;
  state = next;
  for (const l of listeners) l();
}

/** Back to idle; `settle` (if any) survives so a list can finish animating back. */
export function resetDndState(settle: DndState['settle'] = null): void {
  const next = settle ? { ...INITIAL, settle } : INITIAL;
  if (state === next || (state === INITIAL && !settle)) return;
  state = next;
  for (const l of listeners) l();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Subscribes to a slice of the drag state. The selector must return a primitive or a stable reference. */
export function useDndSelector<T>(selector: (s: DndState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(INITIAL),
  );
}

export { subscribe as subscribeDndState };

// ---------------------------------------------------------------------------------------------
// The sortable container a drag just ended in: dnd-kit animates that list's reorder itself, so the
// calendar skips its own layout animation for that one commit (they would double up).
// ---------------------------------------------------------------------------------------------

let lastSortDrop: { containerId: string | null; at: number } = { containerId: null, at: 0 };

export function markSortDrop(containerId: string | null): void {
  lastSortDrop = { containerId, at: typeof performance !== 'undefined' ? performance.now() : 0 };
}

export function isRecentSortDrop(containerId: string): boolean {
  return lastSortDrop.containerId === containerId && performance.now() - lastSortDrop.at < 150;
}
