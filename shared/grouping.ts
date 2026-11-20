/**
 * Left "Tasks" sidebar groups (SPEC §4.1 grouping.ts).
 *
 * Order: overdue · today · tomorrow · day:YYYY-MM-DD (today+2 … today+horizon, only non-empty) ·
 * later · completed. Empty groups are omitted.
 *
 * Choices where the SPEC is silent (all in favor of "nothing planned is ever hidden"):
 *  - A recurring series counts as "having an occurrence in the window" only if it contributes a
 *    visible (not-done) item there; otherwise its next open occurrence after the window goes to
 *    Later — so a monthly task already ticked off this week still shows when it comes back.
 *  - Done Inbox tasks are listed in Completed (meta '') so they can be restored by unchecking.
 *  - Dates in a different year than today get the year appended ("Jan 5, 2027") in Overdue /
 *    Later / Completed metas; multi-day items always show their range ("Nov 18 → 21").
 */
import { addDays, parseYMD, weekday } from './dates.js';
import {
  firstOpenOccurrenceFrom,
  forEachDoneOccurrenceRef,
  getOccurrence,
  isOverdue,
  occurrencesOfTask,
  singleOccurrence,
  taskDate,
  taskRule,
} from './occurrences.js';
import { compareInDay } from './ordering.js';
import { WEEKDAY_NAMES, formatDateMedium, formatDateShort, formatRange, formatTime, formatWeekdayShort } from './format.js';
import type { ISODate, ListGroup, ListGroupId, ListItem, Occurrence, Task } from './types.js';

function yearOf(d: ISODate): number {
  return parseYMD(d)?.[0] ?? 0;
}

/** "Nov 12" this year, "Jan 5, 2027" otherwise. */
function dateLabel(d: ISODate, today: ISODate): string {
  return yearOf(d) === yearOf(today) ? formatDateShort(d) : formatDateMedium(d);
}

/** "Nov 18 → 21"; appends the year when the whole range is in another year than today. */
function rangeLabel(start: ISODate, end: ISODate, today: ISODate): string {
  const ys = yearOf(start);
  const ye = yearOf(end);
  const base = formatRange(start, end);
  return ys === ye && ys !== yearOf(today) ? `${base}, ${ys}` : base;
}

function withTime(label: string, occ: Occurrence): string {
  if (occ.time == null) return label;
  const t = formatTime(occ.time);
  if (!t) return label;
  return label ? `${label} · ${t}` : t;
}

/** Date (or range) + time — used by Overdue and Later. */
function datedMeta(occ: Occurrence, today: ISODate): string {
  if (occ.date == null) return '';
  const label =
    occ.multiDay && occ.endDate != null ? rangeLabel(occ.date, occ.endDate, today) : dateLabel(occ.date, today);
  return withTime(label, occ);
}

/** Inside a day group the date is implied: range for multi-day, time for timed, '' otherwise. */
function dayMeta(occ: Occurrence, today: ISODate): string {
  if (occ.multiDay && occ.date != null && occ.endDate != null) {
    return withTime(rangeLabel(occ.date, occ.endDate, today), occ);
  }
  return occ.time != null ? formatTime(occ.time) : '';
}

function completedMeta(occ: Occurrence, today: ISODate): string {
  if (occ.date == null) return '';
  return occ.multiDay && occ.endDate != null ? rangeLabel(occ.date, occ.endDate, today) : dateLabel(occ.date, today);
}

