/**
 * Live hit-testing. The drop target is whatever drop container is under the pointer *right now*
 * (elementFromPoint + ancestor walk), so it is correct across scroll containers, while the calendar
 * auto-scrolls, inside the phone sheet, and after the month scroller prepends rows. Item positions are
 * read from the DOM ignoring transforms (sortable shifts), not from rects cached at drag start.
 */
import { getClientRect } from '@dnd-kit/core';
import type { ISODate, Occurrence } from '@shared/types';
import { addDays, isValidISODate } from '@shared/dates';
import type { DropPosition } from '@/store/actions';
import { containerOfNode, itemsOfContainer, listOrderOf, type ContainerEntry } from './registry';
import { dropPositionFor } from './dropPosition';
import type { ActiveDrag, DropHit, Indicator } from './state';

type Rect = ReturnType<typeof getClientRect>;

export interface RenderedItem {
  id: string;
  occ: Occurrence;
  rect: Rect;
}

export function containerAt(x: number, y: number): { entry: ContainerEntry; el: Element } | null {
  if (!Number.isFinite(x) || !Number.isFinite(y) || typeof document === 'undefined') return null;
  let el: Element | null = document.elementFromPoint(x, y);
  while (el) {
    const entry = containerOfNode(el);
    if (entry) return { entry, el };
    el = el.parentElement;
  }
  return null;
}

/** The day cell ([data-date]) under a point, for resize handles and grab offsets. */
export function dayAt(x: number, y: number): ISODate | null {
  const c = containerAt(x, y);
  if (c && c.entry.kind === 'day') return dateOfContainer(c.entry.id);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-testid="day-cell"][data-date]');
  const d = el?.dataset.date;
  return d && isValidISODate(d) ? d : null;
}

export function dateOfContainer(containerId: string): ISODate | null {
  if (!containerId.startsWith('day:')) return null;
  const d = containerId.slice(4);
  return isValidISODate(d) ? d : null;
}

/** Items rendered inside `el` for `containerId`, top to bottom (positions ignore sortable transforms). */
export function renderedItems(containerId: string, el: Element): RenderedItem[] {
  const out: RenderedItem[] = [];
  const seen = new Set<string>();
  for (const it of itemsOfContainer(containerId)) {
    const n = it.node;
    if (!n || !n.isConnected || !el.contains(n) || seen.has(it.id)) continue;
    seen.add(it.id);
    out.push({ id: it.id, occ: it.occ, rect: getClientRect(n, { ignoreTransform: true }) });
  }
  // The list's own order when known (rects can be mid-animation), else top-to-bottom.
  const order = listOrderOf(containerId);
  const rank = new Map<string, number>();
  if (order) order.forEach((id, i) => rank.set(id, i));
  out.sort((a, b) => {
    const ra = rank.get(a.id);
    const rb = rank.get(b.id);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    return a.rect.top - b.rect.top || a.rect.left - b.rect.left;
  });
  return out;
}

/**
 * Vertical-list sorting preview (same maths as dnd-kit's verticalListSortingStrategy): the dragged
 * item takes the slot of `overIdx`, the items in between shift by its height + the list gap.
 */
function sortOffsets(items: RenderedItem[], activeIdx: number, overIdx: number): Record<string, number> {
  const out: Record<string, number> = {};
  const active = items[activeIdx];
  const over = items[overIdx];
  if (!active || !over || activeIdx === overIdx) return out;
  const next = items[activeIdx + 1];
  const prev = items[activeIdx - 1];
  const gap = next ? next.rect.top - active.rect.bottom : prev ? active.rect.top - prev.rect.bottom : 0;
  const shift = active.rect.height + gap;
  items.forEach((it, i) => {
    let dy = 0;
    if (i === activeIdx) dy = activeIdx < overIdx ? over.rect.bottom - active.rect.bottom : over.rect.top - active.rect.top;
    else if (i > activeIdx && i <= overIdx) dy = -shift;
    else if (i < activeIdx && i >= overIdx) dy = shift;
    if (dy !== 0) out[it.id] = dy;
  });
  return out;
}

