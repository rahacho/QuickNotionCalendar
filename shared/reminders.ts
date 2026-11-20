/**
 * Reminder instants, morning summary, badge.
 *
 * Wall-clock ⇄ instant conversion uses @date-fns/tz's `tzOffset` (the same IANA offset lookup
 * TZDate is built on) with an explicit DST resolution that does not depend on the HOST time
 * zone (Cloud Functions run in UTC, phones anywhere):
 *  - gap (wall time skipped by spring-forward, e.g. 02:30 on 2026-03-08 in New York) → shifted
 *    forward by the gap length (03:30 EDT), i.e. interpreted with the pre-transition offset;
 *  - overlap (repeated by fall-back, e.g. 01:30 on 2026-11-01 in New York) → the EARLIER instant
 *    (01:30 EDT).
 * An unknown time zone falls back to UTC (a reminder at a shifted time beats no reminder).
 */
// Subpath import: keeps the service-worker / functions bundles free of the full TZDate class
// (the package does not declare sideEffects: false, so the root entry may not tree-shake).
import { tzOffset } from '@date-fns/tz/tzOffset';
import {
  MAX_EPOCH_DAY,
  MIN_EPOCH_DAY,
  addDays,
  civilFromDays,
  daysFromCivil,
  fromEpochDay,
  hmToMinutes,
  isHM,
  parseYMD,
  ymdToISO,
} from './dates.js';
import {
  firstOpenOccurrenceFrom,
  isOverdue,
  occurrencesInRange,
  occurrencesOfTask,
  singleOccurrence,
  taskDate,
  taskRule,
} from './occurrences.js';
import { compareInDay } from './ordering.js';
import type { HM, ISODate, Millis, Occurrence, Reminder, Settings, Task } from './types.js';

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;
/** Sanity bounds for user-entered reminder parameters (10 years): absurd values are clamped. */
const MAX_DAYS_BEFORE = 3660;
const MAX_OFFSET_MIN = MAX_DAYS_BEFORE * 1440;
/** Recurring series are scanned day by day this many days ahead; beyond it a closed-form jump takes over. */
const RECURRING_SEARCH_DAYS = 400;
/** Open occurrences tried past the scan window before concluding a series has no alert left. */
const FAR_PROBES = 8;

const zoneValid = new Map<string, boolean>();

/** The zone if the runtime knows it, else 'UTC'. */
function resolveZone(tz: string): string {
  if (typeof tz !== 'string' || tz === '') return 'UTC';
  let ok = zoneValid.get(tz);
  if (ok === undefined) {
    ok = Number.isFinite(tzOffset(tz, new Date(0)));
    zoneValid.set(tz, ok);
  }
  return ok ? tz : 'UTC';
}

/** UTC offset (minutes, east positive) of `zone` at instant `ms`. */
function offsetAt(zone: string, ms: number): number {
  const o = tzOffset(zone, new Date(ms));
  return Number.isFinite(o) ? o : 0;
}

/** Instant of wall-clock `wallMs` (wall time encoded as if it were UTC) in `zone`. */
function wallToInstant(wallMs: number, zone: string): Millis {
  const before = offsetAt(zone, wallMs - DAY_MS);
  const after = offsetAt(zone, wallMs + DAY_MS);
  const tBefore = wallMs - before * MIN_MS;
  if (before === after) {
    // No transition nearby (or one far enough not to matter): verify, fall back to a direct read.
    const o = offsetAt(zone, tBefore);
    return o === before ? tBefore : wallMs - o * MIN_MS;
  }
  const tAfter = wallMs - after * MIN_MS;
  const okBefore = offsetAt(zone, tBefore) === before;
  const okAfter = offsetAt(zone, tAfter) === after;
  if (okBefore && okAfter) return Math.min(tBefore, tAfter); // overlap → earlier instant
  if (okBefore) return tBefore;
  if (okAfter) return tAfter;
  return tBefore; // gap → pre-transition offset = shifted forward by the gap
}