function clampInt(v: number | undefined, def: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return def;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

function byDateThenInDay(a: Occurrence, b: Occurrence): number {
  const da = a.date ?? '';
  const db = b.date ?? '';
  return da < db ? -1 : da > db ? 1 : compareInDay(a, b);
}

/** A done occurrence not yet materialized (Completed can hold years of history). */
interface DoneRef {
  doneAt: number;
  task: Task;
  origDate: ISODate | null;
}

/** doneAt desc (missing doneAt last), then task id, then original date — deterministic. */
function byDoneAtDesc(a: DoneRef, b: DoneRef): number {
  if (a.doneAt !== b.doneAt) return b.doneAt > a.doneAt ? 1 : -1;
  if (a.task.id !== b.task.id) return a.task.id < b.task.id ? -1 : 1;
  const da = a.origDate ?? '';
  const db = b.origDate ?? '';
  return da < db ? -1 : da > db ? 1 : 0;
}

/**
 * Keeps the top `limit` done refs by byDoneAtDesc while counting all of them, in
 * O(total · log limit) amortized: the buffer is sorted and truncated whenever it doubles.
 */
class TopDone {
  total = 0;
  private buf: DoneRef[] = [];
  private readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  add(r: DoneRef): void {
    this.total++;
    if (this.limit === 0) return;
    this.buf.push(r);
    if (this.buf.length >= this.limit * 2 + 64) this.trim();
  }
  private trim(): void {
    this.buf.sort(byDoneAtDesc);
    if (this.buf.length > this.limit) this.buf.length = this.limit;
  }
  result(): DoneRef[] {
    this.trim();
    return this.buf;
  }
}

export function buildTaskGroups(
  tasks: Iterable<Task>,
  today: ISODate,
  opts?: { horizonDays?: number; completedLimit?: number },
): ListGroup[] {
  const horizon = clampInt(opts?.horizonDays, 7, 0, 366);
  const completedLimit = clampInt(opts?.completedLimit, 50, 0, Number.MAX_SAFE_INTEGER);
  const windowEnd = addDays(today, horizon);
  const afterWindow = addDays(windowEnd, 1);

  const overdue: Occurrence[] = [];
  const byDay = new Map<ISODate, Occurrence[]>();
  const later: Occurrence[] = [];
  const completed = new TopDone(completedLimit);

  const addToDay = (d: ISODate, occ: Occurrence): void => {
    const list = byDay.get(d);
    if (list) list.push(occ);
    else byDay.set(d, [occ]);
  };

  for (const task of tasks) {
    if (task == null) continue;
    forEachDoneOccurrenceRef(task, (origDate, doneAt) => {
      completed.add({ task, origDate, doneAt: doneAt !== null && Number.isFinite(doneAt) ? doneAt : -Infinity });
    });

    if (taskRule(task) !== null) {
      const inWindow = occurrencesOfTask(task, today, windowEnd, false);
      for (const occ of inWindow) if (occ.date !== null) addToDay(occ.date, occ);
      if (inWindow.length === 0) {
        const next = firstOpenOccurrenceFrom(task, afterWindow);
        if (next !== null) later.push(next);
      }
      continue;
    }

    if (taskDate(task) === null) continue; // Inbox
    const occ = singleOccurrence(task);
    if (occ.done || occ.date === null) continue;
    if (isOverdue(occ, today)) {
      overdue.push(occ);
      continue;
    }
    // A multi-day task appears once, in the group of max(start, today).
    const g = occ.date > today ? occ.date : today;
    if (g <= windowEnd) addToDay(g, occ);
    else later.push(occ);
  }

  const groups: ListGroup[] = [];
  const item = (occ: Occurrence, meta: string, isOverdue = false): ListItem => ({ occ, meta, overdue: isOverdue });

  if (overdue.length > 0) {
    overdue.sort(byDateThenInDay);
    groups.push({
      id: 'overdue',
      title: 'Overdue',
      subtitle: '',
      items: overdue.map((o) => item(o, datedMeta(o, today), true)),
      count: overdue.length,
      collapsible: false,
      defaultCollapsed: false,
    });
  }

  for (let i = 0; i <= horizon; i++) {
    const d = addDays(today, i);
    const list = byDay.get(d);
    if (!list || list.length === 0) continue;
    list.sort(compareInDay);
    let id: ListGroupId;
    let title: string;
    let subtitle: string;
    if (i === 0) {
      id = 'today';
      title = 'Today';
      subtitle = formatWeekdayShort(d);
    } else if (i === 1) {
      id = 'tomorrow';
      title = 'Tomorrow';
      subtitle = formatWeekdayShort(d);
    } else {
      id = `day:${d}`;
      title = WEEKDAY_NAMES[weekday(d)];
      subtitle = formatDateShort(d);
    }
    groups.push({
      id,
      title,
      subtitle,
      items: list.map((o) => item(o, dayMeta(o, today))),
      count: list.length,
      collapsible: false,
      defaultCollapsed: false,
    });
  }

  if (later.length > 0) {
    later.sort(byDateThenInDay);
    groups.push({
      id: 'later',
      title: 'Later',
      subtitle: '',
      items: later.map((o) => item(o, datedMeta(o, today))),
      count: later.length,
      collapsible: true,
      defaultCollapsed: true,
    });
  }

  if (completed.total > 0) {
    const items: ListItem[] = [];
    for (const ref of completed.result()) {
      const occ = getOccurrence(ref.task, ref.origDate);
      if (occ !== null) items.push(item(occ, completedMeta(occ, today)));
    }
    groups.push({
      id: 'completed',
      title: 'Completed',
      subtitle: '',
      items,
      count: completed.total,
      collapsible: true,
      defaultCollapsed: true,
    });
  }

  return groups;
}