export interface DropResolution {
  hit: DropHit;
  /** Day drops: the occurrence's new (start) date. Inbox: null. */
  targetDate: ISODate | null;
  /** Neighbors for order keys; undefined for multi-day bars (they lay out by date). */
  pos: DropPosition | undefined;
  /** Dropping here would change nothing. */
  noop: boolean;
  /** Same-container sort: the item the dragged card currently displaces. */
  overId: string | null;
  /** Same-container sort: translateY per item (null when sorting doesn't apply). */
  offsets: Record<string, number> | null;
  indicator: Indicator | null;
  /** Inclusive day range to highlight. */
  range: { start: ISODate; end: ISODate } | null;
  /** The target refuses this occurrence (repeating → Inbox). */
  refused: boolean;
}

const GAP_FALLBACK = 2;

function centerY(r: Rect): number {
  return r.top + r.height / 2;
}

export function resolveDrop(active: ActiveDrag, x: number, y: number): DropResolution | null {
  const c = containerAt(x, y);
  if (!c) return null;
  const { entry, el } = c;
  const date = entry.kind === 'day' ? dateOfContainer(entry.id) : null;
  if (entry.kind === 'day' && date === null) return null;
  const hit: DropHit = { containerId: entry.id, kind: entry.kind, date };
  const occ = active.occ;

  if (entry.kind === 'inbox' && occ.recurring) {
    return { hit, targetDate: null, pos: undefined, noop: false, overId: null, offsets: null, indicator: null, range: null, refused: true };
  }

  if (entry.kind === 'day' && occ.multiDay) {
    const start = addDays(date as ISODate, -active.grabOffset);
    const end = addDays(start, active.span);
    return {
      hit,
      targetDate: start,
      pos: undefined,
      noop: start === occ.date,
      overId: null,
      offsets: null,
      indicator: null,
      range: { start, end },
      refused: false,
    };
  }

  const items = renderedItems(entry.id, el);
  const sortable = active.containerId === entry.id && items.some((i) => i.id === active.id);
  // Where the occurrence currently sits in this container (if it is here at all, under any id).
  const ownIdx = items.findIndex((i) => i.occ.key === occ.key);
  const others = ownIdx >= 0 ? items.filter((_, i) => i !== ownIdx) : items;

  let index: number;
  let overId: string | null = null;
  let offsets: Record<string, number> | null = null;
  if (sortable) {
    // dnd-kit sortable semantics: the card takes the slot of the closest item (arrayMove).
    let best = 0;
    let bestD = Infinity;
    items.forEach((it, i) => {
      const dx = it.rect.left + it.rect.width / 2 - x;
      const dy = centerY(it.rect) - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    overId = items[best]?.id ?? null;
    index = best;
    offsets = sortOffsets(items, items.findIndex((i) => i.id === active.id), best);
  } else {
    index = 0;
    while (index < others.length && centerY((others[index] as RenderedItem).rect) < y) index++;
  }

  const list = others.map((i) => i.occ);
  const { pos, index: eff } = dropPositionFor(list, index, occ, entry.kind);
  const noop = ownIdx >= 0 && eff === ownIdx && (entry.kind === 'inbox' ? occ.date === null : occ.date === date);

  let indicator: Indicator | null = null;
  if (!sortable && !noop && others.length > 0 && (entry.kind === 'inbox' || occ.time == null)) {
    const before = others[eff - 1];
    const after = others[eff];
    const ref = (after ?? before) as RenderedItem;
    let lineY: number;
    if (before && after) lineY = (before.rect.bottom + after.rect.top) / 2;
    else if (after) lineY = after.rect.top - GAP_FALLBACK;
    else lineY = (before as RenderedItem).rect.bottom + GAP_FALLBACK;
    indicator = { x: ref.rect.left, y: lineY, width: ref.rect.width };
  }

  return {
    hit,
    targetDate: date,
    // Nothing rendered under this drop zone (an empty list, or the phone's "Move to Inbox" pill while
    // the sheet's bubbles are off screen): let the action use its default — Inbox top, day bottom.
    pos: others.length > 0 ? pos : undefined,
    noop,
    overId,
    offsets,
    indicator,
    range: date !== null ? { start: date, end: date } : null,
    refused: false,
  };
}