/** The instant at which the wall clock in `tz` reads `date` `time`. */
export function zonedInstant(date: ISODate, time: HM, tz: string): Millis {
  const p = parseYMD(date);
  if (!p) throw new RangeError(`Invalid ISODate: ${String(date)}`);
  const wall = daysFromCivil(p[0], p[1], p[2]) * DAY_MS + hmToMinutes(time) * MIN_MS;
  return wallToInstant(wall, resolveZone(tz));
}

/** The calendar date on the wall in `tz` at instant `nowMs`. */
export function zonedToday(nowMs: Millis, tz: string): ISODate {
  if (!Number.isFinite(nowMs)) throw new RangeError(`Invalid instant: ${nowMs}`);
  const zone = resolveZone(tz);
  const wall = nowMs + offsetAt(zone, nowMs) * MIN_MS;
  const [y, m, d] = civilFromDays(Math.floor(wall / DAY_MS));
  return ymdToISO(y, m, d);
}

/**
 * When to alert for an occurrence, or null for no individual alert.
 *  - default: at the time (timed) / none (untimed — the morning summary covers it)
 *  - none: null
 *  - offset: `minutes` before the time (timed); untimed behaves like default (null)
 *  - at: clock `time` on (date − daysBefore); works for untimed tasks too
 */
export function reminderInstantFor(
  occ: { date: ISODate; time: HM | null },
  reminder: Reminder,
  tz: string,
): Millis | null {
  const time = occ.time != null && isHM(occ.time) ? occ.time : null;
  switch (reminder?.kind) {
    case 'none':
      return null;
    case 'offset': {
      if (time === null) return null;
      return zonedInstant(occ.date, time, tz) - offsetMinutes(reminder) * MIN_MS;
    }
    case 'at': {
      if (!isHM(reminder.time)) return null;
      const p = parseYMD(occ.date);
      if (!p) return null;
      const day = Math.max(MIN_EPOCH_DAY, daysFromCivil(p[0], p[1], p[2]) - daysBeforeOf(reminder));
      return zonedInstant(fromEpochDay(day), reminder.time, tz);
    }
    case 'default':
    default:
      return time === null ? null : zonedInstant(occ.date, time, tz);
  }
}

/** Offset minutes of an offset reminder, rounded and clamped to ±10 years (non-finite → 0). */
function offsetMinutes(r: Reminder): number {
  if (r.kind !== 'offset' || !Number.isFinite(r.minutes)) return 0;
  return Math.max(-MAX_OFFSET_MIN, Math.min(MAX_OFFSET_MIN, Math.round(r.minutes)));
}

/** daysBefore of an "at" reminder, floored and clamped to 0…3660 (non-finite → 0). */
function daysBeforeOf(r: Reminder): number {
  if (r.kind !== 'at' || !Number.isFinite(r.daysBefore)) return 0;
  return Math.max(0, Math.min(MAX_DAYS_BEFORE, Math.floor(r.daysBefore)));
}

/** Reminder of a task (missing/corrupt → default). */
function reminderOf(task: Task): Reminder {
  const r = task.reminder;
  return r != null && typeof r === 'object' && typeof r.kind === 'string' ? r : { kind: 'default' };
}

/**
 * Earliest reminder instant > afterMs over not-done, not-skipped occurrences.
 * Non-recurring: its single occurrence (multi-day: relative to the start date). Inbox → null.
 * Recurring: occurrences (after overrides: moved dates, per-occurrence times) are scanned up to
 * 400 days ahead; when that finds nothing, the next open occurrences beyond the window are reached
 * in closed form, so a series that repeats every 2 years, starts far ahead or has next year's
 * occurrence deleted still gets its alert (null means "no alert ever", never "too far to look").
 */
