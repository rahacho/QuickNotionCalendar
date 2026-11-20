/**
 * Expanding tasks into concrete occurrences.
 *
 * Defensive reading of stored data (documents may come from an older/buggy client): a task whose
 * `date` is not a valid ISODate is treated as unscheduled (Inbox) so it is never invisible; an
 * invalid `endDate`/`time` is ignored; a `recurrence` without a valid date is ignored; an
 * `endDate` on a recurring task is ignored (multi-day tasks cannot repeat).
 *
 * Overrides are keyed by ORIGINAL rule date. Entries whose key is not (or no longer) a rule date
 * of the series — e.g. after the repeat rule or series start was edited — are ignored everywhere
 * (calendar, lists, reminders), exactly like `getOccurrence` treats them as invalid.
 */
import { compareDates, isHM, isValidISODate, parseYMD, toEpochDay, fromEpochDay, daysFromCivil } from './dates.js';
import { compareInDay, compareInbox } from './ordering.js';
import { compileRecurrence, compiledForEach, compiledIsRuleDate, type CompiledRule } from './recurrence.js';
import type { HM, ISODate, Occurrence, OccurrenceOverride, OccurrenceRef, Task } from './types.js';

/** "id" for non-recurring, "id@2026-11-19" for a recurring occurrence. */
export function occKey(taskId: string, origDate: ISODate | null): string {
  return origDate == null ? taskId : `${taskId}@${origDate}`;
}

/** Inverse of occKey. A key whose suffix after the last "@" is not a valid date is a plain task id. */
export function parseOccKey(key: string): OccurrenceRef {
  const at = key.lastIndexOf('@');
  if (at > 0) {
    const d = key.slice(at + 1);
    if (isValidISODate(d)) return { taskId: key.slice(0, at), origDate: d };
  }
  return { taskId: key, origDate: null };
}

export function refOf(occ: Occurrence): OccurrenceRef {
  return { taskId: occ.taskId, origDate: occ.origDate };
}

// ---------------------------------------------------------------------------------------------
// Sanitized views of a task
// ---------------------------------------------------------------------------------------------

/** The task's start date if valid, else null (→ Inbox). */
export function taskDate(task: Task): ISODate | null {
  return typeof task.date === 'string' && isValidISODate(task.date) ? task.date : null;
}

function validTime(t: unknown): HM | null {
  return typeof t === 'string' && isHM(t) ? t : null;
}

function validOrder(o: unknown, fallback: string): string {
  return typeof o === 'string' && o !== '' ? o : fallback;
}

/** Compiled rule when the task is effectively recurring (has a rule AND a valid start), else null. */
export function taskRule(task: Task): CompiledRule | null {
  const date = taskDate(task);
  if (date === null || task.recurrence == null || typeof task.recurrence !== 'object') return null;
  return compileRecurrence(task.recurrence, date);
}

function overridesOf(task: Task): Record<ISODate, OccurrenceOverride> {
  const ov = task.overrides;
  return ov != null && typeof ov === 'object' ? ov : {};
}

function overrideAt(ov: Record<ISODate, OccurrenceOverride>, d: ISODate): OccurrenceOverride | undefined {
  const o = Object.prototype.hasOwnProperty.call(ov, d) ? ov[d] : undefined;
  return o != null && typeof o === 'object' ? o : undefined;
}

/** Override's moved-to date, if it moves the occurrence somewhere valid. */
function movedDate(o: OccurrenceOverride | undefined): ISODate | null {
  return o !== undefined && typeof o.date === 'string' && isValidISODate(o.date) ? o.date : null;
}

function title(task: Task): string {
  return typeof task.title === 'string' ? task.title : '';
}

/** The single occurrence of a non-recurring (or Inbox) task. */
export function singleOccurrence(task: Task): Occurrence {
  const date = taskDate(task);
  let endDate: ISODate | null = null;
  if (date !== null) {
    endDate =
      task.recurrence == null && typeof task.endDate === 'string' && isValidISODate(task.endDate) && task.endDate > date
        ? task.endDate
        : date;
  }
  const done = task.done === true;
  return {
    key: task.id,
    taskId: task.id,
    origDate: null,
    date,
    endDate,
    time: date === null ? null : validTime(task.time),
    title: title(task),
    order: validOrder(task.order, ''),
    done,
    doneAt: done ? (task.doneAt ?? null) : null,
    recurring: false,
    multiDay: date !== null && endDate !== null && endDate > date,
    task,
  };
}

