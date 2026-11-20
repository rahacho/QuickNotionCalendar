/**
 * Helpers shared by the pickers, the peek, settings and quick-add (peek agent's folders).
 * Pure functions + a couple of tiny DOM helpers; no React state.
 */
import type { HM, ISODate, Occurrence, Recurrence, Reminder, Task, Weekday } from '@shared/types';
import { addDays, daysInMonth, maxDate, minutesToHM, parseYMD, toEpochDay, weekday, ymdToISO } from '@shared/dates';
import { normalizeRecurrence, nextRuleDate } from '@shared/recurrence';
import { getOccurrence, refOf } from '@shared/occurrences';
import {
  MONTH_SHORT,
  WEEKDAY_NAMES,
  formatDateLong,
  formatDateMedium,
  formatReminder,
  formatTime,
} from '@shared/format';
import { useStore } from '@/store/store';
import { openPeek, closePeek, setRecurrence, setSchedule } from '@/store/actions';

/** Two-letter weekday initials (Notion date picker), indexed by Weekday (0 = Sunday). */
export const WEEKDAY_INITIALS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const;
/** One-letter chips (repeat editor), indexed by Weekday. */
export const WEEKDAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const;

/** Display order of weekdays for a week start (1 = Monday first). */
export function weekdayOrder(weekStart: 0 | 1): Weekday[] {
  return weekStart === 1 ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6];
}

/** Dates the UI accepts (typed or picked): keeps every grid/date computation far from the 0000/9999 edges. */
export const MIN_PICK_DATE: ISODate = '1900-01-01';
export const MAX_PICK_DATE: ISODate = '2199-12-31';

export function isPickableDate(d: ISODate | null | undefined): d is ISODate {
  return typeof d === 'string' && parseYMD(d) !== null && d >= MIN_PICK_DATE && d <= MAX_PICK_DATE;
}

export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/**
 * A sensible time when "Include time" is switched on: the next half hour for today, else 9:00 AM.
 * Late at night it clamps to 11:30 PM rather than wrapping to tomorrow.
 */
export function defaultTimeFor(date: ISODate, today: ISODate, now: Date = new Date()): HM {
  if (date !== today) return '09:00';
  const mins = now.getHours() * 60 + now.getMinutes();
  const next = Math.ceil((mins + 1) / 30) * 30;
  return next >= 24 * 60 ? '23:30' : minutesToHM(next);
}

/**
 * Peek "Date" value: "November 19, 2026" | "November 19, 2026 3:00 PM" |
 * "Nov 19, 2026 → Nov 21, 2026" (+ " 3:00 PM" after the start when timed). '' for Inbox.
 */
export function formatOccurrenceDate(occ: Occurrence): string {
  if (occ.date === null) return '';
  const time = occ.time ? ` ${formatTime(occ.time)}` : '';
  if (occ.multiDay && occ.endDate !== null && occ.endDate > occ.date) {
    return `${formatDateMedium(occ.date)}${time} → ${formatDateMedium(occ.endDate)}`;
  }
  return `${formatDateLong(occ.date)}${time}`;
}

/** "November 19, 2026 3:04 PM" for a timestamp (local time). */
export function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const iso = `${String(d.getFullYear()).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${formatDateLong(iso)} ${formatTime(minutesToHM(d.getHours() * 60 + d.getMinutes()))}`.trim();
}

/**
 * Remind value shown in the peek / date picker. Same as formatReminder, except that for an UNTIMED
 * task the default (and an offset, which behaves like default) reads "None": the morning summary
 * covers it and no individual alert fires — matching the "None" choice in the ReminderMenu.
 */
export function reminderValueLabel(r: Reminder, timed: boolean): string {
  if (!timed && (r.kind === 'default' || r.kind === 'offset')) return 'None';
  return formatReminder(r, timed);
}

export function sameReminder(a: Reminder, b: Reminder): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'offset' && b.kind === 'offset') return a.minutes === b.minutes;
  if (a.kind === 'at' && b.kind === 'at') return a.time === b.time && a.daysBefore === b.daysBefore;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Repeat
// ---------------------------------------------------------------------------------------------

/**
 * The date a repeat choice is anchored to: the viewed occurrence's rule date for a series, the
 * task's date for a one-time task, today for an Inbox task (which gets scheduled today first).
 */
export function repeatBase(occ: Occurrence, today: ISODate): ISODate {
  if (occ.recurring) return occ.origDate ?? occ.task.date ?? today;
  return occ.date ?? today;
}

export type RepeatPresetId = 'never' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly';

export interface RepeatPreset {
  id: RepeatPresetId;
  label: string;
  rule: Recurrence | null;
}