export function nextReminder(
  task: Task,
  tz: string,
  afterMs: Millis,
): { at: Millis; origDate: ISODate | null; occDate: ISODate } | null {
  if (task == null || taskDate(task) === null) return null;
  const reminder = reminderOf(task);
  if (reminder.kind === 'none') return null;

  if (taskRule(task) === null) {
    const occ = singleOccurrence(task);
    if (occ.done || occ.date === null) return null;
    const at = reminderInstantFor({ date: occ.date, time: occ.time }, reminder, tz);
    return at !== null && at > afterMs ? { at, origDate: null, occDate: occ.date } : null;
  }

  // Default/offset reminders only fire for timed occurrences: an untimed series without any
  // per-occurrence time can never alert (the morning summary covers it).
  if (reminder.kind !== 'at' && !isHM(task.time as string) && !hasTimeOverride(task)) return null;

  // Occurrence dates whose reminder can still be > afterMs: an occurrence on day D alerts no
  // earlier than (D − daysBefore) 00:00 and no later than D 23:59 + |negative offset|.
  const afterDay = zonedToday(afterMs, tz);
  const mins = offsetMinutes(reminder);
  const lateSlack = mins < 0 ? Math.ceil(-mins / 1440) : 0;
  const from = addDaysClamped(afterDay, -1 - lateSlack);
  const to = addDaysClamped(afterDay, RECURRING_SEARCH_DAYS + daysBeforeOf(reminder));
  const best = earliestOnDays(occurrencesOfTask(task, from, to, false), reminder, tz, afterMs);
  if (best !== null) return best;

  // Past the window: jump straight to the next open occurrences (closed form, no day-by-day walk).
  // Every occurrence there alerts after afterMs (its day is > afterDay + 400 + daysBefore).
  let probe = to;
  for (let i = 0; i < FAR_PROBES && probe < MAX_ISO_DATE; i++) {
    const next = firstOpenOccurrenceFrom(task, addDaysClamped(probe, 1));
    if (next === null || next.date === null) return null;
    const found = earliestOnDays(occurrencesOfTask(task, next.date, next.date, false), reminder, tz, afterMs);
    if (found !== null) return found;
    probe = next.date;
  }
  return null;
}

const MAX_ISO_DATE = fromEpochDay(MAX_EPOCH_DAY);

/** True when some occurrence override gives the series a clock time. */
function hasTimeOverride(task: Task): boolean {
  const ov = task.overrides;
  if (ov == null || typeof ov !== 'object') return false;
  for (const k in ov) {
    if (!Object.prototype.hasOwnProperty.call(ov, k)) continue;
    const t = ov[k]?.time;
    if (typeof t === 'string' && isHM(t)) return true;
  }
  return false;
}

/** Earliest reminder instant > afterMs among `occs` (any order). */
function earliestOnDays(
  occs: Occurrence[],
  reminder: Reminder,
  tz: string,
  afterMs: Millis,
): { at: Millis; origDate: ISODate | null; occDate: ISODate } | null {
  occs.sort((a, b) => ((a.date ?? '') < (b.date ?? '') ? -1 : (a.date ?? '') > (b.date ?? '') ? 1 : 0));
  let best: { at: Millis; origDate: ISODate | null; occDate: ISODate } | null = null;
  for (const occ of occs) {
    if (occ.date === null) continue;
    // Instants are monotonic across days (one reminder rule; D+1 00:00 is always after D 23:59,
    // DST included), so once a later day starts nothing can beat what we already found.
    if (best !== null && occ.date > best.occDate) break;
    const at = reminderInstantFor({ date: occ.date, time: occ.time }, reminder, tz);
    if (at === null || at <= afterMs) continue;
    if (best === null || at < best.at) best = { at, origDate: occ.origDate, occDate: occ.date };
  }
  return best;
}

/** addDays that saturates at 0000-01-01 / 9999-12-31 instead of throwing. */
function addDaysClamped(d: ISODate, n: number): ISODate {
  const p = parseYMD(d);
  if (!p) return d;
  return fromEpochDay(Math.max(MIN_EPOCH_DAY, Math.min(MAX_EPOCH_DAY, daysFromCivil(p[0], p[1], p[2]) + n)));
}