/** Occurrence of a recurring task at rule date `origDate` (caller guarantees it is a rule date). Null if skipped. */
function recurringOccurrence(task: Task, origDate: ISODate, o: OccurrenceOverride | undefined): Occurrence | null {
  if (o?.skipped === true) return null;
  const date = movedDate(o) ?? origDate;
  const done = o?.done === true;
  const time = o !== undefined && o.time !== undefined ? validTime(o.time) : validTime(task.time);
  return {
    key: occKey(task.id, origDate),
    taskId: task.id,
    origDate,
    date,
    endDate: date,
    time,
    title: title(task),
    order: validOrder(o?.order, validOrder(task.order, '')),
    done,
    doneAt: done ? (o?.doneAt ?? null) : null,
    recurring: true,
    multiDay: false,
    task,
  };
}

function epochOf(d: ISODate): number | null {
  const p = parseYMD(d);
  return p ? daysFromCivil(p[0], p[1], p[2]) : null;
}

/**
 * Calls fn for every override that MOVES a valid, non-skipped occurrence of the series:
 * fn(origDate, override, movedTo). One linear pass over the overrides map.
 */
function forEachMoved(
  task: Task,
  rule: CompiledRule,
  fn: (origDate: ISODate, o: OccurrenceOverride, movedTo: ISODate) => void,
): void {
  const ov = overridesOf(task);
  for (const od in ov) {
    if (!Object.prototype.hasOwnProperty.call(ov, od)) continue;
    const o = ov[od];
    if (o == null || typeof o !== 'object' || typeof o.date !== 'string' || o.date === od || o.skipped === true) continue;
    if (!isValidISODate(o.date)) continue;
    const e = epochOf(od);
    if (e === null || !compiledIsRuleDate(rule, e)) continue;
    fn(od, o, o.date);
  }
}

/**
 * Occurrences of ONE task whose span overlaps [from, to], unsorted.
 * Recurring: rule dates in range (minus skipped, minus moved-out) plus occurrences moved in
 * from anywhere. Done ones only when includeDone.
 */
export function occurrencesOfTask(task: Task, from: ISODate, to: ISODate, includeDone = false): Occurrence[] {
  const fromE = toEpochDay(from);
  const toE = toEpochDay(to);
  const out: Occurrence[] = [];
  if (fromE > toE) return out;
  const rule = taskRule(task);
  if (rule === null) {
    const occ = singleOccurrence(task);
    if (occ.date === null || occ.endDate === null) return out;
    if (occ.done && !includeDone) return out;
    if (occ.date <= to && occ.endDate >= from) out.push(occ);
    return out;
  }
  const ov = overridesOf(task);
  compiledForEach(rule, fromE, toE, (e) => {
    const od = fromEpochDay(e);
    const occ = recurringOccurrence(task, od, overrideAt(ov, od));
    if (occ === null || occ.date === null) return;
    if (occ.done && !includeDone) return;
    if (occ.date < from || occ.date > to) return; // moved out of range
    out.push(occ);
  });
  forEachMoved(task, rule, (od, o, movedTo) => {
    if (movedTo < from || movedTo > to) return;
    if (od >= from && od <= to) return; // already handled by the rule pass
    if (o.done === true && !includeDone) return;
    const occ = recurringOccurrence(task, od, o);
    if (occ !== null) out.push(occ);
  });
  return out;
}

function byDateThenInDay(a: Occurrence, b: Occurrence): number {
  return compareDates(a.date ?? '', b.date ?? '') || compareInDay(a, b);
}

/**
 * All scheduled occurrences overlapping [from, to] (inclusive), sorted by start date then
 * compareInDay. Inbox tasks are never included. includeDone defaults to false.
 */
export function occurrencesInRange(
  tasks: Iterable<Task>,
  from: ISODate,
  to: ISODate,
  opts?: { includeDone?: boolean },
): Occurrence[] {
  const includeDone = opts?.includeDone === true;
  const out: Occurrence[] = [];
  if (toEpochDay(from) > toEpochDay(to)) return out;
  for (const task of tasks) {
    if (task == null) continue;
    for (const occ of occurrencesOfTask(task, from, to, includeDone)) out.push(occ);
  }
  out.sort(byDateThenInDay);
  return out;
}

