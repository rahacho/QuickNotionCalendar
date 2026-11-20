/**
 * Deterministic en-US formatting/parsing with Notion's wording. Month and weekday names are
 * hand-rolled so output never depends on the runtime's Intl locale data (service worker,
 * Cloud Functions and every browser render identical strings).
 *
 * Formatters are display helpers: given an invalid date/time they return '' instead of
 * throwing, so a single bad value can never take down a render.
 */
import { addDays, daysFromCivil, isHM, parseYMD, weekdayOfEpochDay, ymdToISO } from './dates.js';
import type { HM, ISODate, Reminder } from './types.js';

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;
export const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
/** Indexed by Weekday (0 = Sunday). */
export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

function monthLong(m: number): string {
  return MONTH_NAMES[m - 1] ?? '';
}

function monthShort(m: number): string {
  return MONTH_SHORT[m - 1] ?? '';
}

/** "3:00 PM", "12:00 PM", "12:30 AM", "9:05 AM". Invalid input → ''. */
export function formatTime(t: HM): string {
  if (!isHM(t)) return '';
  const h = Number(t.slice(0, 2));
  const mm = t.slice(3, 5);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${mm} ${h < 12 ? 'AM' : 'PM'}`;
}

const TIME_RE = /^(\d{1,4})(?:[:.](\d{2}))?\s*(a|p|am|pm|a\.m\.?|p\.m\.?)?$/;

/**
 * Lenient time entry → "HH:mm" or null.
 * Accepts: "3pm", "3 PM", "3:30 pm", "3.30pm", "15:00", "1530", "930", "9", "0930", "12am" (→ 00:00),
 * "12pm" (→ 12:00), "noon", "midnight", "3p", "3 p.m.".
 * Bare numbers without am/pm are 24-hour ("9" → 09:00, "21" → 21:00). With am/pm the hour must be 1–12.
 */
export function parseTimeInput(s: string): HM | null {
  if (typeof s !== 'string') return null;
  const v = s.trim().toLowerCase().replace(/\s+/g, ' ');
  if (v === '') return null;
  if (v === 'noon' || v === 'midday') return '12:00';
  if (v === 'midnight') return '00:00';
  const m = TIME_RE.exec(v);
  if (!m) return null;
  const digits = m[1] ?? '';
  let h: number;
  let min: number;
  if (m[2] !== undefined) {
    if (digits.length > 2) return null; // "123:45"
    h = Number(digits);
    min = Number(m[2]);
  } else if (digits.length <= 2) {
    h = Number(digits);
    min = 0;
  } else {
    // "930" → 9:30, "1530" → 15:30
    h = Number(digits.slice(0, digits.length - 2));
    min = Number(digits.slice(-2));
  }
  if (min > 59) return null;
  const mer = m[3];
  if (mer !== undefined) {
    if (h < 1 || h > 12) return null;
    const pm = mer.startsWith('p');
    if (pm) h = h === 12 ? 12 : h + 12;
    else h = h === 12 ? 0 : h;
  } else if (h > 23) {
    return null;
  }
  return `${h < 10 ? '0' : ''}${h}:${min < 10 ? '0' : ''}${min}`;
}

/** "November 19, 2026" */
export function formatDateLong(d: ISODate): string {
  const p = parseYMD(d);
  if (!p) return '';
  return `${monthLong(p[1])} ${p[2]}, ${p[0]}`;
}

/** "Nov 19" */
export function formatDateShort(d: ISODate): string {
  const p = parseYMD(d);
  if (!p) return '';
  return `${monthShort(p[1])} ${p[2]}`;
}

/** "Nov 19, 2026" */
export function formatDateMedium(d: ISODate): string {
  const p = parseYMD(d);
  if (!p) return '';
  return `${monthShort(p[1])} ${p[2]}, ${p[0]}`;
}

/** "Thu, Nov 19" */
export function formatWeekdayShort(d: ISODate): string {
  const p = parseYMD(d);
  if (!p) return '';
  const wd = weekdayOfEpochDay(daysFromCivil(p[0], p[1], p[2]));
  return `${WEEKDAY_SHORT[wd]}, ${monthShort(p[1])} ${p[2]}`;
}

/** "November 2026" */
export function formatMonthYear(d: ISODate): string {
  const p = parseYMD(d);
  if (!p) return '';
  return `${monthLong(p[1])} ${p[0]}`;
}

/**
 * "Nov 19 → 21" (same month), "Nov 30 → Dec 2" (same year), "Dec 30, 2026 → Jan 2, 2027" (across years).
 * A single-day range renders as "Nov 19". Reversed arguments are swapped (never renders backwards).
 */
export function formatRange(start: ISODate, end: ISODate): string {
  const a0 = parseYMD(start);
  const b0 = parseYMD(end);
  if (!a0 || !b0) return a0 ? formatDateShort(start) : b0 ? formatDateShort(end) : '';
  const [a, b] = start <= end ? [a0, b0] : [b0, a0];
  if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) return `${monthShort(a[1])} ${a[2]}`;
  if (a[0] !== b[0]) return `${monthShort(a[1])} ${a[2]}, ${a[0]} → ${monthShort(b[1])} ${b[2]}, ${b[0]}`;
  if (a[1] === b[1]) return `${monthShort(a[1])} ${a[2]} → ${b[2]}`;
  return `${monthShort(a[1])} ${a[2]} → ${monthShort(b[1])} ${b[2]}`;
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** "10 minutes" | "1 hour" | "2 days" | "1 week" for a positive minute count. */
function durationLabel(minutes: number): string {
  if (minutes % 10_080 === 0) return plural(minutes / 10_080, 'week');
  if (minutes % 1440 === 0) return plural(minutes / 1440, 'day');
  if (minutes % 60 === 0) return plural(minutes / 60, 'hour');
  return plural(minutes, 'minute');
}

/**
 * Notion-style reminder label.
 *  - default: timed → "At time of task"; untimed → "Default" (no individual alert; the morning summary covers it)
 *  - none → "None"
 *  - offset: timed → "At time of task" (0) | "10 minutes before" | "1 hour before" | "1 day before" | "1 week before";
 *            untimed → "Default" (an offset needs a time, so it behaves exactly like default — see types.ts)
 *  - at: "On day (9:00 AM)" | "1 day before (9:00 AM)" | "2 days before (9:00 AM)"
 */
export function formatReminder(r: Reminder, timed: boolean): string {
  switch (r?.kind) {
    case 'none':
      return 'None';
    case 'offset': {
      if (!timed) return 'Default';
      const mins = Number.isFinite(r.minutes) ? Math.round(r.minutes) : 0;
      if (mins === 0) return 'At time of task';
      return `${durationLabel(Math.abs(mins))} ${mins > 0 ? 'before' : 'after'}`;
    }
    case 'at': {
      const days = Number.isFinite(r.daysBefore) ? Math.max(0, Math.floor(r.daysBefore)) : 0;
      const t = formatTime(r.time);
      const when = days === 0 ? 'On day' : `${plural(days, 'day')} before`;
      return t ? `${when} (${t})` : when;
    }
    case 'default':
    default:
      return timed ? 'At time of task' : 'Default';
  }
}

const WEEKDAY_WORDS: ReadonlyArray<readonly [string, number]> = [
  ['sunday', 0],
  ['monday', 1],
  ['tuesday', 2],
  ['wednesday', 3],
  ['thursday', 4],
  ['friday', 5],
  ['saturday', 6],
];

/** Weekday from a name or any unambiguous prefix of at least 2 letters ("fr", "thu", "tues", "thurs"). */
function matchWeekday(word: string): number | null {
  const w = word.replace(/\.$/, '');
  if (w.length < 2) return null;
  for (const [name, wd] of WEEKDAY_WORDS) if (name.startsWith(w)) return wd;
  return null;
}

function matchMonth(word: string): number | null {
  const w = word.replace(/\.$/, '');
  if (w.length < 3) return null;
  if (w === 'sept') return 9;
  for (let i = 0; i < 12; i++) {
    const name = (MONTH_NAMES[i] ?? '').toLowerCase();
    if (name.startsWith(w)) return i + 1;
  }
  return null;
}

function validYMD(y: number, m: number, d: number): ISODate | null {
  if (!Number.isInteger(y) || y < 0 || y > 9999) return null;
  const iso = ymdToISO(y, m, d);
  return parseYMD(iso) ? iso : null;
}

/** How far back a year-less date may land before it rolls to next year. */
const YEARLESS_LOOKBACK_DAYS = 31;

/**
 * Month/day without a year → the earliest matching date on or after (today − 31 days).
 * Planning is forward-looking: "Jan 5" or "Sep 3" typed in late November means next year,
 * while "Nov 10" (a recent date, e.g. back-dating) stays in this year. Feb 29 → next leap year.
 */
function yearlessDate(m: number, d: number, today: ISODate): ISODate | null {
  const t = parseYMD(today);
  if (!t) return null;
  const minDay = daysFromCivil(t[0], t[1], t[2]) - YEARLESS_LOOKBACK_DAYS;
  for (let dy = -1; dy <= 8; dy++) {
    const iso = validYMD(t[0] + dy, m, d);
    if (iso && daysFromCivil(t[0] + dy, m, d) >= minDay) return iso;
  }
  return null;
}

function fullYear(y: string): number {
  const n = Number(y);
  return y.length <= 2 ? 2000 + n : n;
}

/**
 * Lenient date entry → ISODate or null. Accepts:
 *  "today", "tomorrow"/"tmr"/"tmrw", "yesterday";
 *  weekday names/abbreviations ("fri", "Friday") → that weekday on or after today;
 *  "Nov 19", "November 19", "Nov 19, 2026", "Nov 19 2026", "19 Nov", "19 November 2026";
 *  "11/19", "11/19/2026", "11/19/26", "11-19-2026"; ISO "2026-11-19", "2026/11/19".
 * Dates without a year resolve forward (see yearlessDate).
 */
export function parseDateInput(s: string, today: ISODate): ISODate | null {
  if (typeof s !== 'string' || !parseYMD(today)) return null;
  const v = s.trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  if (v === '') return null;
  if (v === 'today' || v === 'tod' || v === 'now') return today;
  if (v === 'tomorrow' || v === 'tmr' || v === 'tmrw' || v === 'tom' || v === 'tomo') return addDays(today, 1);
  if (v === 'yesterday') return addDays(today, -1);

  // ISO / Y-M-D with - or /
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(v);
  if (m) return validYMD(Number(m[1]), Number(m[2]), Number(m[3]));

  // M/D(/Y) or M-D-Y
  m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/.exec(v);
  if (m) {
    const mo = Number(m[1]);
    const d = Number(m[2]);
    if (mo < 1 || mo > 12) return null;
    return m[3] !== undefined ? validYMD(fullYear(m[3]), mo, d) : yearlessDate(mo, d, today);
  }

  // "Nov 19 (2026)" / "November 19th"
  m = /^([a-z]+\.?) (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/.exec(v);
  if (m) {
    const mo = matchMonth(m[1] ?? '');
    if (mo === null) return null;
    const d = Number(m[2]);
    return m[3] !== undefined ? validYMD(Number(m[3]), mo, d) : yearlessDate(mo, d, today);
  }

  // "19 Nov (2026)"
  m = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+\.?)(?: (\d{4}))?$/.exec(v);
  if (m) {
    const mo = matchMonth(m[2] ?? '');
    if (mo === null) return null;
    const d = Number(m[1]);
    return m[3] !== undefined ? validYMD(Number(m[3]), mo, d) : yearlessDate(mo, d, today);
  }

  // Weekday → on or after today
  if (/^[a-z]+\.?$/.test(v)) {
    const wd = matchWeekday(v);
    if (wd === null) return null;
    const t = parseYMD(today);
    if (!t) return null;
    const cur = weekdayOfEpochDay(daysFromCivil(t[0], t[1], t[2]));
    return addDays(today, (wd - cur + 7) % 7);
  }
  return null;
}
