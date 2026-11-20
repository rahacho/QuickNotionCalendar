import { useState } from 'react';
import { ChevronDown, ChevronLeft } from 'lucide-react';
import type { HM, Occurrence, Reminder } from '@shared/types';
import { formatReminder } from '@shared/format';
import { setReminder } from '@/store/actions';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { usePopoverClose } from '@/components/ui/Popover';
import { IconButton } from '@/components/ui/IconButton';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { cx } from '@/lib/cx';
import { TimeInput } from './TimeInput';
import { sameReminder } from './pickerUtils';
import styles from './Pickers.module.css';

export interface ReminderMenuProps {
  /** The occurrence being edited (its time decides timed vs untimed choices). Reminders apply to the whole task. */
  occ: Occurrence;
  /** Called after a choice is applied. Default: closes the enclosing popover. */
  onDone?: () => void;
}

interface Choice {
  id: string;
  label: string;
  hint?: string;
  reminder: Reminder;
}

const TIMED: Choice[] = [
  { id: 'at-time', label: 'At time of task', reminder: { kind: 'default' } },
  { id: '5m', label: '5 minutes before', reminder: { kind: 'offset', minutes: 5 } },
  { id: '10m', label: '10 minutes before', reminder: { kind: 'offset', minutes: 10 } },
  { id: '15m', label: '15 minutes before', reminder: { kind: 'offset', minutes: 15 } },
  { id: '30m', label: '30 minutes before', reminder: { kind: 'offset', minutes: 30 } },
  { id: '1h', label: '1 hour before', reminder: { kind: 'offset', minutes: 60 } },
  { id: '2h', label: '2 hours before', reminder: { kind: 'offset', minutes: 120 } },
  { id: '1d', label: '1 day before', reminder: { kind: 'offset', minutes: 1440 } },
];

const UNTIMED: Choice[] = [
  { id: 'day-9', label: 'On the day at 9:00 AM', reminder: { kind: 'at', time: '09:00', daysBefore: 0 } },
  { id: 'prev-9', label: '1 day before at 9:00 AM', reminder: { kind: 'at', time: '09:00', daysBefore: 1 } },
];

const DAYS_BEFORE: Array<{ value: number; label: string }> = [
  { value: 0, label: 'On the day' },
  { value: 1, label: '1 day before' },
  { value: 2, label: '2 days before' },
  { value: 3, label: '3 days before' },
  { value: 7, label: '1 week before' },
];

/**
 * Notion-style reminder menu. Timed tasks: at time of task (default) / N minutes–1 day before / None.
 * Untimed tasks: None (default — the morning summary covers them) / on the day at 9:00 AM /
 * 1 day before at 9:00 AM / Custom time… (clock time + days before). Applies immediately (setReminder).
 */
export function ReminderMenu({ occ, onDone }: ReminderMenuProps) {
  const popover = usePopoverClose();
  const done = onDone ?? (() => popover?.close());
  const task = occ.task;
  const current = task.reminder;
  const timed = occ.time != null;
  const [view, setView] = useState<'menu' | 'custom'>('menu');

  const choose = (r: Reminder) => {
    setReminder(task.id, r);
    done();
  };

  if (view === 'custom') {
    return <CustomReminder taskId={task.id} current={current} onBack={() => setView('menu')} onDone={done} />;
  }

  if (timed) {
    const isAtTime = current.kind === 'default' || (current.kind === 'offset' && current.minutes === 0);
    const known = isAtTime || current.kind === 'none' || TIMED.some((c) => sameReminder(c.reminder, current));
    return (
      <Menu className={styles.menu} aria-label="Remind">
        {!known && <MenuItem label={formatReminder(current, true)} selected keepOpen onSelect={done} data-testid="remind-current" />}
        {TIMED.map((c) => (
          <MenuItem
            key={c.id}
            label={c.label}
            selected={c.id === 'at-time' ? isAtTime : sameReminder(c.reminder, current)}
            keepOpen
            onSelect={() => choose(c.reminder)}
            data-testid={`remind-${c.id}`}
          />
        ))}
        <MenuSeparator />
        <MenuItem
          label="None"
          selected={current.kind === 'none'}
          keepOpen
          onSelect={() => choose({ kind: 'none' })}
          data-testid="remind-none"
        />
      </Menu>
    );
  }

  const isNone = current.kind === 'default' || current.kind === 'none' || current.kind === 'offset';
  const preset = UNTIMED.find((c) => sameReminder(c.reminder, current));
  const isCustom = current.kind === 'at' && !preset;
  return (
    <Menu className={styles.menu} aria-label="Remind">
      <MenuItem
        label="None"
        hint="Morning summary"
        selected={isNone}
        keepOpen
        onSelect={() => choose({ kind: 'default' })}
        data-testid="remind-none"
      />
      {UNTIMED.map((c) => (
        <MenuItem
          key={c.id}
          label={c.label}
          selected={preset?.id === c.id}
          keepOpen
          onSelect={() => choose(c.reminder)}
          data-testid={`remind-${c.id}`}
        />
      ))}
      <MenuSeparator />
      <MenuItem
        label="Custom time…"
        hint={isCustom ? formatReminder(current, false) : undefined}
        selected={isCustom}
        keepOpen
        onSelect={() => setView('custom')}
        data-testid="remind-custom"
      />
    </Menu>
  );
}

function CustomReminder({
  taskId,
  current,
  onBack,
  onDone,
}: {
  taskId: string;
  current: Reminder;
  onBack: () => void;
  onDone: () => void;
}) {
  const [time, setTime] = useState<HM>(current.kind === 'at' ? current.time : '09:00');
  const [daysBefore, setDaysBefore] = useState<number>(current.kind === 'at' ? current.daysBefore : 0);
  const options = DAYS_BEFORE.some((d) => d.value === daysBefore)
    ? DAYS_BEFORE
    : [...DAYS_BEFORE, { value: daysBefore, label: `${daysBefore} days before` }].sort((a, b) => a.value - b.value);

  const apply = (t: HM, d: number) => setReminder(taskId, { kind: 'at', time: t, daysBefore: d });

  return (
    <div className={styles.panel} role="group" aria-label="Custom reminder">
      <div className={styles.panelHeader}>
        <IconButton label="Back" icon={ChevronLeft} size={24} tooltip={false} onClick={onBack} />
        <span className={styles.panelTitle}>Custom time</span>
      </div>
      <div className={styles.formRow}>
        <span className={styles.formLabel}>Time</span>
        <TimeInput
          value={time}
          onChange={(t) => {
            setTime(t);
            apply(t, daysBefore);
          }}
          aria-label="Reminder time"
          className={styles.formControl}
          data-testid="remind-custom-time"
        />
      </div>
      <div className={styles.formRow}>
        <span className={styles.formLabel}>Day</span>
        <div className={cx(styles.selectWrap, styles.grow)}>
          <select
            className={styles.select}
            value={daysBefore}
            aria-label="Day of reminder"
            data-testid="remind-custom-days"
            onChange={(e) => {
              const d = Number(e.target.value);
              setDaysBefore(d);
              apply(time, d);
            }}
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <Icon icon={ChevronDown} size={12} className={styles.selectChevron} />
        </div>
      </div>
      <div className={styles.panelFooter}>
        <Button
          variant="primary"
          onClick={() => {
            apply(time, daysBefore);
            onDone();
          }}
          data-testid="remind-custom-done"
        >
          Done
        </Button>
      </div>
    </div>
  );
}
