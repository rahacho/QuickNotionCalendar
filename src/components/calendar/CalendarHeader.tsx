import { memo, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Menu as MenuIcon } from 'lucide-react';
import type { ISODate } from '@shared/types';
import { addDays, parseYMD, startOfWeek } from '@shared/dates';
import { MONTH_SHORT, formatMonthYear } from '@shared/format';
import type { LayoutMode } from '@/store/store';
import { useStore } from '@/store/store';
import { goNext, goPrev, goToday, setDrawer, setView } from '@/store/actions';
import { useTaskGroups } from '@/store/selectors';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Popover } from '@/components/ui/Popover';
import { Menu, MenuItem } from '@/components/ui/Menu';
import { Icon } from '@/components/ui/Icon';
import { cx } from '@/lib/cx';
import styles from './Calendar.module.css';

/** "Nov 16 – 22, 2026" · "Nov 30 – Dec 6, 2026" · "Dec 28, 2026 – Jan 3, 2027" */
export function formatWeekTitle(ws: ISODate): string {
  const we = addDays(ws, 6);
  const a = parseYMD(ws);
  const b = parseYMD(we);
  if (!a || !b) return ws;
  const [y1, m1, d1] = a;
  const [y2, m2, d2] = b;
  const ma = MONTH_SHORT[m1 - 1] ?? '';
  const mb = MONTH_SHORT[m2 - 1] ?? '';
  if (y1 !== y2) return `${ma} ${d1}, ${y1} – ${mb} ${d2}, ${y2}`;
  if (m1 !== m2) return `${ma} ${d1} – ${mb} ${d2}, ${y2}`;
  return `${ma} ${d1} – ${d2}, ${y1}`;
}

function useOverdueCount(): number {
  const groups = useTaskGroups();
  return groups.find((g) => g.id === 'overdue')?.count ?? 0;
}

/**
 * Notion calendar header: title left; right cluster "Month ⌄" · ‹ · Today · ›.
 * Phone: ☰ (Tasks drawer, red dot when something is overdue) + title that opens the view menu.
 */
export const CalendarHeader = memo(function CalendarHeader({ mode, view }: { mode: LayoutMode; view: 'month' | 'week' }) {
  const visibleMonth = useStore((s) => s.ui.visibleMonth);
  const weekAnchor = useStore((s) => s.ui.weekAnchor);
  const weekStart = useStore((s) => s.settings.weekStart);
  const overdueCount = useOverdueCount();
  const overdue = overdueCount > 0;
  const [menuOpen, setMenuOpen] = useState(false);
  const viewBtn = useRef<HTMLButtonElement>(null);
  const phone = mode === 'phone';
  const title = view === 'month' ? formatMonthYear(visibleMonth) : formatWeekTitle(startOfWeek(weekAnchor, weekStart));
  const unit = view === 'month' ? 'month' : 'week';

  return (
    <header className={cx(styles.header, phone && styles.headerPhone)}>
      <div className={styles.headerLeft}>
        {phone && (
          <IconButton
            label="Open tasks"
            aria-label={overdue ? `Open tasks, ${overdueCount} overdue` : 'Open tasks'}
            icon={MenuIcon}
            onClick={() => setDrawer(true)}
            data-testid="drawer-toggle"
            dot={overdue}
            tooltip={false}
            className={styles.menuButton}
          />
        )}
        {phone ? (
          <button
            ref={viewBtn}
            type="button"
            className={cx(styles.titleButton, menuOpen && styles.titleButtonActive)}
            onClick={() => setMenuOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`${title}, change view`}
            data-testid="cal-view"
          >
            <span className={styles.title} data-testid="cal-title">
              {title}
            </span>
            <Icon icon={ChevronDown} size={14} className={styles.titleChevron} />
          </button>
        ) : (
          <h2 className={styles.title} data-testid="cal-title">
            {title}
          </h2>
        )}
      </div>
      <div className={styles.actions}>
        {!phone && (
          <Button
            ref={viewBtn}
            variant="ghost"
            iconRight={ChevronDown}
            active={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            data-testid="cal-view"
            className={styles.viewButton}
          >
            {view === 'month' ? 'Month' : 'Week'}
          </Button>
        )}
        <IconButton
          label={`Previous ${unit}`}
          icon={ChevronLeft}
          size={24}
          onClick={goPrev}
          hint="←"
          tooltip={!phone}
          data-testid="cal-prev"
          data-dnd-flip="prev"
          className={styles.navButton}
        />
        <Button variant="ghost" onClick={goToday} data-testid="cal-today" className={styles.todayButton}>
          Today
        </Button>
        <IconButton
          label={`Next ${unit}`}
          icon={ChevronRight}
          size={24}
          onClick={goNext}
          hint="→"
          tooltip={!phone}
          data-testid="cal-next"
          data-dnd-flip="next"
          className={styles.navButton}
        />
      </div>
      <Popover
        open={menuOpen}
        onOpenChange={setMenuOpen}
        anchor={viewBtn}
        placement={phone ? 'bottom-start' : 'bottom-end'}
        role="none"
        width={phone ? 200 : 180}
      >
        <Menu aria-label="Calendar view">
          <MenuItem label="Month" hint={phone ? undefined : 'M'} selected={view === 'month'} onSelect={() => setView('month')} />
          <MenuItem label="Week" hint={phone ? undefined : 'W'} selected={view === 'week'} onSelect={() => setView('week')} />
        </Menu>
      </Popover>
    </header>
  );
});
