import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ISODate } from '@shared/types';
import { addDays, addMonths, parseYMD, startOfMonth, startOfWeek, weekday } from '@shared/dates';
import { MONTH_SHORT, formatDateLong } from '@shared/format';
import { cx } from '@/lib/cx';
import { IconButton } from '@/components/ui/IconButton';
import { MAX_PICK_DATE, MIN_PICK_DATE, WEEKDAY_INITIALS, weekdayOrder } from './pickerUtils';
import styles from './MiniCalendar.module.css';

export interface MiniCalendarProps {
  /** Any date inside the month to show (normalized to its 1st). */
  month: ISODate;
  onMonthChange: (firstOfMonth: ISODate) => void;
  /** Selected date (range start when `rangeEnd` is set). */
  selected: ISODate | null;
  /** Inclusive range end (shown as a band from `selected`). */
  rangeEnd?: ISODate | null;
  onSelect: (date: ISODate) => void;
  today: ISODate;
  weekStart: 0 | 1;
  /** "Today" button. Default: jump to this month and select today. */
  onToday?: () => void;
  /** Days before this are disabled (e.g. a repeat's end must be on/after its start). */
  min?: ISODate | null;
  className?: string;
}

const MIN_MONTH = startOfMonth(MIN_PICK_DATE);
const MAX_MONTH = startOfMonth(MAX_PICK_DATE);

function clampMonth(m: ISODate): ISODate {
  const first = parseYMD(m) ? startOfMonth(m) : MIN_MONTH;
  return first < MIN_MONTH ? MIN_MONTH : first > MAX_MONTH ? MAX_MONTH : first;
}

/**
 * Notion's mini month: "Nov 2026" · Today · ‹ ›, weekday initials, a fixed 6-week grid (no height
 * jumps between months). Selected = accent square with white text; a range is a light band;
 * today = red text; other-month days are dimmed. Arrow keys / Page Up/Down / Home/End move a
 * roving focus (crossing months), Enter/Space picks.
 */
export function MiniCalendar({
  month,
  onMonthChange,
  selected,
  rangeEnd,
  onSelect,
  today,
  weekStart,
  onToday,
  min,
  className,
}: MiniCalendarProps) {
  const first = clampMonth(month);
  const days = useMemo(() => {
    const start = startOfWeek(first, weekStart);
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }, [first, weekStart]);
  const order = weekdayOrder(weekStart);
  const ym = parseYMD(first) ?? [2026, 1, 1];
  const title = `${MONTH_SHORT[ym[1] - 1]} ${ym[0]}`;
  const monthPrefix = first.slice(0, 7);

  const rangeOn = selected !== null && rangeEnd != null && rangeEnd > selected;
  const lo = selected;
  const hi = rangeOn ? (rangeEnd as ISODate) : selected;

  // Roving focus target (keyboard). Falls back to selected/today/1st inside the visible month.
  const [focusDate, setFocusDate] = useState<ISODate | null>(null);
  const kbMove = useRef(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const inMonth = (d: ISODate | null | undefined): d is ISODate => typeof d === 'string' && d.slice(0, 7) === monthPrefix;
  const tabbable = inMonth(focusDate) ? focusDate : inMonth(selected) ? selected : inMonth(today) ? today : first;

  useLayoutEffect(() => {
    if (!kbMove.current || !focusDate) return;
    kbMove.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${focusDate}"]`)?.focus({ preventScroll: true });
  }, [focusDate, first]);

  // Forget a stale keyboard focus when the month is changed with the mouse.
  useEffect(() => {
    if (focusDate && !inMonth(focusDate) && !kbMove.current) setFocusDate(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first]);

  const go = (n: number) => onMonthChange(clampMonth(addMonths(first, n)));
  const disabledDay = (d: ISODate) => (min != null && d < min) || d < MIN_PICK_DATE || d > MAX_PICK_DATE;

  const moveFocus = (to: ISODate) => {
    if (to < MIN_PICK_DATE || to > MAX_PICK_DATE) return;
    kbMove.current = true;
    setFocusDate(to);
    if (!inMonth(to)) onMonthChange(startOfMonth(to));
  };

  const onGridKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const cur = (e.target as HTMLElement).dataset.day;
    if (!cur) return;
    let to: ISODate | null = null;
    switch (e.key) {
      case 'ArrowLeft':
        to = addDays(cur, -1);
        break;
      case 'ArrowRight':
        to = addDays(cur, 1);
        break;
      case 'ArrowUp':
        to = addDays(cur, -7);
        break;
      case 'ArrowDown':
        to = addDays(cur, 7);
        break;
      case 'PageUp':
        to = addMonths(cur, e.shiftKey ? -12 : -1);
        break;
      case 'PageDown':
        to = addMonths(cur, e.shiftKey ? 12 : 1);
        break;
      case 'Home':
        to = startOfWeek(cur, weekStart);
        break;
      case 'End':
        to = addDays(startOfWeek(cur, weekStart), 6);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    moveFocus(to);
  };

  const handleToday = () => {
    if (onToday) onToday();
    else {
      onMonthChange(startOfMonth(today));
      if (!disabledDay(today)) onSelect(today);
    }
  };

  return (
    <div className={cx(styles.root, className)}>
      <div className={styles.header}>
        <span className={styles.title} aria-live="polite">
          {title}
        </span>
        <div className={styles.nav}>
          <button type="button" className={styles.todayBtn} onClick={handleToday}>
            Today
          </button>
          <IconButton label="Previous month" icon={ChevronLeft} size={24} tooltip={false} className={styles.navBtn} onClick={() => go(-1)} disabled={first <= MIN_MONTH} />
          <IconButton label="Next month" icon={ChevronRight} size={24} tooltip={false} className={styles.navBtn} onClick={() => go(1)} disabled={first >= MAX_MONTH} />
        </div>
      </div>
      <div className={styles.weekdays} aria-hidden="true">
        {order.map((wd) => (
          <span key={wd} className={styles.weekday}>
            {WEEKDAY_INITIALS[wd]}
          </span>
        ))}
      </div>
      <div ref={gridRef} className={styles.grid} role="grid" aria-label={title} onKeyDown={onGridKeyDown}>
        {Array.from({ length: 6 }, (_, row) => (
          <div key={row} role="row" className={styles.row}>
            {days.slice(row * 7, row * 7 + 7).map((d) => {
              const isSel = d === lo || (rangeOn && d === hi);
              const inBand = rangeOn && lo !== null && d >= lo && d <= (hi as ISODate);
              const outside = !inMonth(d);
              const dis = disabledDay(d);
              const dayNum = Number(d.slice(8));
              return (
                <div
                  key={d}
                  role="gridcell"
                  aria-selected={isSel || inBand}
                  className={cx(
                    styles.cell,
                    inBand && styles.band,
                    inBand && d === lo && styles.bandStart,
                    inBand && d === hi && styles.bandEnd,
                    inBand && weekday(d) === order[0] && styles.bandRowStart,
                    inBand && weekday(d) === order[6] && styles.bandRowEnd,
                  )}
                >
                  <button
                    type="button"
                    data-day={d}
                    data-testid="mini-day"
                    tabIndex={d === tabbable ? 0 : -1}
                    disabled={dis}
                    aria-label={formatDateLong(d)}
                    aria-current={d === today ? 'date' : undefined}
                    className={cx(
                      styles.day,
                      outside && styles.outside,
                      d === today && styles.today,
                      isSel && styles.selected,
                    )}
                    onClick={() => {
                      setFocusDate(d);
                      onSelect(d);
                    }}
                  >
                    {dayNum}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
