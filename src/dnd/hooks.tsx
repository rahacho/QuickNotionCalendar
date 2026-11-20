import { useCallback, useLayoutEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import { useDraggable } from '@dnd-kit/core';
import type { ISODate, Occurrence } from '@shared/types';
import { containerIds, dragIds, type TaskDragData } from './ids';
import {
  clearListOrder,
  indexItem,
  registerContainer,
  setListOrder,
  setNodeForId,
  unindexItem,
  unregisterContainer,
  type ItemEntry,
} from './registry';
import { useDndSelector } from './state';

export interface DragHandleResult {
  setNodeRef: (el: HTMLElement | null) => void;
  /** Extra (non-contract): the element keyboard focus returns to after a keyboard drag (default: the node). */
  setActivatorNodeRef?: (el: HTMLElement | null) => void;
  attributes: Record<string, unknown>;
  // SPEC §4.4 signature (dnd-kit's synthetic listener map).
  listeners: Record<string, Function> | undefined;
  style: CSSProperties;
  isDragging: boolean;
}

export interface DropTargetResult {
  setNodeRef: (el: HTMLElement | null) => void;
  isOver: boolean;
}

/** The sort shift animates; card hover transitions (normally from the card's class) are kept. */
const SORT_TRANSITION =
  'transform var(--dur) var(--ease), background-color var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease), opacity var(--dur-fast) var(--ease)';

/** iOS: long-press must not select text or open the callout; panning still scrolls until the drag starts. */
const TOUCH_STYLE: CSSProperties = {
  touchAction: 'manipulation',
  WebkitUserSelect: 'none',
  userSelect: 'none',
  WebkitTouchCallout: 'none',
} as CSSProperties;

/**
 * Keeps an item entry (element + occurrence + container) registered for live hit-testing.
 * Returns a callback ref to merge with dnd-kit's.
 */
function useItemRegistration(id: string, occ: Occurrence, containerId: string | null): (el: HTMLElement | null) => void {
  const entryRef = useRef<ItemEntry | null>(null);
  if (entryRef.current === null) entryRef.current = { id, occ, containerId, node: null };
  const entry = entryRef.current;

  useLayoutEffect(() => {
    const prevContainer = entry.containerId;
    const prevId = entry.id;
    entry.occ = occ;
    if (prevId !== id) {
      setNodeForId(prevId, null, entry.node);
      entry.id = id;
    }
    entry.containerId = containerId;
    if (entry.node) {
      indexItem(entry, prevContainer);
      setNodeForId(entry.id, entry.node, null);
    }
  }, [entry, id, occ, containerId]);

  useLayoutEffect(
    () => () => {
      unindexItem(entry);
      setNodeForId(entry.id, null, entry.node);
    },
    [entry],
  );

  return useCallback(
    (el: HTMLElement | null) => {
      if (entry.node === el) return;
      setNodeForId(entry.id, el, entry.node);
      entry.node = el;
      if (el) indexItem(entry, entry.containerId);
      else unindexItem(entry);
    },
    [entry],
  );
}

function useDraggableImpl(
  id: string,
  occ: Occurrence,
  source: TaskDragData['source'],
  containerId: string | null,
  disabled: boolean,
) {
  const data = useMemo<TaskDragData>(() => ({ kind: 'task', occ, source, containerId }), [occ, source, containerId]);
  const d = useDraggable({
    id,
    data: data as unknown as Record<string, unknown>,
    disabled,
    attributes: { roleDescription: 'draggable task' },
  });
  const register = useItemRegistration(id, occ, containerId);
  const dragRef = d.setNodeRef;
  const setNodeRef = useCallback(
    (el: HTMLElement | null) => {
      dragRef(el);
      register(el);
    },
    [dragRef, register],
  );
  const attributes = useMemo<Record<string, unknown>>(() => ({ ...d.attributes, 'data-dnd-draggable': '' }), [d.attributes]);
  return { setNodeRef, setActivatorNodeRef: d.setActivatorNodeRef, attributes, listeners: d.listeners, isDragging: d.isDragging };
}

/**
 * Sortable item (calendar card in a day / Inbox bubble), rendered inside its <SortableList>.
 * The pointer drags a DragOverlay; while it hovers the item's own list, siblings shift to open a gap
 * (translateY from the live sort preview); other lists show an insertion line instead.
 */
export function useSortableTask(a: {
  occ: Occurrence;
  source: 'calendar' | 'inbox';
  containerId: string;
  disabled?: boolean;
}): DragHandleResult {
  const { occ, source, containerId, disabled = false } = a;
  const id = source === 'inbox' ? dragIds.inbox(occ.taskId) : dragIds.cal(occ.key);
  const d = useDraggableImpl(id, occ, source, containerId, disabled);
  const offset = useDndSelector((s) => (s.sort !== null && s.sort.containerId === containerId ? (s.sort.offsets[id] ?? 0) : 0));
  const animate = useDndSelector(
    (s) =>
      (s.active !== null && s.active.containerId === containerId) ||
      (s.settle !== null && s.settle.animate && s.settle.containerId === containerId),
  );
  const style = useMemo<CSSProperties>(
    () => ({
      ...TOUCH_STYLE,
      transform: offset !== 0 ? `translate3d(0, ${offset}px, 0)` : undefined,
      // Durations are tokens: reduced motion zeroes them globally.
      transition: animate ? SORT_TRANSITION : undefined,
    }),
    [offset, animate],
  );
  return { ...d, style };
}

/** Plain draggable (Tasks list row). The row stays in place; the overlay follows the pointer. */
export function useDraggableTask(a: { occ: Occurrence; source: 'list'; disabled?: boolean }): DragHandleResult {
  const d = useDraggableImpl(dragIds.list(a.occ.key), a.occ, a.source, null, a.disabled ?? false);
  return { ...d, style: TOUCH_STYLE };
}

/** Calendar multi-day bar segment (one per week row it crosses — ids are per segment). */
export function useBarDraggable(occ: Occurrence, segment: string, disabled = false): DragHandleResult {
  const d = useDraggableImpl(`${dragIds.cal(occ.key)}#${segment}`, occ, 'calendar', null, disabled);
  return { ...d, style: TOUCH_STYLE };
}

function useContainerRef(id: string, kind: 'day' | 'inbox'): (el: HTMLElement | null) => void {
  const nodeRef = useRef<HTMLElement | null>(null);
  const meta = useRef({ id, kind });
  useLayoutEffect(() => {
    meta.current = { id, kind };
    if (nodeRef.current) registerContainer(nodeRef.current, { id, kind });
  }, [id, kind]);
  useLayoutEffect(
    () => () => {
      if (nodeRef.current) unregisterContainer(nodeRef.current);
    },
    [],
  );
  return useCallback((el: HTMLElement | null) => {
    if (nodeRef.current === el) return;
    if (nodeRef.current) unregisterContainer(nodeRef.current);
    nodeRef.current = el;
    if (el) registerContainer(el, meta.current);
  }, []);
}

/** A day cell drop target. isOver is true for every day the dragged task would cover. */
export function useDayDropTarget(date: ISODate): DropTargetResult {
  const setNodeRef = useContainerRef(containerIds.day(date), 'day');
  const isOver = useDndSelector((s) => s.range !== null && date >= s.range.start && date <= s.range.end);
  return { setNodeRef, isOver };
}

/** An Inbox drop zone (the desktop panel, the phone sheet, the phone "Move to Inbox" pill…). */
export function useInboxDropTarget(): DropTargetResult {
  const setNodeRef = useContainerRef(containerIds.inbox, 'inbox');
  const isOver = useDndSelector((s) => s.hit !== null && s.hit.kind === 'inbox');
  return { setNodeRef, isOver };
}

/**
 * Vertical sortable list of task items (a day's cards, the Inbox bubbles). Publishes the rendered
 * order (item ids, as returned by dragIds) used to compute drop positions and the sort preview.
 */
export function SortableList(props: { containerId: string; itemIds: string[]; children: ReactNode }) {
  const { containerId, itemIds } = props;
  useLayoutEffect(() => {
    setListOrder(containerId, itemIds);
    return () => clearListOrder(containerId, itemIds);
  }, [containerId, itemIds]);
  return <>{props.children}</>;
}
