/**
 * Pure drop-position math (unit-tested). `list` is the target container's items in rendered order
 * with the dragged occurrence removed; `index` is where the user is inserting it.
 */
import type { Occurrence } from '@shared/types';
import type { DropPosition } from '@/store/actions';

export interface PositionResult {
  pos: DropPosition;
  /** The effective insertion index after snapping to where the card can really land. */
  index: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/**
 * Inbox: neighbors at `index`.
 * Day: cards render untimed first (by order) then timed (by time, then order), so
 *  - an untimed card can only land inside the untimed prefix (snapped to its end when dropped lower);
 *  - a timed card lands by its time; its order only breaks ties between cards with the same time.
 */
export function dropPositionFor(list: readonly Occurrence[], index: number, active: Occurrence, kind: 'day' | 'inbox'): PositionResult {
  const n = list.length;
  let i = clamp(Number.isFinite(index) ? Math.round(index) : n, 0, n);
  if (kind === 'inbox') {
    return { pos: { prevOrder: list[i - 1]?.order ?? null, nextOrder: list[i]?.order ?? null }, index: i };
  }
  let lo = 0;
  let hi = 0;
  if (active.time == null) {
    while (hi < n && (list[hi] as Occurrence).time == null) hi++;
  } else {
    while (lo < n && ((list[lo] as Occurrence).time == null || (list[lo] as Occurrence).time! < active.time)) lo++;
    hi = lo;
    while (hi < n && (list[hi] as Occurrence).time === active.time) hi++;
  }
  i = clamp(i, lo, hi);
  return {
    pos: {
      prevOrder: i > lo ? (list[i - 1] as Occurrence).order : null,
      nextOrder: i < hi ? (list[i] as Occurrence).order : null,
    },
    index: i,
  };
}
