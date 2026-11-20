import { memo, useCallback, useMemo, type CSSProperties, type KeyboardEvent } from 'react';
import { motion, type Variants } from 'motion/react';
import type { Occurrence, WeekBar } from '@shared/types';
import { TaskCard } from '@/components/card/TaskCard';
import { useBarDraggable } from '@/dnd';
import { useStore } from '@/store/store';
import { cx } from '@/lib/cx';
import { cardKeyDown, openCard } from './cardEvents';
import { ResizeHandles } from './ResizeHandles';
import { useIsResizing } from './resize';
import { exitKindOf } from './cardEvents';
import { setActiveCell } from './roving';
import { EASE } from '@/lib/motion';
import styles from './Calendar.module.css';

function barVariants(occ: Occurrence): Variants {
  return {
    exit: () =>
      exitKindOf(occ) === 'removed'
        ? { opacity: 0, scale: 0.98, transition: { duration: 0.16, ease: EASE } }
        : { opacity: 0, transition: { duration: 0 } },
  };
}

export interface MultiDayBarProps {
  bar: WeekBar;
  /** Week-start date of the row (segment id: a bar crossing rows renders one segment per row). */
  segment: string;
  compact: boolean;
  /** Full name wrapped over as many lines as needed (the lane grows); else one line + ellipsis. */
  wrap: boolean;
  overdue: boolean;
  resizable: boolean;
  /** Covers the keyboard's active day in this row: a Tab stop. */
  tabbable: boolean;
  /** First day of this segment (focus makes it the active day). */
  firstDay: string;
}

/** A multi-day task spanning columns of one week row, on its lane; flat edges where it continues. */
export const MultiDayBar = memo(function MultiDayBar({ bar, segment, compact, wrap, overdue, resizable, tabbable, firstDay }: MultiDayBarProps) {
  const { occ, startCol, endCol, lane, continuesBefore, continuesAfter } = bar;
  const { setNodeRef, attributes, listeners, style } = useBarDraggable(occ, segment);
  // Every segment of the dragged task turns into the faded ghost, not only the one that was grabbed.
  const ghost = useStore((s) => s.ui.dragging !== null && s.ui.dragging.occKey === occ.key);
  const resizing = useIsResizing(occ.key);

  const slotStyle = useMemo<CSSProperties>(
    () =>
      wrap
        ? // A cell of the row's lane grid: the lane is as tall as its tallest bar.
          { gridColumn: `${startCol + 1} / ${endCol + 2}`, gridRow: lane + 1 }
        : ({
            left: `${(startCol / 7) * 100}%`,
            right: `${((6 - endCol) / 7) * 100}%`,
            '--lane': lane,
          } as CSSProperties),
    [wrap, startCol, endCol, lane],
  );
  const variants = useMemo(() => barVariants(occ), [occ]);

  const onClick = useCallback(() => openCard(occ), [occ]);
  const onFocus = useCallback(() => setActiveCell(firstDay), [firstDay]);
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
  const handles = useMemo(
    () => (resizable && !occ.recurring ? <ResizeHandles occ={occ} start={!continuesBefore} end={!continuesAfter} /> : null),
    [resizable, occ, continuesBefore, continuesAfter],
  );

  return (
    <motion.div className={styles.barSlot} style={slotStyle} exit="exit" variants={variants}>
    <TaskCard
      ref={setNodeRef}
      occ={occ}
      variant="bar"
      compact={compact}
      wrap={wrap}
      overdue={overdue}
      continuesBefore={continuesBefore}
      continuesAfter={continuesAfter}
      dragging={ghost}
      data-testid="bar"
      data-roving-day={firstDay}
      className={cx(styles.bar, resizing && styles.barResizing)}
      style={style}
      {...attributes}
      tabIndex={tabbable ? 0 : -1}
      {...pointerListeners}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onClick={onClick}
    >
      {handles}
    </TaskCard>
    </motion.div>
  );
});
