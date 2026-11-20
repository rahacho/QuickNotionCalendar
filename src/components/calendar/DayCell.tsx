import { memo, useCallback, useMemo, type FocusEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { AnimatePresence, motion, type Variants } from 'motion/react';
import { Plus } from 'lucide-react';
import type { ISODate, Occurrence } from '@shared/types';
import { addDays, parseYMD } from '@shared/dates';
import { MONTH_SHORT, formatDateLong } from '@shared/format';
import { isOverdue } from '@shared/occurrences';
import { openComposer } from '@/store/actions';
import { SortableList, containerIds, dragIds, isRecentSortDrop, useDayDropTarget } from '@/dnd';
import { Icon } from '@/components/ui/Icon';
import { cx } from '@/lib/cx';
import { DUR, EASE } from '@/lib/motion';
import { CalendarCard } from './CalendarCard';
import { InlineComposer } from './InlineComposer';
import { exitKindOf } from './cardEvents';
import { isKeyboardFocused } from './focusOrigin';
import { CELL_STEP, focusCell, setActiveCell } from './roving';
import styles from './Calendar.module.css';

export type AddMode = 'hover' | 'tap';

export interface DayCellProps {
  date: ISODate;
  occs: Occurrence[];
  variant: 'month' | 'week';
  /** Outside the month that dominates the scroller (dimmed date label). */
  dim: boolean;
  isToday: boolean;
  today: ISODate;
  weekend: boolean;
  compact: boolean;
  composerOpen: boolean;
  /** 'hover': fine pointer → hover "+" and double-click. 'tap': touch → tap an empty area. */
  addMode: AddMode;
  resizable: boolean;
  /** The calendar's single keyboard tab stop (roving tabindex). */
  active: boolean;
}

const ENTER = { opacity: 0 };
const SHOWN = { opacity: 1 };
const CARD_TRANSITION = { duration: DUR.base, ease: EASE };

function cardVariants(occ: Occurrence): Variants {
  return {
    // Resolved when the exit starts (store already updated): completed/deleted → Notion fade + shrink;
    // moved elsewhere → gone at once (the card appears in its new place).
    exit: () =>
      exitKindOf(occ) === 'removed'
        ? { opacity: 0, scale: 0.96, transition: { duration: 0.16, ease: EASE } }
        : { opacity: 0, transition: { duration: 0 } },
  };
}

/** ["Dec ", "1"] on the first of a month, ["", "19"] otherwise. */
function dayLabel(date: ISODate): [string, string] {
  const ymd = parseYMD(date);
  if (!ymd) return ['', date];
  const [, m, d] = ymd;
  return [d === 1 ? `${MONTH_SHORT[m - 1] ?? ''} ` : '', String(d)];
}

function isInteractive(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-dnd-draggable], button, textarea, input, a, [data-composer]') !== null;
}

/** One day of the grid: date label, lane spacer for multi-day bars, sortable cards, inline composer. */
export const DayCell = memo(function DayCell({
  date,
  occs,
  variant,
  dim,
  isToday,
  today,
  weekend,
  compact,
  composerOpen,
  addMode,
  resizable,
  active,
}: DayCellProps) {
  const { setNodeRef, isOver } = useDayDropTarget(date);
  const containerId = containerIds.day(date);
  const itemIds = useMemo(() => occs.map((o) => dragIds.cal(o.key)), [occs]);
  const noLayout = isRecentSortDrop(containerId);

  const add = useCallback(() => openComposer(date), [date]);
  const onDoubleClick = useCallback(
    (e: MouseEvent) => {
      if (addMode !== 'hover' || isInteractive(e.target)) return;
      e.preventDefault();
      openComposer(date);
    },
    [addMode, date],
  );
  const onClick = useCallback(
    (e: MouseEvent) => {
      if (addMode !== 'tap' || isInteractive(e.target)) return;
      openComposer(date);
    },
    [addMode, date],
  );

  // Keyboard: arrows move between days, Enter / "n" add a task here. Only for a cell reached with the
  // keyboard — a cell that merely holds focus after a click leaves ← / → to month navigation.
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.target !== e.currentTarget || e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey) return;
      const step = CELL_STEP[e.key];
      if (step !== undefined) {
        if (!isKeyboardFocused(e.currentTarget)) return;
        e.preventDefault();
        focusCell(addDays(date, step));
        return;
      }
      if ((e.key === 'Enter' || e.key === 'n') && !e.repeat && !e.shiftKey) {
        e.preventDefault();
        openComposer(date);
      }
    },
    [date],
  );
  // Focus anywhere inside (a card, the composer) makes this the day the keyboard comes back to.
  const onFocus = useCallback((_e: FocusEvent) => setActiveCell(date), [date]);
  // A click never focuses the cell itself (that would hand ← / → to the grid and scroll it); it still
  // blurs whatever had focus, like clicking any non-focusable area.
  const onMouseDown = useCallback((e: MouseEvent) => {
    if (isInteractive(e.target)) return;
    e.preventDefault();
    const a = document.activeElement;
    if (a instanceof HTMLElement && a !== document.body) a.blur();
  }, []);

  const [prefix, num] = dayLabel(date);

  return (
    <div
      ref={setNodeRef}
      className={cx(styles.cell, weekend && styles.weekend, isOver && styles.over)}
      data-testid="day-cell"
      data-date={date}
      data-today={isToday ? 'true' : undefined}
      role="group"
      aria-label={isToday ? `Today, ${formatDateLong(date)}` : formatDateLong(date)}
      tabIndex={active ? 0 : -1}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      onClick={onClick}
    >
      {variant === 'month' ? (
        <div className={styles.head}>
          {addMode === 'hover' && (
            <button
              type="button"
              className={styles.add}
              data-testid="day-add"
              aria-label={`New task on ${formatDateLong(date)}`}
              // Pointer affordance only: keyboard users add with Enter on the focused day.
              tabIndex={-1}
              onClick={add}
            >
              <Icon icon={Plus} size={20} />
            </button>
          )}
          <span className={cx(styles.num, dim && styles.dim)} aria-hidden="true">
            {prefix}
            {isToday ? <span className={styles.today}>{num}</span> : num}
          </span>
        </div>
      ) : (
        <div className={styles.weekHead} />
      )}
      <div className={styles.lanes} />
      <div className={styles.cards}>
        <SortableList containerId={containerId} itemIds={itemIds}>
          <AnimatePresence initial={false} mode="popLayout">
            {occs.map((o) => (
              <motion.div
                key={o.key}
                className={styles.cardWrap}
                layout={noLayout ? false : 'position'}
                initial={ENTER}
                animate={SHOWN}
                exit="exit"
                variants={cardVariants(o)}
                transition={CARD_TRANSITION}
              >
                <CalendarCard
                  occ={o}
                  containerId={containerId}
                  overdue={isOverdue(o, today)}
                  compact={compact}
                  resizable={resizable}
                  tabbable={active}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        </SortableList>
        {composerOpen && <InlineComposer date={date} />}
        {variant === 'week' && addMode === 'hover' && !composerOpen && (
          <button
            type="button"
            className={styles.newRow}
            data-testid="day-add"
            aria-label={`New task on ${formatDateLong(date)}`}
            tabIndex={-1}
            onClick={add}
          >
            <Icon icon={Plus} size={14} />
            <span>New</span>
          </button>
        )}
      </div>
    </div>
  );
});
