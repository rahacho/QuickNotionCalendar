/** Dev-only stand-ins for the feature panels so the shell + cards can be judged against Notion. */
import { useMemo, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Menu as MenuIcon, Plus, Settings } from 'lucide-react';
import type { ISODate, Occurrence } from '@shared/types';
import { addDays, weekday } from '@shared/dates';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Checkbox } from '@/components/ui/Checkbox';
import { TextInput } from '@/components/ui/TextInput';
import { Icon } from '@/components/ui/Icon';
import { TaskCard } from '@/components/card/TaskCard';
import { cx } from '@/lib/cx';
import { mockOcc } from './mock';
import styles from './Gallery.module.css';

const TODAY = '2026-11-19';
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface MockData {
  singles: Record<ISODate, Occurrence[]>;
  bars: Array<{ occ: Occurrence; start: ISODate; end: ISODate }>;
  overdue: Set<string>;
}

function useMockData(): MockData {
  return useMemo(() => {
    const singles: Record<ISODate, Occurrence[]> = {};
    const add = (o: Occurrence) => {
      (singles[o.date!] ??= []).push(o);
      return o;
    };
    const overdue = new Set<string>();
    add(mockOcc('Dentist appointment', { date: '2026-11-10', time: '15:00' }));
    overdue.add(add(mockOcc('Pay rent', { date: '2026-11-12' })).key);
    add(mockOcc('Renew passport photos', { date: '2026-11-12' }));
    add(mockOcc('Gym', { date: '2026-11-16', recurring: true, time: '18:00' }));
    add(mockOcc('Finish quarterly report draft and send it to Sarah for review', { date: TODAY }));
    add(mockOcc('Call mom', { date: TODAY }));
    add(mockOcc('Gym', { date: TODAY, recurring: true, time: '18:00' }));
    add(mockOcc('Grocery run', { date: '2026-11-20' }));
    add(mockOcc('Water plants', { date: '2026-11-21', recurring: true }));
    add(mockOcc('Thanksgiving dinner prep', { date: '2026-11-26', time: '10:30' }));
    add(mockOcc('Book flights', { date: '2026-12-01' }));
    const trip = mockOcc('Trip to Boston', { date: '2026-11-23', endDate: '2026-11-25' });
    const conf = mockOcc('Design conference', { date: '2026-11-28', endDate: '2026-12-02' });
    return {
      singles,
      bars: [
        { occ: trip, start: '2026-11-23', end: '2026-11-25' },
        { occ: conf, start: '2026-11-28', end: '2026-12-02' },
      ],
      overdue,
    };
  }, []);
}

function dayLabel(d: ISODate): string {
  const [, m, day] = d.split('-').map(Number) as [number, number, number];
  return day === 1 ? `${MONTH_SHORT[m - 1]} ${day}` : String(day);
}

