import { memo, useCallback, useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react';
import { AnimatePresence } from 'motion/react';
import type { ISODate, Occurrence } from '@shared/types';
import { weekDates, weekday } from '@shared/dates';
import { isOverdue } from '@shared/occurrences';
import { useStore } from '@/store/store';
import { useWeekLayout } from '@/store/selectors';
import { cx } from '@/lib/cx';
import { DayCell, type AddMode } from './DayCell';
import { MultiDayBar } from './MultiDayBar';
import { applyPreview, useResizePreviewFor } from './resize';
import { useActiveCellIn } from './roving';
import styles from './Calendar.module.css';

export interface WeekRowProps {
  weekStart: ISODate;
  variant: 'month' | 'week';
  compact: boolean;
  addMode: AddMode;
  /** Desktop/tablet render the inline composer in the cell (phone uses the QuickAddSheet). */
  inlineComposer: boolean;
  resizable: boolean;
  registerRow?: (week: ISODate, el: HTMLDivElement | null) => void;
}

const EMPTY: Occurrence[] = [];

function sameList(a: readonly Occurrence[], b: readonly Occurrence[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Bit i set ⇔ days[i] is outside the visible month (its label dims). */
function dimMaskOf(days: ISODate[], visibleMonth: ISODate): number {
  const ym = visibleMonth.slice(0, 7);
  let mask = 0;
  for (let i = 0; i < days.length; i++) if ((days[i] as ISODate).slice(0, 7) !== ym) mask |= 1 << i;
  return mask;
}

/**
 * One week of the grid: 7 day cells + an overlay with the multi-day bars at their lanes. Each cell
 * reserves the lanes' height above its own cards so bars never cover them: laneCount × --cal-lane-h
 * for one-line bars, the measured height of the lane grid when bars wrap (--lanes-h).
 */
export const WeekRow = memo(function WeekRow({ weekStart, variant, compact, addMode, inlineComposer, resizable, registerRow }: WeekRowProps) {
  const days = useMemo(() => weekDates(weekStart), [weekStart]);
  const first = days[0] as ISODate;
  const last = days[6] as ISODate;
  const base = useWeekLayout(days);
  const preview = useResizePreviewFor(first, last);
  const layout = useMemo(() => (preview ? applyPreview(base, preview) : base), [base, preview]);
  // Per-day structural sharing: a change in one day of the row re-renders only that day's cell.
  const prevSingles = useRef<Record<ISODate, Occurrence[]>>({});
  const singles = useMemo(() => {
    const out: Record<ISODate, Occurrence[]> = {};
    for (const d of days) {
      const next = layout.singles[d] ?? EMPTY;
      const prev = prevSingles.current[d];
      out[d] = prev && sameList(prev, next) ? prev : next;
    }
    return out;
  }, [days, layout]);
  useLayoutEffect(() => {
    prevSingles.current = singles;
  }, [singles]);
  const today = useStore((s) => s.today);
  const activeDay = useActiveCellIn(first, last);
  const dimMask = useStore((s) => (variant === 'month' ? dimMaskOf(days, s.ui.visibleMonth) : 0));
  const composerDate = useStore((s) => {
    const c = s.ui.composer;
    return inlineComposer && c !== null && c.date >= first && c.date <= last ? c.date : null;
  });

  const rowRef = useRef<HTMLDivElement | null>(null);
  const barsRef = useRef<HTMLDivElement | null>(null);
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      rowRef.current = el;
      registerRow?.(weekStart, el);
    },
    [registerRow, weekStart],
  );
  const style = useMemo(() => ({ '--lanes': layout.laneCount }) as CSSProperties, [layout.laneCount]);
  const hasBars = layout.bars.length > 0 || preview !== null;
  // Phone grid, week view and touch screens: multi-day names wrap like every other card (SPEC §1 —
  // every name fully visible; there is no hover tooltip on touch). Desktop month keeps Notion's
  // one-line bar with its tooltip.
  const wrapBars = compact || variant === 'week' || addMode === 'tap';

  // Wrapped bars have content heights: lanes become rows of a grid sized by their tallest bar, and
  // every cell reserves the measured height above its own cards (set before paint; a ResizeObserver
  // follows re-wraps on resize). The scroller's own observer keeps the view still when rows grow.
  useLayoutEffect(() => {
    const row = rowRef.current;
    const bars = barsRef.current;
    if (!row) return;
    if (!wrapBars || !bars) {
      row.style.removeProperty('--lanes-h');
      return;
    }
    let last = '';
    const measure = () => {
      const v = `${bars.offsetHeight}px`;
      if (v === last) return;
      last = v;
      row.style.setProperty('--lanes-h', v);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(bars);
    return () => ro.disconnect();
  }, [wrapBars, hasBars, layout]);

  return (
    <div ref={ref} className={cx(styles.row, variant === 'week' && styles.weekRow)} data-week={weekStart} style={style}>
      {days.map((d, i) => {
        const wd = weekday(d);
        return (
          <DayCell
            key={d}
            date={d}
            occs={singles[d] ?? EMPTY}
            variant={variant}
            dim={(dimMask & (1 << i)) !== 0}
            isToday={d === today}
            today={today}
            weekend={wd === 0 || wd === 6}
            compact={compact}
            composerOpen={composerDate === d}
            addMode={addMode}
            resizable={resizable}
            active={activeDay === d}
          />
        );
      })}
      {hasBars ? (
        <div ref={barsRef} className={cx(styles.bars, wrapBars && styles.barsWrap)}>
          <AnimatePresence initial={false}>
            {layout.bars.map((b) => (
              <MultiDayBar
                key={b.occ.key}
                bar={b}
                segment={weekStart}
                compact={compact}
                wrap={wrapBars}
                overdue={isOverdue(b.occ, today)}
                resizable={resizable}
                tabbable={activeDay !== null && activeDay >= (days[b.startCol] as ISODate) && activeDay <= (days[b.endCol] as ISODate)}
                firstDay={days[b.startCol] as ISODate}
              />
            ))}
          </AnimatePresence>
        </div>
      ) : null}
    </div>
  );
});
