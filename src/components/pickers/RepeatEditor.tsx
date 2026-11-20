import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft } from 'lucide-react';
import type { ISODate, Occurrence, Recurrence, Weekday } from '@shared/types';
import { addMonths, parseYMD, startOfMonth, weekday } from '@shared/dates';
import { normalizeRecurrence, describeRecurrence } from '@shared/recurrence';
import { MONTH_SHORT, WEEKDAY_NAMES, formatDateMedium } from '@shared/format';
import { useStore } from '@/store/store';
import { cx } from '@/lib/cx';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { Popover, usePopoverClose } from '@/components/ui/Popover';
import { IconButton } from '@/components/ui/IconButton';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { MiniCalendar } from './MiniCalendar';
import {
  WEEKDAY_LETTERS,
  applyRepeat,
  matchPreset,
  ordinal,
  repeatBase,
  repeatPresets,
  weekdayOrder,
} from './pickerUtils';
import styles from './Pickers.module.css';

export interface RepeatEditorProps {
  /** The occurrence being viewed. Repeat edits apply to the whole series. */
  occ: Occurrence;
  /** Called after a preset is chosen / "Done" in the custom panel. Default: closes the enclosing popover. */
  onDone?: () => void;
  /** Open straight into the custom panel. */
  initialView?: 'presets' | 'custom';
}

type Freq = Recurrence['freq'];
type Ends = 'never' | 'until' | 'count';

interface Draft {
  freq: Freq;
  interval: number;
  byWeekday: Weekday[];
  ends: Ends;
  until: ISODate;
  count: number;
}

const UNIT: Record<Freq, [string, string]> = {
  daily: ['day', 'days'],
  weekly: ['week', 'weeks'],
  monthly: ['month', 'months'],
  yearly: ['year', 'years'],
};

const MAX_INTERVAL = 99;
const MAX_COUNT = 999;

/**
 * Repeat choices: Never · Every day · Every weekday · Every week on <weekday> · Every month on the
 * <nth> · Every year on <Mon d> · Custom… (every N days/weeks/months/years, weekday chips, ends
 * never / on a date / after N times). Changes apply to the series through applyRepeat (setRecurrence,
 * plus a minimal setSeriesStart when a monthly/yearly anchor moves, undone by a later non-anchored
 * choice). In the custom panel, chips / ends apply at once; the unit and typed numbers apply on
 * Done, on the next applied change, or when the panel closes. Inbox tasks are scheduled today first.
 */
export function RepeatEditor({ occ, onDone, initialView = 'presets' }: RepeatEditorProps) {
  const today = useStore((s) => s.today);
  const popover = usePopoverClose();
  const done = onDone ?? (() => popover?.close());
  // The anchor date is fixed for this editing session (the peek may re-point to another occurrence).
  const [base] = useState(() => repeatBase(occ, today));
  const [view, setView] = useState<'presets' | 'custom'>(initialView);
  const task = occ.task;
  const multiDay = occ.multiDay;

  if (view === 'custom') {
    return <CustomRepeat occ={occ} base={base} onBack={() => setView('presets')} onDone={done} />;
  }

  const presets = repeatPresets(base);
  const current = matchPreset(task, base);
  const customHint = current === 'custom' && task.recurrence && task.date ? describeRecurrence(task.recurrence, task.date) : undefined;

  return (
    <Menu className={styles.menu} aria-label="Repeat">
      {presets.map((p) => (
        <MenuItem
          key={p.id}
          label={p.label}
          selected={current === p.id}
          disabled={multiDay && p.rule !== null}
          keepOpen
          data-testid={`repeat-${p.id}`}
          onSelect={() => {
            applyRepeat(occ, p.rule, base);
            done();
          }}
        />
      ))}
      <MenuSeparator />
      <MenuItem
        label="Custom…"
        hint={customHint}
        selected={current === 'custom'}
        disabled={multiDay}
        keepOpen
        data-testid="repeat-custom"
        onSelect={() => setView('custom')}
      />
    </Menu>
  );
}

function draftFrom(occ: Occurrence, base: ISODate): Draft {
  const task = occ.task;
  const fallbackUntil = addMonths(base, 1);
  if (task.recurrence && task.date) {
    const r = normalizeRecurrence(task.recurrence, task.date);
    return {
      freq: r.freq,
      interval: r.interval,
      byWeekday: r.byWeekday && r.byWeekday.length > 0 ? [...r.byWeekday] : [weekday(base)],
      ends: r.until != null ? 'until' : r.count != null ? 'count' : 'never',
      until: r.until ?? fallbackUntil,
      count: r.count ?? 10,
    };
  }
  return { freq: 'weekly', interval: 1, byWeekday: [weekday(base)], ends: 'never', until: fallbackUntil, count: 10 };
}

