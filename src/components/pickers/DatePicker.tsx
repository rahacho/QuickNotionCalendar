import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import type { Placement } from '@floating-ui/react';
import { ChevronLeft, ChevronRight, Repeat } from 'lucide-react';
import type { HM, ISODate, Occurrence, OccurrenceRef } from '@shared/types';
import { startOfMonth } from '@shared/dates';
import { describeRecurrence } from '@shared/recurrence';
import { formatDateLong, formatTime, parseDateInput } from '@shared/format';
import { useStore } from '@/store/store';
import { setSchedule, setSeriesTime } from '@/store/actions';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useLayoutMode } from '@/hooks/useLayoutMode';
import { cx } from '@/lib/cx';
import { Popover, usePopoverClose, type PopoverAnchor } from '@/components/ui/Popover';
import { Sheet } from '@/components/ui/Sheet';
import { Toggle } from '@/components/ui/Toggle';
import { Tooltip } from '@/components/ui/Tooltip';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { MiniCalendar } from './MiniCalendar';
import { TimeInput } from './TimeInput';
import { RepeatEditor } from './RepeatEditor';
import { ReminderMenu } from './ReminderMenu';
import { defaultTimeFor, isPickableDate, reminderValueLabel, shake } from './pickerUtils';
import styles from './DatePicker.module.css';

export interface DatePickerProps {
  /** The occurrence being scheduled. A recurring occurrence is edited on its own ("Only this occurrence"). */
  occ: Occurrence;
  /** Ask the container to close (after Clear). Default: closes the enclosing popover. */
  onRequestClose?: () => void;
  /** Receives the Start <input> (the popover focuses it on desktop). */
  startInputRef?: Ref<HTMLInputElement>;
  /** 'sheet' = roomier paddings for a full-width bottom sheet. */
  variant?: 'popover' | 'sheet';
}

type Sub = 'repeat' | 'remind';

/**
 * Notion's date picker. Start (and End) text fields, a mini month, then End date / Include time
 * toggles, Repeat › and Remind › submenus and Clear. Every change applies immediately (no Save):
 * non-recurring → task fields; recurring → only this occurrence (override). When a repeating
 * occurrence's time differs from its series', "Use 7:00 AM for every repeat" applies it to the whole
 * series (setSeriesTime). Clear sends the task to the Inbox (not available for repeating tasks).
 */
