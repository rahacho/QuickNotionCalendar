/**
 * Calendar-date math on floating "YYYY-MM-DD" strings.
 *
 * Every ISODate operation converts to an integer "epoch day" (days since 1970-01-01 in the
 * proleptic Gregorian calendar) with pure integer arithmetic, so results never depend on the
 * host time zone or DST. Only `toISODate`, `parseISODate` and `todayISO` touch local time,
 * because their whole purpose is to bridge to JS `Date` objects in the device's zone.
 *
 * Invalid inputs (malformed dates, non-integer day counts, invalid HM strings) throw a
 * `RangeError`: these are programming errors, and failing loudly beats silently producing
 * "NaN-NaN-NaN". Data coming from storage is sanitized in occurrences.ts before it gets here.
 */
import type { HM, ISODate, Weekday } from './types.js';

/** Smallest / largest representable ISODate ("0000-01-01" … "9999-12-31") as epoch days. */
export const MIN_EPOCH_DAY = -719_528;
export const MAX_EPOCH_DAY = 2_932_896;

const HM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

const DIGIT_POSITIONS = [0, 1, 2, 3, 5, 6, 8, 9] as const;

const DIM = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function dim(y: number, m: number): number {
  return m === 2 && isLeap(y) ? 29 : (DIM[m - 1] ?? 31);
}

/**
 * Parses "YYYY-MM-DD" into [year, month1, day] or returns null when malformed / not a real
 * calendar date. Hand-rolled (no regex) because it sits on every hot path.
 */
export function parseYMD(s: string): [number, number, number] | null {
  if (typeof s !== 'string' || s.length !== 10 || s.charCodeAt(4) !== 45 || s.charCodeAt(7) !== 45) return null;
  for (const i of DIGIT_POSITIONS) if (!isDigit(s.charCodeAt(i))) return null;
  const y =
    (s.charCodeAt(0) - 48) * 1000 + (s.charCodeAt(1) - 48) * 100 + (s.charCodeAt(2) - 48) * 10 + (s.charCodeAt(3) - 48);
  const m = (s.charCodeAt(5) - 48) * 10 + (s.charCodeAt(6) - 48);
  const d = (s.charCodeAt(8) - 48) * 10 + (s.charCodeAt(9) - 48);
  if (m < 1 || m > 12 || d < 1 || d > dim(y, m)) return null;
  return [y, m, d];
}

function ymdOrThrow(s: ISODate): [number, number, number] {
  const p = parseYMD(s);
  if (!p) throw new RangeError(`Invalid ISODate: ${String(s)}`);
  return p;
}

/** Days since 1970-01-01 for a proleptic-Gregorian Y-M-D (H. Hinnant's days_from_civil). */
export function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