function ruleFrom(d: Draft): Recurrence {
  return {
    freq: d.freq,
    interval: d.interval,
    byWeekday: d.freq === 'weekly' ? [...d.byWeekday].sort((a, b) => a - b) : null,
    until: d.ends === 'until' ? d.until : null,
    count: d.ends === 'count' ? d.count : null,
  };
}

function parseBounded(s: string, max: number): number | null {
  if (!/^\s*\d{1,4}\s*$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= max ? n : null;
}

function CustomRepeat({
  occ,
  base,
  onBack,
  onDone,
}: {
  occ: Occurrence;
  base: ISODate;
  onBack: () => void;
  onDone: () => void;
}) {
  const today = useStore((s) => s.today);
  const weekStart = useStore((s) => s.settings.weekStart);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(occ, base));
  const [intervalText, setIntervalText] = useState(String(draft.interval));
  const [countText, setCountText] = useState(String(draft.count));
  const [untilOpen, setUntilOpen] = useState(false);
  const [untilMonth, setUntilMonth] = useState(startOfMonth(draft.until));
  const untilBtn = useRef<HTMLButtonElement>(null);
  const latest = useRef({ occ, draft, dirty: false });
  latest.current.occ = occ;
  latest.current.draft = draft;

  const ym = parseYMD(base);
  const anchorText =
    draft.freq === 'monthly'
      ? `on the ${ordinal(ym ? ym[2] : 1)}`
      : draft.freq === 'yearly'
        ? `on ${ym ? `${MONTH_SHORT[ym[1] - 1]} ${ym[2]}` : ''}`
        : '';

  const commit = (next: Draft) => {
    latest.current.dirty = false;
    applyRepeat(latest.current.occ, ruleFrom(next), base);
  };

  const update = (patch: Partial<Draft>, applyNow = true) => {
    const next = { ...latest.current.draft, ...patch };
    latest.current.draft = next;
    setDraft(next);
    if (applyNow) commit(next);
    else latest.current.dirty = true;
  };

  // Typed numbers apply on blur / Enter; anything still pending applies when the panel goes away.
  useEffect(
    () => () => {
      if (latest.current.dirty) commit(latest.current.draft);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const commitInterval = () => {
    const n = parseBounded(intervalText, MAX_INTERVAL);
    if (n === null) {
      setIntervalText(String(latest.current.draft.interval));
      return;
    }
    setIntervalText(String(n));
    if (n !== latest.current.draft.interval || latest.current.dirty) update({ interval: n });
  };

  const commitCount = () => {
    const n = parseBounded(countText, MAX_COUNT);
    if (n === null) {
      setCountText(String(latest.current.draft.count));
      return;
    }
    setCountText(String(n));
    if (n !== latest.current.draft.count || latest.current.dirty) update({ count: n, ends: 'count' });
  };

  const toggleDay = (wd: Weekday) => {
    const has = draft.byWeekday.includes(wd);
    if (has && draft.byWeekday.length === 1) return; // at least one day
    update({ byWeekday: has ? draft.byWeekday.filter((d) => d !== wd) : [...draft.byWeekday, wd] });
  };

  const minUntil = occ.task.date ?? base;

  return (
    <div className={cx(styles.panel, styles.repeatPanel)} role="group" aria-label="Custom repeat" data-testid="repeat-custom-panel">
      <div className={styles.panelHeader}>
        <IconButton label="Back" icon={ChevronLeft} size={24} tooltip={false} onClick={onBack} />
        <span className={styles.panelTitle}>Custom repeat</span>
      </div>

      <div className={styles.formRow}>
        <span className={styles.formLabel}>Every</span>
        <input
          className={cx(styles.numberInput)}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={2}
          value={intervalText}
          aria-label="Repeat interval"
          data-testid="repeat-interval"
          onChange={(e) => {
            setIntervalText(e.target.value);
            latest.current.dirty = parseBounded(e.target.value, MAX_INTERVAL) !== null;
            if (latest.current.dirty) {
              const n = parseBounded(e.target.value, MAX_INTERVAL) as number;
              latest.current.draft = { ...latest.current.draft, interval: n };
              setDraft(latest.current.draft);
            }
          }}
          onBlur={commitInterval}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitInterval();
            }
          }}
        />
        <div className={cx(styles.selectWrap, styles.grow)}>
          <select
            className={styles.select}
            value={draft.freq}
            aria-label="Repeat unit"
            data-testid="repeat-freq"
            // Browsing units (weeks → months → weeks) must not write each step: a monthly/yearly unit
            // can move the series start. The unit applies with the next control change, Done, or when
            // the panel closes — like the typed numbers.
            onChange={(e) => update({ freq: e.target.value as Freq }, false)}
          >
            {(Object.keys(UNIT) as Freq[]).map((f) => (
              <option key={f} value={f}>
                {UNIT[f][draft.interval === 1 ? 0 : 1]}
              </option>
            ))}
          </select>
          <Icon icon={ChevronDown} size={12} className={styles.selectChevron} />
        </div>
      </div>

      {draft.freq === 'weekly' && (
        <div className={styles.formRow}>
          <span className={styles.formLabel}>On</span>
          <div className={styles.chips} role="group" aria-label="Days of the week">
            {weekdayOrder(weekStart).map((wd) => {
              const on = draft.byWeekday.includes(wd);
              return (
                <button
                  key={wd}
                  type="button"
                  className={cx(styles.chip, on && styles.chipOn)}
                  aria-pressed={on}
                  aria-label={WEEKDAY_NAMES[wd]}
                  data-testid="repeat-weekday"
                  data-weekday={wd}
                  onClick={() => toggleDay(wd)}
                >
                  {WEEKDAY_LETTERS[wd]}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {anchorText && (
        <div className={styles.formRow}>
          <span className={styles.formLabel} />
          <span className={styles.caption}>{anchorText}</span>
        </div>
      )}

      <div className={styles.sectionLabel}>Ends</div>
      <div className={styles.radios} role="radiogroup" aria-label="Ends">
        <label className={styles.radioRow}>
          <input
            type="radio"
            name="repeat-ends"
            className={styles.radio}
            checked={draft.ends === 'never'}
            onChange={() => update({ ends: 'never' })}
            data-testid="repeat-ends-never"
          />
          <span>Never</span>
        </label>
        <label className={styles.radioRow}>
          <input
            type="radio"
            name="repeat-ends"
            className={styles.radio}
            checked={draft.ends === 'until'}
            onChange={() => update({ ends: 'until', until: draft.until < minUntil ? minUntil : draft.until })}
            data-testid="repeat-ends-until"
          />
          <span>On</span>
          <button
            ref={untilBtn}
            type="button"
            className={cx(styles.inlineField, draft.ends !== 'until' && styles.inlineFieldMuted, untilOpen && styles.inlineFieldActive)}
            data-testid="repeat-until"
            onClick={() => {
              setUntilMonth(startOfMonth(draft.until));
              setUntilOpen((o) => !o);
            }}
          >
            {formatDateMedium(draft.until)}
          </button>
        </label>
        <label className={styles.radioRow}>
          <input
            type="radio"
            name="repeat-ends"
            className={styles.radio}
            checked={draft.ends === 'count'}
            onChange={() => update({ ends: 'count' })}
            data-testid="repeat-ends-count"
          />
          <span>After</span>
          <input
            className={cx(styles.numberInput, draft.ends !== 'count' && styles.inlineFieldMuted)}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={3}
            value={countText}
            aria-label="Number of times"
            data-testid="repeat-count"
            onFocus={() => {
              if (draft.ends !== 'count') update({ ends: 'count' }, false);
            }}
            onChange={(e) => {
              setCountText(e.target.value);
              const n = parseBounded(e.target.value, MAX_COUNT);
              if (n !== null) {
                latest.current.draft = { ...latest.current.draft, count: n, ends: 'count' };
                latest.current.dirty = true;
                setDraft(latest.current.draft);
              }
            }}
            onBlur={commitCount}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitCount();
              }
            }}
          />
          <span>{draft.count === 1 ? 'time' : 'times'}</span>
        </label>
      </div>

      <Popover
        open={untilOpen}
        onOpenChange={setUntilOpen}
        anchor={untilBtn}
        placement="bottom-start"
        width={252}
        aria-label="End date"
        className={styles.calendarPopover}
      >
        <MiniCalendar
          month={untilMonth}
          onMonthChange={setUntilMonth}
          selected={draft.until}
          min={minUntil}
          today={today}
          weekStart={weekStart}
          onSelect={(d) => {
            update({ ends: 'until', until: d });
            setUntilOpen(false);
          }}
        />
      </Popover>

      <div className={styles.panelFooter}>
        <span className={styles.summary} data-testid="repeat-summary">
          {describeRecurrence(ruleFrom(draft), draft.freq === 'monthly' || draft.freq === 'yearly' ? base : (occ.task.date ?? base))}
        </span>
        <Button
          variant="primary"
          data-testid="repeat-custom-done"
          onClick={() => {
            const d = latest.current.draft;
            const n = parseBounded(intervalText, MAX_INTERVAL) ?? d.interval;
            const c = parseBounded(countText, MAX_COUNT) ?? d.count;
            const next = { ...d, interval: n, count: c };
            latest.current.draft = next;
            setDraft(next);
            commit(next);
            onDone();
          }}
        >
          Done
        </Button>
      </div>
    </div>
  );
}