export function DatePicker({ occ, onRequestClose, startInputRef, variant = 'popover' }: DatePickerProps) {
  const today = useStore((s) => s.today);
  const weekStart = useStore((s) => s.settings.weekStart);
  const coarse = useMediaQuery('(pointer: coarse)');
  const popover = usePopoverClose();
  const close = onRequestClose ?? (() => popover?.close());

  const ref: OccurrenceRef = useMemo(() => ({ taskId: occ.taskId, origDate: occ.origDate }), [occ.taskId, occ.origDate]);
  const recurring = occ.recurring;
  const start = occ.date;
  const end = occ.multiDay ? occ.endDate : null;
  const timed = occ.time != null;

  const [month, setMonth] = useState<ISODate>(() => startOfMonth(start ?? today));
  const [endOn, setEndOn] = useState(occ.multiDay);
  const [active, setActive] = useState<'start' | 'end'>('start');
  const [sub, setSub] = useState<Sub | null>(null);
  const repeatRow = useRef<HTMLButtonElement>(null);
  const remindRow = useRef<HTMLButtonElement>(null);

  // Follow remote changes: a task that became multi-day shows its range; repeating tasks can't.
  useEffect(() => {
    if (occ.multiDay) setEndOn(true);
  }, [occ.multiDay]);
  useEffect(() => {
    if (recurring) setEndOn(false);
  }, [recurring]);
  const showEnd = endOn && !recurring;

  const schedule = (s: { date: ISODate | null; endDate?: ISODate | null; time?: HM | null }) => setSchedule(ref, s);

  /** Sets the start (End date on: keeps the end when still valid, else collapses to one day). */
  const pickStart = (d: ISODate) => {
    if (recurring) schedule({ date: d });
    else if (!showEnd) schedule({ date: d, endDate: null });
    else schedule({ date: d, endDate: end !== null && d <= end ? end : null });
  };

  /** Sets the end; an end before the start becomes the new start (the end stays put). */
  const pickEnd = (d: ISODate) => {
    if (start === null) {
      schedule({ date: d, endDate: null });
      return;
    }
    if (d >= start) schedule({ date: start, endDate: d });
    else schedule({ date: d, endDate: end ?? start });
  };

  const onDayClick = (d: ISODate) => {
    if (!showEnd) {
      pickStart(d);
      return;
    }
    if (active === 'start' || start === null) {
      pickStart(d);
      setActive('end');
    } else {
      pickEnd(d);
    }
  };

  const toggleEnd = (on: boolean) => {
    if (recurring) return;
    setEndOn(on);
    setActive(on ? 'end' : 'start');
    if (!on && occ.multiDay && start !== null) schedule({ date: start, endDate: null });
  };

  const toggleTime = (on: boolean) => {
    const d = start ?? today;
    if (on) schedule({ date: d, time: occ.time ?? defaultTimeFor(d, today) });
    else if (start !== null) schedule({ date: start, time: null });
  };

  const clear = () => {
    if (recurring || start === null) return;
    schedule({ date: null });
    close();
  };

  const task = occ.task;
  /** This occurrence's time differs from the series': offer to apply it to every repeat (and its alerts). */
  const seriesTimeDiffers = recurring && (occ.time ?? null) !== (task.time ?? null);
  const repeatHint = task.recurrence && task.date ? describeRecurrence(task.recurrence, task.date) : 'Never';
  const remindHint = reminderValueLabel(task.reminder, timed);
  const repeatDisabled = showEnd || occ.multiDay;

  // Phone: submenus replace the picker body (a side popover has no room).
  if (coarse && sub !== null) {
    return (
      <div className={cx(styles.root, variant === 'sheet' && styles.inSheet)}>
        <div className={styles.subHeader}>
          <IconButton label="Back" icon={ChevronLeft} size={28} tooltip={false} onClick={() => setSub(null)} />
          <span className={styles.subTitle}>{sub === 'repeat' ? 'Repeat' : 'Remind'}</span>
        </div>
        {sub === 'repeat' ? (
          <RepeatEditor occ={occ} onDone={() => setSub(null)} />
        ) : (
          <ReminderMenu occ={occ} onDone={() => setSub(null)} />
        )}
      </div>
    );
  }

  const submenu = (which: Sub, anchor: RefObject<HTMLButtonElement | null>, content: ReactNode) =>
    coarse ? null : (
      <Popover
        open={sub === which}
        onOpenChange={(o) => setSub((cur) => (o ? which : cur === which ? null : cur))}
        anchor={anchor}
        placement="right-start"
        offset={6}
        role="none"
        aria-label={which === 'repeat' ? 'Repeat' : 'Remind'}
        data-testid={`${which}-menu`}
      >
        {content}
      </Popover>
    );

  return (
    <div className={cx(styles.root, variant === 'sheet' && styles.inSheet)}>
      <div className={styles.fields}>
        <div className={styles.fieldRow}>
          <DateField
            value={start}
            today={today}
            active={showEnd && active === 'start'}
            placeholder={showEnd ? 'Start date' : 'Type a date'}
            aria-label={showEnd ? 'Start date' : 'Date'}
            data-testid="date-start-input"
            inputRef={startInputRef}
            onFocus={() => setActive('start')}
            onPreview={(d) => setMonth(startOfMonth(d))}
            onCommit={(d) => {
              pickStart(d);
              setMonth(startOfMonth(d));
              if (showEnd) setActive('end');
            }}
          />
          {timed && (
            <TimeInput
              value={occ.time}
              onChange={(t) => schedule({ date: start ?? today, time: t })}
              aria-label="Time"
              className={styles.time}
              data-testid="date-time-input"
            />
          )}
        </div>
        {showEnd && (
          <div className={styles.fieldRow}>
            <DateField
              value={end ?? start}
              today={today}
              active={active === 'end'}
              placeholder="End date"
              aria-label="End date"
              data-testid="date-end-input"
              onFocus={() => setActive('end')}
              onPreview={(d) => setMonth(startOfMonth(d))}
              onCommit={(d) => {
                pickEnd(d);
                setMonth(startOfMonth(d));
              }}
            />
          </div>
        )}
        {recurring && (
          <div className={styles.caption} data-testid="date-occurrence-caption">
            <Icon icon={Repeat} size={12} />
            <span>Only this occurrence</span>
          </div>
        )}
        {recurring && seriesTimeDiffers && (
          <button
            type="button"
            className={styles.seriesTime}
            data-testid="date-series-time"
            onClick={() => setSeriesTime(occ.taskId, occ.time)}
          >
            {occ.time ? `Use ${formatTime(occ.time)} for every repeat` : 'Remove the time from every repeat'}
          </button>
        )}
      </div>

      <MiniCalendar
        className={styles.calendar}
        month={month}
        onMonthChange={setMonth}
        selected={start}
        rangeEnd={showEnd ? end : null}
        onSelect={onDayClick}
        onToday={() => {
          setMonth(startOfMonth(today));
          onDayClick(today);
        }}
        today={today}
        weekStart={weekStart}
      />

      <div className={styles.divider} role="separator" />

      <div className={styles.rows}>
        <ToggleRow
          label="End date"
          checked={showEnd}
          disabled={recurring}
          tooltip={recurring ? 'Repeating tasks can’t span several days' : undefined}
          onChange={toggleEnd}
          data-testid="date-end-toggle"
        />
        <ToggleRow label="Include time" checked={timed} onChange={toggleTime} data-testid="date-time-toggle" />
        <SubmenuRow
          rowRef={repeatRow}
          label="Repeat"
          hint={repeatHint}
          open={sub === 'repeat'}
          disabled={repeatDisabled}
          tooltip={repeatDisabled ? 'Multi-day tasks can’t repeat' : undefined}
          onOpen={() => setSub((cur) => (cur === 'repeat' ? null : 'repeat'))}
          data-testid="date-repeat"
        />
        <SubmenuRow
          rowRef={remindRow}
          label="Remind"
          hint={remindHint}
          open={sub === 'remind'}
          onOpen={() => setSub((cur) => (cur === 'remind' ? null : 'remind'))}
          data-testid="date-remind"
        />
      </div>

      <div className={styles.divider} role="separator" />

      <div className={styles.rows}>
        <Tooltip content={recurring ? 'Repeating tasks can’t move to the Inbox' : undefined} placement="right">
          <button
            type="button"
            className={cx(styles.row, styles.clear, (recurring || start === null) && styles.rowDisabled)}
            aria-disabled={recurring || start === null || undefined}
            onClick={clear}
            data-testid="date-clear"
          >
            Clear
          </button>
        </Tooltip>
      </div>

      {submenu('repeat', repeatRow, <RepeatEditor occ={occ} onDone={() => setSub(null)} />)}
      {submenu('remind', remindRow, <ReminderMenu occ={occ} onDone={() => setSub(null)} />)}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

interface DateFieldProps {
  value: ISODate | null;
  today: ISODate;
  onCommit: (d: ISODate) => void;
  onPreview?: (d: ISODate) => void;
  onFocus?: () => void;
  active?: boolean;
  placeholder: string;
  'aria-label': string;
  'data-testid': string;
  inputRef?: Ref<HTMLInputElement>;
}

/** Text date entry: "tomorrow", "fri", "Nov 21", "11/21"… Enter/blur applies; Enter on nonsense shakes and reverts. */
function DateField({ value, today, onCommit, onPreview, onFocus, active, placeholder, inputRef, ...aria }: DateFieldProps) {
  const shown = value ? formatDateLong(value) : '';
  const [draft, setDraft] = useState(shown);
  const [editing, setEditing] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editing) setDraft(shown);
  }, [shown, editing]);

  const parse = (s: string): ISODate | null => {
    const d = parseDateInput(s, today);
    return isPickableDate(d) ? d : null;
  };

  const commit = (fromEnter: boolean) => {
    const text = draft.trim();
    if (text === shown || (text === '' && value === null)) {
      if (text !== draft) setDraft(shown);
      return;
    }
    const d = parse(text);
    if (d) {
      setDraft(formatDateLong(d));
      if (d !== value) onCommit(d);
      return;
    }
    if (fromEnter) shake(boxRef.current);
    setDraft(shown);
  };

  return (
    <div ref={boxRef} className={cx(styles.field, active && styles.fieldActive)}>
      <input
        ref={inputRef}
        className={styles.input}
        type="text"
        value={draft}
        placeholder={placeholder}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        enterKeyHint="done"
        aria-label={aria['aria-label']}
        data-testid={aria['data-testid']}
        onFocus={(e) => {
          setEditing(true);
          onFocus?.();
          e.currentTarget.select();
        }}
        onChange={(e) => {
          setDraft(e.target.value);
          const d = parse(e.target.value);
          if (d) onPreview?.(d);
        }}
        onBlur={() => {
          setEditing(false);
          commit(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            commit(true);
          }
        }}
      />
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  disabled,
  tooltip,
  onChange,
  'data-testid': testId,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  tooltip?: string;
  onChange: (next: boolean) => void;
  'data-testid'?: string;
}) {
  const row = (
    <div
      className={cx(styles.row, disabled && styles.rowDisabled)}
      onClick={() => {
        if (!disabled) onChange(!checked);
      }}
    >
      <span className={styles.rowLabel}>{label}</span>
      <Toggle checked={checked} disabled={disabled} onChange={onChange} aria-label={label} data-testid={testId} />
    </div>
  );
  return tooltip ? (
    <Tooltip content={tooltip} placement="right">
      {row}
    </Tooltip>
  ) : (
    row
  );
}