/** Inverse of daysFromCivil → [year, month1, day]. */
export function civilFromDays(n: number): [number, number, number] {
  const z = n + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return [y, m, d];
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function pad4(n: number): string {
  return String(n).padStart(4, '0');
}

/** Formats a Y-M-D triple as "YYYY-MM-DD" (no validation). */
export function ymdToISO(y: number, m: number, d: number): ISODate {
  return `${pad4(y)}-${pad2(m)}-${pad2(d)}`;
}

/** ISODate → epoch day (throws RangeError on malformed input). */
export function toEpochDay(d: ISODate): number {
  const [y, m, day] = ymdOrThrow(d);
  return daysFromCivil(y, m, day);
}

/** Epoch day → ISODate (throws RangeError outside 0000-01-01 … 9999-12-31). */
export function fromEpochDay(n: number): ISODate {
  if (!Number.isInteger(n) || n < MIN_EPOCH_DAY || n > MAX_EPOCH_DAY) {
    throw new RangeError(`Epoch day out of range: ${n}`);
  }
  const [y, m, d] = civilFromDays(n);
  return ymdToISO(y, m, d);
}

/** Local calendar date of a JS Date. */
export function toISODate(d: Date): ISODate {
  const t = d.getTime();
  if (Number.isNaN(t)) throw new RangeError('Invalid Date');
  return ymdToISO(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/**
 * Local midnight of the date (or the first existing local instant of that day in zones that
 * skip midnight for DST). Years 0–99 are handled correctly (no 19xx mapping).
 */
export function parseISODate(s: ISODate): Date {
  const [y, m, d] = ymdOrThrow(s);
  const out = new Date(2000, 0, 1, 0, 0, 0, 0);
  out.setFullYear(y, m - 1, d);
  out.setHours(0, 0, 0, 0);
  return out;
}

export function isValidISODate(s: string): boolean {
  return parseYMD(s) !== null;
}

function intOrThrow(n: number, what: string): number {
  if (!Number.isInteger(n)) throw new RangeError(`${what} must be an integer, got ${n}`);
  return n;
}

export function addDays(d: ISODate, n: number): ISODate {
  return fromEpochDay(toEpochDay(d) + intOrThrow(n, 'Day count'));
}

/** Adds calendar months, clamping the day to the target month's last day (Jan 31 + 1 → Feb 28/29). */
export function addMonths(d: ISODate, n: number): ISODate {
  const [y, m, day] = ymdOrThrow(d);
  const total = y * 12 + (m - 1) + intOrThrow(n, 'Month count');
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12 + 1;
  if (ny < 0 || ny > 9999) throw new RangeError(`Year out of range: ${ny}`);
  return ymdToISO(ny, nm, Math.min(day, dim(ny, nm)));
}

/** a − b in whole days. */
export function diffDays(a: ISODate, b: ISODate): number {
  return toEpochDay(a) - toEpochDay(b);
}

/** Valid ISODates sort lexicographically, so a plain code-unit comparison is exact. */
export function compareDates(a: ISODate, b: ISODate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function minDate(a: ISODate, b: ISODate): ISODate {
  return a <= b ? a : b;
}

export function maxDate(a: ISODate, b: ISODate): ISODate {
  return a >= b ? a : b;
}

/** Weekday from an epoch day (1970-01-01 was a Thursday). */
export function weekdayOfEpochDay(n: number): Weekday {
  return ((((n + 4) % 7) + 7) % 7) as Weekday;
}

export function weekday(d: ISODate): Weekday {
  return weekdayOfEpochDay(toEpochDay(d));
}

/** First day of the week containing `d` (weekStart 1 = Monday, 0 = Sunday). */
export function startOfWeek(d: ISODate, weekStart: 0 | 1): ISODate {
  const n = toEpochDay(d);
  const back = (weekdayOfEpochDay(n) - weekStart + 7) % 7;
  return fromEpochDay(n - back);
}

export function startOfMonth(d: ISODate): ISODate {
  const [y, m] = ymdOrThrow(d);
  return ymdToISO(y, m, 1);
}

export function endOfMonth(d: ISODate): ISODate {
  const [y, m] = ymdOrThrow(d);
  return ymdToISO(y, m, dim(y, m));
}

/** Number of days in a month (month1 = 1…12). */
export function daysInMonth(year: number, month1: number): number {
  if (!Number.isInteger(year) || !Number.isInteger(month1) || month1 < 1 || month1 > 12) {
    throw new RangeError(`Invalid year/month: ${year}-${month1}`);
  }
  return dim(year, month1);
}

/** Every date from `from` to `to`, inclusive. Empty when from > to. */
export function eachDay(from: ISODate, to: ISODate): ISODate[] {
  const a = toEpochDay(from);
  const b = toEpochDay(to);
  const out: ISODate[] = [];
  for (let n = a; n <= b; n++) out.push(fromEpochDay(n));
  return out;
}

/** The 7 consecutive dates starting at `weekStartDate`. */
export function weekDates(weekStartDate: ISODate): ISODate[] {
  const a = toEpochDay(weekStartDate);
  const out: ISODate[] = [];
  for (let i = 0; i < 7; i++) out.push(fromEpochDay(a + i));
  return out;
}

/** Strict 24h "HH:mm" (00:00–23:59, zero-padded). */
export function isHM(s: string): boolean {
  return typeof s === 'string' && HM_RE.test(s);
}

export function hmToMinutes(t: HM): number {
  const m = typeof t === 'string' ? HM_RE.exec(t) : null;
  if (!m) throw new RangeError(`Invalid HM: ${String(t)}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Minutes since midnight → "HH:mm". Values outside 0…1439 wrap around the clock
 * (1500 → "01:00", -30 → "23:30"); fractional minutes are floored.
 */
export function minutesToHM(m: number): HM {
  if (!Number.isFinite(m)) throw new RangeError(`Invalid minutes: ${m}`);
  const v = ((Math.floor(m) % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(v / 60))}:${pad2(v % 60)}`;
}

/** The device's local calendar date (now by default). */
export function todayISO(now?: Date): ISODate {
  return toISODate(now ?? new Date());
}
