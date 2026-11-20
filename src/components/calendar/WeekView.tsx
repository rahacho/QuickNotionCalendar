import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useIsPresent, type Variants } from 'motion/react';
import type { ISODate } from '@shared/types';
import { startOfWeek, weekDates, weekday } from '@shared/dates';
import { WEEKDAY_SHORT } from '@shared/format';
import { useStore } from '@/store/store';
import { registerCalendarScroller } from '@/dnd';
import { cx } from '@/lib/cx';
import { DUR, EASE } from '@/lib/motion';
import { WeekRow } from './WeekRow';
import type { AddMode } from './DayCell';
import { useCompactDensity } from './useCompactDensity';
import styles from './Calendar.module.css';

export interface WeekViewProps {
  weekStart: 0 | 1;
  addMode: AddMode;
  inlineComposer: boolean;
  resizable: boolean;
}

const paneVariants: Variants = {
  enter: (dir: number) => ({ x: dir * 24, opacity: 0 }),
  center: { x: 0, opacity: 1, transition: { duration: DUR.base, ease: EASE } },
  exit: (dir: number) => ({ x: dir * -24, opacity: 0, transition: { duration: DUR.base, ease: EASE } }),
};

/** One week as 7 tall columns; ‹ › slide the week in from the side it comes from. */
export const WeekView = memo(function WeekView(props: WeekViewProps) {
  const anchor = useStore((s) => s.ui.weekAnchor);
  const ws = startOfWeek(anchor, props.weekStart);
  // Direction of the last change, derived during render (React's "adjust state on prop change").
  const [nav, setNav] = useState({ ws, dir: 0 });
  if (nav.ws !== ws) setNav({ ws, dir: ws > nav.ws ? 1 : -1 });
  const dir = nav.ws === ws ? nav.dir : ws > nav.ws ? 1 : -1;

  return (
    <div className={styles.weekRoot}>
      <AnimatePresence initial={false} custom={dir}>
        <WeekPane
          key={ws}
          ws={ws}
          dir={dir}
          addMode={props.addMode}
          inlineComposer={props.inlineComposer}
          resizable={props.resizable}
        />
      </AnimatePresence>
    </div>
  );
});

function WeekPane({
  ws,
  dir,
  addMode,
  inlineComposer,
  resizable,
}: Omit<WeekViewProps, 'weekStart'> & { ws: ISODate; dir: number }) {
  const present = useIsPresent();
  const scrollRef = useRef<HTMLDivElement>(null);
  const compact = useCompactDensity(scrollRef);

  useEffect(() => {
    const el = scrollRef.current;
    if (!present || !el) return;
    return registerCalendarScroller(el);
  }, [present]);

  return (
    <motion.div
      className={styles.weekPane}
      custom={dir}
      variants={paneVariants}
      initial="enter"
      animate="center"
      exit="exit"
      inert={!present}
      style={present ? undefined : { pointerEvents: 'none' }}
    >
      <WeekHeaderRow ws={ws} compact={compact} />
      <div
        ref={scrollRef}
        className={cx(styles.weekScroll, compact && styles.compact)}
        data-density={compact ? 'compact' : 'regular'}
        data-cal-scroller=""
      >
        <div className={styles.weekGrid}>
          <WeekRow
            weekStart={ws}
            variant="week"
            compact={compact}
            addMode={addMode}
            inlineComposer={inlineComposer}
            resizable={resizable}
          />
        </div>
      </div>
    </motion.div>
  );
}

const WeekHeaderRow = memo(function WeekHeaderRow({ ws, compact }: { ws: ISODate; compact: boolean }) {
  const days = useMemo(() => weekDates(ws), [ws]);
  const today = useStore((s) => s.today);
  return (
    <div className={cx(styles.weekHeader, compact && styles.compact)}>
      {days.map((d) => {
        const wd = weekday(d);
        const isToday = d === today;
        const name = WEEKDAY_SHORT[wd] ?? '';
        return (
          <div key={d} className={styles.weekHeaderCell}>
            <span className={styles.weekHeaderName}>{compact ? name.charAt(0) : name}</span>
            <span className={cx(styles.weekHeaderNum, isToday && styles.weekHeaderToday)} data-today={isToday ? 'true' : undefined}>
              {Number(d.slice(8))}
            </span>
          </div>
        );
      })}
    </div>
  );
});