/**
 * The occurrence a ref points at, or null if it is not a valid occurrence (unknown rule date,
 * skipped). Done occurrences ARE returned. Lenient where unambiguous so a peek never closes
 * under the user's feet when they toggle Repeat:
 *  - non-recurring task + any origDate → its single occurrence (there is only one);
 *  - recurring task + null origDate → the occurrence at the series start, if that is a rule date.
 */
export function getOccurrence(task: Task, origDate: ISODate | null): Occurrence | null {
  const rule = taskRule(task);
  if (rule === null) return singleOccurrence(task);
  const od = origDate ?? taskDate(task);
  if (od === null) return null;
  const e = epochOf(od);
  if (e === null || !compiledIsRuleDate(rule, e)) return null;
  return recurringOccurrence(task, od, overrideAt(overridesOf(task), od));
}

/**
 * Earliest NOT-done, not-skipped occurrence whose effective date is >= fromDate (moved overrides
 * included), or null. Non-recurring: the task itself when undone and its date >= fromDate.
 * Cost: one pass over the overrides + one rule step per done/skipped/moved date it passes.
 */
export function firstOpenOccurrenceFrom(task: Task, fromDate: ISODate): Occurrence | null {
  const rule = taskRule(task);
  if (rule === null) {
    const occ = singleOccurrence(task);
    return !occ.done && occ.date !== null && occ.date >= fromDate ? occ : null;
  }
  const ov = overridesOf(task);
  let best: Occurrence | null = null;
  const consider = (occ: Occurrence | null): void => {
    if (occ === null || occ.done || occ.date === null || occ.date < fromDate) return;
    if (best === null || byDateThenInDay(occ, best) < 0) best = occ;
  };
  compiledForEach(rule, toEpochDay(fromDate), Infinity, (e) => {
    const od = fromEpochDay(e);
    const o = overrideAt(ov, od);
    if (o?.skipped === true || o?.done === true) return true;
    if (movedDate(o) !== null && movedDate(o) !== od) return true; // handled by the moved scan
    consider(recurringOccurrence(task, od, o));
    return false;
  });
  forEachMoved(task, rule, (od, o) => {
    if (o.done === true) return;
    consider(recurringOccurrence(task, od, o));
  });
  return best;
}

/**
 * Calls fn(origDate, doneAt) for every DONE occurrence of a task without materializing it:
 * non-recurring → once with origDate null when the task is done (Inbox tasks included);
 * recurring → each done override at a valid, non-skipped rule date.
 */
export function forEachDoneOccurrenceRef(task: Task, fn: (origDate: ISODate | null, doneAt: number | null) => void): void {
  const rule = taskRule(task);
  if (rule === null) {
    if (task.done === true) fn(null, typeof task.doneAt === 'number' ? task.doneAt : null);
    return;
  }
  const ov = overridesOf(task);
  for (const od in ov) {
    if (!Object.prototype.hasOwnProperty.call(ov, od)) continue;
    const o = ov[od];
    if (o == null || typeof o !== 'object' || o.done !== true || o.skipped === true) continue;
    const e = epochOf(od);
    if (e === null || !compiledIsRuleDate(rule, e)) continue;
    fn(od, typeof o.doneAt === 'number' ? o.doneAt : null);
  }
}

/** Done occurrences of a task (see forEachDoneOccurrenceRef), unsorted. */
export function doneOccurrencesOfTask(task: Task): Occurrence[] {
  const out: Occurrence[] = [];
  forEachDoneOccurrenceRef(task, (od) => {
    const occ = getOccurrence(task, od);
    if (occ !== null) out.push(occ);
  });
  return out;
}

/** Unscheduled, not-done tasks (date null — or unreadable), sorted by order asc then id. */
export function inboxTasks(tasks: Iterable<Task>): Task[] {
  const out: Task[] = [];
  for (const t of tasks) if (t != null && taskDate(t) === null && t.done !== true) out.push(t);
  return out.sort(compareInbox);
}

/** One-time, not done, scheduled, and its (end) date is before today. Recurring never goes overdue. */
export function isOverdue(occ: Occurrence, today: ISODate): boolean {
  if (occ.recurring || occ.done || occ.date == null) return false;
  return (occ.endDate ?? occ.date) < today;
}