export function computeRemindAt(task: Task, tz: string, nowMs: Millis): Millis | null {
  return nextReminder(task, tz, nowMs)?.at ?? null;
}

/**
 * remindAt is DERIVED and stored as its own field, so a field-level merge of edits made on two
 * devices (or a write computed from a stale offline copy) can leave it pointing at the wrong
 * instant. Given the stored value and the value computed from the merged document (from now, or —
 * by the scheduled function — from the moment the write landed, which may already be due), returns
 * what to repair it to, or undefined to leave it alone:
 *  - a stored value that is already due (≤ now) belongs to the scheduled tick (it sends or skips it);
 *  - a missing or too-LATE value is lowered to the computed one (left alone, its alert is lost);
 *  - a too-EARLY value is left alone: when it comes due, the tick finds no alert at that instant
 *    and moves it on without sending.
 */
export function repairedRemindAt(stored: Millis | null, computed: Millis | null, nowMs: Millis): Millis | undefined {
  if (computed === null) return undefined;
  if (stored !== null && stored <= nowMs) return undefined;
  return stored === null || stored > computed ? computed : undefined;
}

/** Next instant > afterMs at which settings.summary.time occurs in settings.timezone; null if disabled. */
export function nextSummaryAt(settings: Settings, afterMs: Millis): Millis | null {
  if (settings?.summary?.enabled !== true) return null;
  const time = isHM(settings.summary.time) ? settings.summary.time : '08:00';
  const tz = settings.timezone;
  const day = zonedToday(afterMs, tz);
  for (let i = 0; i <= 3; i++) {
    const at = zonedInstant(addDays(day, i), time, tz);
    if (at > afterMs) return at;
  }
  return null;
}

/** Open (not done) occurrences on `today` (incl. active multi-day) + overdue one-time tasks. */
function todayAndOverdue(tasks: Iterable<Task>, today: ISODate): { todays: Occurrence[]; overdue: number } {
  const list = Array.isArray(tasks) ? (tasks as Task[]) : [...tasks];
  const todays = occurrencesInRange(list, today, today);
  let overdue = 0;
  for (const t of list) {
    if (t == null || taskRule(t) !== null || taskDate(t) === null) continue;
    if (isOverdue(singleOccurrence(t), today)) overdue++;
  }
  return { todays, overdue };
}

/** Home-screen badge: today's open occurrences (incl. active multi-day) + overdue count. */
export function badgeCount(tasks: Iterable<Task>, today: ISODate): number {
  const { todays, overdue } = todayAndOverdue(tasks, today);
  return todays.length + overdue;
}

const MAX_TITLE_CHARS = 60;

function shortTitle(t: string): string {
  const s = t.trim().replace(/\s+/g, ' ');
  if (s === '') return 'Untitled';
  const chars = Array.from(s);
  return chars.length > MAX_TITLE_CHARS ? `${chars.slice(0, MAX_TITLE_CHARS - 1).join('').trimEnd()}…` : s;
}

/**
 * Morning summary push text.
 *  title: "Today · 4 tasks" | "Today · 1 task" | "Nothing planned today"
 *  body:  "Finish report, Call mom, Gym +1 more · 2 overdue" (first 3 in calendar order) |
 *         "2 overdue" (nothing today) | "" (nothing at all)
 */
export function summaryText(tasks: Iterable<Task>, today: ISODate): { title: string; body: string } {
  const { todays, overdue } = todayAndOverdue(tasks, today);
  todays.sort(compareInDay);
  const n = todays.length;
  const title = n > 0 ? `Today · ${n} ${n === 1 ? 'task' : 'tasks'}` : 'Nothing planned today';
  const parts: string[] = [];
  if (n > 0) {
    const names = todays.slice(0, 3).map((o) => shortTitle(o.title)).join(', ');
    parts.push(n > 3 ? `${names} +${n - 3} more` : names);
  }
  if (overdue > 0) parts.push(`${overdue} overdue`);
  return { title, body: parts.join(' · ') };
}
