import { memo, useCallback, useMemo, type KeyboardEvent } from 'react';
import type { Occurrence } from '@shared/types';
import { TaskCard } from '@/components/card/TaskCard';
import { useSortableTask } from '@/dnd';
import { cardKeyDown, openCard } from './cardEvents';
import { ResizeHandles } from './ResizeHandles';

export interface CalendarCardProps {
  occ: Occurrence;
  containerId: string;
  overdue: boolean;
  compact: boolean;
  /** Desktop (fine pointer) + one-time task → 6px resize edges. */
  resizable: boolean;
  /** In the keyboard's active day (roving tabindex): a Tab stop. Else reachable by arrows → Tab. */
  tabbable: boolean;
}

/** A single-day task card inside a day cell: sortable, opens the peek, resizable on desktop. */
export const CalendarCard = memo(function CalendarCard({ occ, containerId, overdue, compact, resizable, tabbable }: CalendarCardProps) {
  const { setNodeRef, attributes, listeners, style, isDragging } = useSortableTask({ occ, source: 'calendar', containerId });

  const onClick = useCallback(() => openCard(occ), [occ]);
  const keyListener = listeners?.onKeyDown as ((e: KeyboardEvent<HTMLElement>) => void) | undefined;
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      keyListener?.(e);
      cardKeyDown(e, occ);
    },
    [keyListener, occ],
  );
  const pointerListeners = useMemo(() => {
    if (!listeners) return undefined;
    const { onKeyDown: _ignored, ...rest } = listeners;
    return rest;
  }, [listeners]);
  const handles = useMemo(() => (resizable && !occ.recurring ? <ResizeHandles occ={occ} /> : null), [resizable, occ]);

  return (
    <TaskCard
      ref={setNodeRef}
      occ={occ}
      variant={compact ? 'compact' : 'calendar'}
      overdue={overdue}
      dragging={isDragging}
      style={style}
      {...attributes}
      tabIndex={tabbable ? 0 : -1}
      {...pointerListeners}
      onKeyDown={onKeyDown}
      onClick={onClick}
    >
      {handles}
    </TaskCard>
  );
});