export function repeatPresets(base: ISODate): RepeatPreset[] {
  const p = parseYMD(base);
  const wd = weekday(base);
  const month = p ? MONTH_SHORT[p[1] - 1] : '';
  const day = p ? p[2] : 1;
  return [
    { id: 'never', label: 'Never', rule: null },
    { id: 'daily', label: 'Every day', rule: { freq: 'daily', interval: 1 } },
    { id: 'weekdays', label: 'Every weekday', rule: { freq: 'weekly', interval: 1, byWeekday: [1, 2, 3, 4, 5] } },
    { id: 'weekly', label: `Every week on ${WEEKDAY_NAMES[wd]}`, rule: { freq: 'weekly', interval: 1, byWeekday: [wd] } },
    { id: 'monthly', label: `Every month on the ${ordinal(day)}`, rule: { freq: 'monthly', interval: 1 } },
    { id: 'yearly', label: `Every year on ${month} ${day}`, rule: { freq: 'yearly', interval: 1 } },
  ];
}

/** Monthly/yearly rules take their day from the series start: does `base` need to become the start? */
function anchorDiffers(freq: Recurrence['freq'], start: ISODate, base: ISODate): boolean {
  if (freq === 'monthly') return start.slice(8) !== base.slice(8);
  if (freq === 'yearly') return start.slice(5) !== base.slice(5);
  return false;
}

/**
 * The start for a monthly/yearly rule anchored on `base`'s day (day of month, or month + day): the
 * EARLIEST date on `base`'s cycle (every `interval` months / years back from it) that is not before
 * `notBefore`. Moving the start only that far keeps every occurrence the new rule allows between
 * `notBefore` and the viewed one (viewing March's and picking "monthly" keeps December–February).
 * Months without that day (Feb 30) can't carry the anchor and are skipped. `base` itself when it is
 * already on/before `notBefore` (a past occurrence is being viewed).
 */
export function anchoredStart(freq: 'monthly' | 'yearly', interval: number, base: ISODate, notBefore: ISODate): ISODate {
  const p = parseYMD(base);
  if (!p || base <= notBefore) return base;
  const [y, m, d] = p;
  const step = (freq === 'monthly' ? 1 : 12) * Math.max(1, Math.floor(interval) || 1);
  const baseIndex = y * 12 + (m - 1);
  let best = base;
  for (let k = 1; k <= 4000; k++) {
    const index = baseIndex - k * step;
    const yy = Math.floor(index / 12);
    const mm = index - yy * 12 + 1;
    if (yy < 1900) break;
    if (d > daysInMonth(yy, mm)) continue;
    const candidate = ymdToISO(yy, mm, d);
    if (candidate < notBefore) break;
    best = candidate;
  }
  return best;
}

/**
 * Series starts moved by applyRepeat to anchor a monthly/yearly rule, per task: `from` = the start
 * before the move, `to` = where it went. A later rule that doesn't need that anchor (daily, weekly,
 * or monthly/yearly on the original day) moves the start back, so trying "monthly" and returning to
 * "weekly" never deletes the occurrences in between (today's included). Lives for the app session and
 * is ignored as soon as the start is changed any other way.
 */
const movedStarts = new Map<string, { from: ISODate; to: ISODate }>();

/** Test hook: forget every remembered start move. */
export function resetRepeatMemory(): void {
  movedStarts.clear();
}

/** Where a recurring series should start once `rule` (chosen while viewing `base`) is applied. */
function seriesStartFor(taskId: string, current: ISODate, rule: Recurrence, base: ISODate, today: ISODate): { start: ISODate; original: ISODate } {
  const moved = movedStarts.get(taskId);
  const original = moved && moved.to === current ? moved.from : current;
  if ((rule.freq === 'monthly' || rule.freq === 'yearly') && anchorDiffers(rule.freq, original, base)) {
    return { start: anchoredStart(rule.freq, rule.interval, base, maxDate(original, today)), original };
  }
  return { start: original, original };
}

/** Which preset the task's current rule is ('custom' when none matches; 'never' when not repeating). */
export function matchPreset(task: Task, base: ISODate): RepeatPresetId | 'custom' {
  if (!task.recurrence || task.date === null) return 'never';
  const rule = normalizeRecurrence(task.recurrence, task.date);
  if (rule.until != null || rule.count != null || rule.interval !== 1) return 'custom';
  const days = rule.byWeekday ?? [];
  switch (rule.freq) {
    case 'daily':
      return 'daily';
    case 'weekly':
      if (days.join(',') === '1,2,3,4,5') return 'weekdays';
      if (days.length === 1 && days[0] === weekday(base)) return 'weekly';
      return 'custom';
    case 'monthly':
    case 'yearly':
      return anchorDiffers(rule.freq, task.date, base) ? 'custom' : rule.freq;
  }
}