export function MockCalendar({ phone, onMenu, overdueDot }: { phone?: boolean; onMenu?: () => void; overdueDot?: boolean }) {
  const data = useMockData();
  const weeks: ISODate[] = [];
  for (let w = 0; w < 7; w++) weeks.push(addDays('2026-10-26', w * 7));
  const names = phone ? ['M', 'T', 'W', 'T', 'F', 'S', 'S'] : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  return (
    <div className={cx(styles.cal, phone && styles.calCompact)} data-testid="calendar">
      <header className={styles.calHeader}>
        <div className={styles.calTitleWrap}>
          {phone && <IconButton label="Open tasks" icon={MenuIcon} onClick={onMenu} dot={overdueDot} tooltip={false} />}
          <span className={styles.calTitle}>November 2026</span>
        </div>
        <div className={styles.calActions}>
          {!phone && (
            <Button variant="ghost" iconRight={ChevronDown}>
              Month
            </Button>
          )}
          <IconButton label="Previous month" icon={ChevronLeft} size={24} tooltip={false} />
          <Button variant="ghost">Today</Button>
          <IconButton label="Next month" icon={ChevronRight} size={24} tooltip={false} />
        </div>
      </header>
      <div className={styles.weekdays}>
        {names.map((n, i) => (
          <span key={i}>{n}</span>
        ))}
      </div>
      <div className={styles.grid}>
        {weeks.map((ws) => {
          const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
          const rowBars = data.bars
            .filter((b) => b.start <= days[6]! && b.end >= days[0]!)
            .map((b) => {
              const s = b.start < days[0]! ? 0 : days.indexOf(b.start);
              const e = b.end > days[6]! ? 6 : days.indexOf(b.end);
              return { ...b, s, e, before: b.start < days[0]!, after: b.end > days[6]! };
            });
          return (
            <div key={ws} className={styles.week} style={{ ['--lanes' as string]: rowBars.length ? 1 : 0 }}>
              {days.map((d) => {
                const wd = weekday(d);
                const dim = d < '2026-11-01' || d > '2026-11-30';
                return (
                  <div key={d} className={cx(styles.day, (wd === 0 || wd === 6) && styles.weekend)} data-date={d}>
                    <div className={styles.dayHead}>
                      {d === '2026-11-10' && !phone && (
                        <span className={styles.dayAdd}>
                          <Icon icon={Plus} size={14} />
                        </span>
                      )}
                      <span className={cx(styles.dayNum, dim && styles.dim, d === TODAY && styles.today)}>
                        {d === TODAY ? 19 : dayLabel(d)}
                      </span>
                    </div>
                    <div className={styles.dayCards}>
                      {(data.singles[d] ?? []).map((o) => (
                        <TaskCard key={o.key} occ={o} variant={phone ? 'compact' : 'calendar'} overdue={data.overdue.has(o.key)} />
                      ))}
                    </div>
                  </div>
                );
              })}
              {rowBars.map((b) => (
                <TaskCard
                  key={b.occ.key + ws}
                  occ={b.occ}
                  variant="bar"
                  compact={phone}
                  continuesBefore={b.before}
                  continuesAfter={b.after}
                  data-testid="bar"
                  className={styles.barPos}
                  style={{ left: `${(b.s / 7) * 100}%`, right: `${((6 - b.e) / 7) * 100}%` }}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const SIDEBAR_GROUPS: Array<{ id: string; title: string; subtitle?: string; red?: boolean; items: Array<[string, string]> }> = [
  { id: 'overdue', title: 'Overdue', red: true, items: [['Pay rent', 'Nov 12']] },
  {
    id: 'today',
    title: 'Today',
    subtitle: 'Thu, Nov 19',
    items: [
      ['Finish quarterly report draft and send it to Sarah for review', ''],
      ['Call mom', ''],
      ['Gym', '6:00 PM'],
    ],
  },
  { id: 'tomorrow', title: 'Tomorrow', subtitle: 'Fri, Nov 20', items: [['Grocery run', '']] },
  { id: 'sat', title: 'Saturday', subtitle: 'Nov 21', items: [['Water plants', '']] },
];

export function MockTasksSidebar() {
  const [done, setDone] = useState<Record<string, boolean>>({});
  return (
    <div className={styles.sidebar} data-testid="tasks-sidebar">
      <div className={styles.sideHeader}>
        <span>Tasks</span>
      </div>
      <div className={styles.sideScroll}>
        {SIDEBAR_GROUPS.map((g) => (
          <section key={g.id}>
            <div className={styles.groupHeader}>
              <span className={cx(styles.groupTitle, g.red && styles.red)}>{g.title}</span>
              {g.subtitle && <span className={styles.groupSub}>{g.subtitle}</span>}
              {g.red ? (
                <button type="button" className={styles.moveAll}>
                  Move all to today
                </button>
              ) : (
                <span className={styles.groupCount}>{g.items.length}</span>
              )}
            </div>
            {g.items.map(([title, meta]) => {
              const k = g.id + title;
              return (
                <div key={k} className={styles.row}>
                  <Checkbox checked={!!done[k]} onChange={(v) => setDone((s) => ({ ...s, [k]: v }))} aria-label={title} />
                  <span className={cx(styles.rowTitle, done[k] && styles.rowDone)}>{title}</span>
                  {meta && <span className={cx(styles.rowMeta, g.red && styles.red)}>{meta}</span>}
                </div>
              );
            })}
          </section>
        ))}
      </div>
      <div className={styles.sideFooter}>
        <IconButton label="Settings" icon={Settings} size={24} tooltip={false} />
        <span>Synced</span>
      </div>
    </div>
  );
}

export function MockInbox() {
  const items = useMemo(
    () => [
      mockOcc('Call the bank about the card', { date: null }),
      mockOcc('Pick a gift for Ana', { date: null }),
      mockOcc('Research standing desks under $500 with memory presets', { date: null }),
      mockOcc('Email landlord', { date: null }),
    ],
    [],
  );
  return (
    <div className={styles.inbox} data-testid="inbox">
      <div className={styles.sideHeader}>
        <span>Inbox</span>
        <span className={styles.groupCount}>{items.length}</span>
      </div>
      <div className={styles.inboxBody}>
        <TextInput placeholder="Type a task, press Enter" data-testid="inbox-input" />
        <div className={styles.bubbles}>
          {items.map((o) => (
            <TaskCard key={o.key} occ={o} variant="inbox" />
          ))}
        </div>
      </div>
    </div>
  );
}

export function MockInboxSheet() {
  return (
    <div className={styles.inboxSheet} data-testid="inbox-sheet">
      <span className={styles.sheetHandle} />
      <div className={styles.inboxSheetRow}>
        <span>Inbox</span>
        <span className={styles.groupCount}>4</span>
      </div>
    </div>
  );
}