function SubmenuRow({
  rowRef,
  label,
  hint,
  open,
  disabled,
  tooltip,
  onOpen,
  'data-testid': testId,
}: {
  rowRef: RefObject<HTMLButtonElement | null>;
  label: string;
  hint: string;
  open: boolean;
  disabled?: boolean;
  tooltip?: string;
  onOpen: () => void;
  'data-testid'?: string;
}) {
  const btn = (
    <button
      ref={rowRef}
      type="button"
      className={cx(styles.row, open && styles.rowOpen, disabled && styles.rowDisabled)}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-disabled={disabled || undefined}
      data-testid={testId}
      onClick={() => {
        if (!disabled) onOpen();
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' && !disabled && !open) {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <span className={styles.rowLabel}>{label}</span>
      <span className={styles.rowHint} title={hint}>
        {hint}
      </span>
      <Icon icon={ChevronRight} size={14} className={styles.rowChevron} />
    </button>
  );
  return tooltip ? (
    <Tooltip content={tooltip} placement="right">
      {btn}
    </Tooltip>
  ) : (
    btn
  );
}

// ---------------------------------------------------------------------------------------------

export interface DatePickerPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchor: PopoverAnchor;
  /** null closes it (e.g. the task disappeared). */
  occ: Occurrence | null;
  placement?: Placement;
}

/**
 * The date picker in its Notion popover (260px; a little wider on touch). On phones it opens as a
 * bottom sheet instead (no room for a 600px-tall popover next to its row). data-testid="date-picker".
 */
export function DatePickerPopover({ open, onOpenChange, anchor, occ, placement = 'bottom-start' }: DatePickerPopoverProps) {
  const coarse = useMediaQuery('(pointer: coarse)');
  const phone = useLayoutMode() === 'phone';
  const startRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const close = () => onOpenChange(false);
  if (phone) {
    return (
      <Sheet open={open && occ !== null} onClose={close} labelledBy={titleId} data-testid="date-picker">
        <div className={styles.sheetHeader}>
          <span id={titleId} className={styles.sheetTitle}>
            Date
          </span>
          <button type="button" className={styles.sheetDone} onClick={close} data-testid="date-picker-done">
            Done
          </button>
        </div>
        {occ && <DatePicker occ={occ} onRequestClose={close} variant="sheet" />}
      </Sheet>
    );
  }
  return (
    <Popover
      open={open && occ !== null}
      onOpenChange={onOpenChange}
      anchor={anchor}
      placement={placement}
      width={coarse ? 304 : 260}
      initialFocus={coarse ? -1 : startRef}
      aria-label="Date"
      data-testid="date-picker"
      className={styles.popover}
    >
      {occ && <DatePicker occ={occ} startInputRef={startRef} onRequestClose={close} />}
    </Popover>
  );
}