/**
 * Applies a repeat rule chosen in the UI for the occurrence the user is looking at.
 *  - null → setRecurrence(null) (the series becomes a one-time task on the viewed occurrence when it
 *    is still open, else the next open one).
 *  - Inbox task → scheduled on `base` (today) first.
 *  - Monthly/yearly anchored on a different day than the series start → the start moves forward only
 *    as far as needed (anchoredStart: never past today's or the original start's first matching date).
 *  - A rule that no longer needs such a move puts the start back where it was (movedStarts).
 *  The start and the rule are written together (one undo entry; the store toasts "Repeat changed"
 *  with Undo when planned occurrences disappear).
 * Afterwards the peek (if it shows this task) is re-pointed at a valid occurrence so it stays open.
 */
export function applyRepeat(occ: Occurrence, rule: Recurrence | null, base: ISODate): void {
  const taskId = occ.taskId;
  const get = (): Task | undefined => {
    const tasks = useStore.getState().tasks;
    return Object.prototype.hasOwnProperty.call(tasks, taskId) ? tasks[taskId] : undefined;
  };
  let task = get();
  if (!task) return;
  if (rule === null) {
    movedStarts.delete(taskId);
    if (!task.recurrence) return;
    setRecurrence(taskId, null, { keepOrigDate: occ.recurring ? occ.origDate : null });
    retargetPeek(taskId, null);
    return;
  }
  if (task.date === null) {
    setSchedule({ taskId, origDate: null }, { date: base, endDate: null });
    task = get();
    if (!task || task.date === null) return;
  }
  if (!task.recurrence) {
    // A one-time task becoming a series starts on its own date (= base): nothing to anchor or restore.
    movedStarts.delete(taskId);
    setRecurrence(taskId, rule);
  } else {
    const { start, original } = seriesStartFor(taskId, task.date, rule, base, useStore.getState().today);
    setRecurrence(taskId, rule, { start });
    const after = get();
    if (after && start !== original && after.date === start) movedStarts.set(taskId, { from: original, to: start });
    else movedStarts.delete(taskId);
  }
  retargetPeek(taskId, occ.recurring ? (occ.origDate ?? base) : base);
}

/**
 * Keeps the peek on `taskId` open after a series-level change: points it at the occurrence on
 * `prefer` if that is still valid, else the next occurrence on/after it, else the first one.
 * Closes the peek if the task has no occurrence left.
 */
export function retargetPeek(taskId: string, prefer: ISODate | null): void {
  const s = useStore.getState();
  const peek = s.ui.peek;
  if (!peek || peek.taskId !== taskId) return;
  const task = Object.prototype.hasOwnProperty.call(s.tasks, taskId) ? s.tasks[taskId] : undefined;
  if (!task) return;
  if (!task.recurrence || task.date === null) {
    openPeek({ taskId, origDate: null });
    return;
  }
  const start = task.date;
  const tryFrom = (from: ISODate): Occurrence | null => {
    let d = nextRuleDate(task.recurrence as Recurrence, start, from);
    for (let i = 0; d !== null && i < 64; i++) {
      const occ = getOccurrence(task, d);
      if (occ) return occ;
      // Skipped: look further.
      if (toEpochDay(d) >= toEpochDay(MAX_PICK_DATE)) return null;
      d = nextRuleDate(task.recurrence as Recurrence, start, addDays(d, 1));
    }
    return null;
  };
  const occ = (prefer !== null ? getOccurrence(task, prefer) : null) ?? (prefer !== null ? tryFrom(prefer) : null) ?? tryFrom(start);
  if (occ) openPeek(refOf(occ));
  else closePeek();
}

// ---------------------------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------------------------

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

/** Notion-style "invalid input" shake (restartable; skipped under reduced motion). */
export function shake(el: HTMLElement | null | undefined): void {
  if (!el || typeof el.animate !== 'function' || reducedMotion()) return;
  for (const a of el.getAnimations?.() ?? []) if (a.id === 'shake') a.cancel();
  const anim = el.animate(
    [
      { transform: 'translateX(0)' },
      { transform: 'translateX(-5px)' },
      { transform: 'translateX(4px)' },
      { transform: 'translateX(-3px)' },
      { transform: 'translateX(2px)' },
      { transform: 'translateX(0)' },
    ],
    { duration: 300, easing: 'ease-out' },
  );
  anim.id = 'shake';
}
