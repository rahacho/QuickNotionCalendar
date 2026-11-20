import { memo, useCallback, useEffect, useRef, type FocusEvent, type ReactNode } from 'react';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { useStore } from '@/store/store';
import { useLayoutMode } from '@/hooks/useLayoutMode';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { DUR, EASE } from '@/lib/motion';
import { CalendarHeader } from './CalendarHeader';
import { MonthScroller } from './MonthScroller';
import { WeekView } from './WeekView';
import { setActiveCell } from './roving';
import styles from './Calendar.module.css';

if (import.meta.env.DEV) void import('./devHooks');

/**
 * The center panel: Notion's full-page calendar. Header + Month scroller or Week view, crossfading
 * when the view switches.
 */
export function CalendarView() {
  const view = useStore((s) => s.ui.view);
  const weekStart = useStore((s) => s.settings.weekStart);
  const mode = useLayoutMode();
  const finePointer = useMediaQuery('(hover: hover) and (pointer: fine)');
  const addMode = finePointer ? 'hover' : 'tap';
  const inlineComposer = mode !== 'phone';
  const resizable = finePointer && mode !== 'phone';
  // Focus leaving the calendar: the next Tab into it starts again at today / the first day shown.
  const onBlur = useCallback((e: FocusEvent<HTMLElement>) => {
    const to = e.relatedTarget;
    if (!(to instanceof Node) || !e.currentTarget.contains(to)) setActiveCell(null);
  }, []);
  // Focus landing on a day, a card or a bar makes that day the keyboard's tab stop. A NATIVE listener:
  // a closing peek / popover hands focus back during React's commit, when React drops synthetic focus
  // events — the card would be focused while its day was not the tab stop, so Shift+Tab / Tab skipped it.
  const rootRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onFocusIn = (e: Event) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      const host = t.closest<HTMLElement>('[data-roving-day], [data-testid="day-cell"][data-date]');
      const day = host?.dataset.rovingDay ?? host?.dataset.date;
      if (day) setActiveCell(day);
    };
    root.addEventListener('focusin', onFocusIn);
    return () => root.removeEventListener('focusin', onFocusIn);
  }, []);

  return (
    <section
      ref={rootRef}
      className={styles.root}
      data-testid="calendar"
      data-layout={mode}
      data-view={view}
      aria-label="Calendar"
      onBlur={onBlur}
    >
      <CalendarHeader mode={mode} view={view} />
      <div className={styles.body}>
        <AnimatePresence initial={false}>
          <Pane key={view === 'month' ? `month-${weekStart}` : `week-${weekStart}`}>
            {view === 'month' ? (
              <MonthScroller weekStart={weekStart} addMode={addMode} inlineComposer={inlineComposer} resizable={resizable} />
            ) : (
              <WeekView weekStart={weekStart} addMode={addMode} inlineComposer={inlineComposer} resizable={resizable} />
            )}
          </Pane>
        </AnimatePresence>
      </div>
    </section>
  );
}

const FADE_IN = { opacity: 1, transition: { duration: DUR.base, ease: EASE } };
const FADE_OUT = { opacity: 0, transition: { duration: DUR.fast, ease: EASE } };

/** Crossfading view pane; while fading out it no longer takes input (and no longer hit-tests for drops). */
const Pane = memo(function Pane({ children }: { children: ReactNode }) {
  const present = useIsPresent();
  return (
    <motion.div
      className={styles.pane}
      initial={{ opacity: 0 }}
      animate={FADE_IN}
      exit={FADE_OUT}
      inert={!present}
      style={present ? undefined : { pointerEvents: 'none' }}
    >
      {children}
    </motion.div>
  );
});
