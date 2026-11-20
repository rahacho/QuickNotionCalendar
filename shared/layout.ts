/**
 * Month/week grid layout for one week row: multi-day bars lane-packed across columns, single-day
 * cards bucketed per day. `days` must be consecutive dates (as produced by weekDates).
 */
import { fromEpochDay, startOfWeek, toEpochDay } from './dates.js';
import { compareInDay } from './ordering.js';
import type { ISODate, Occurrence, WeekBar, WeekLayout } from './types.js';

function byBarOrder(a: Occurrence, b: Occurrence): number {
  const da = a.date ?? '';
  const db = b.date ?? '';
  if (da !== db) return da < db ? -1 : 1;
  const ea = a.endDate ?? '';
  const eb = b.endDate ?? '';
  if (ea !== eb) return ea > eb ? -1 : 1; // longer first
  return compareInDay(a, b);
}

/**
 * - Multi-day occurrences overlapping the row become bars, sorted by start asc, longer first, then
 *   compareInDay, and packed greedily into the first lane that is free at their start column.
 *   Because they are processed in start order this uses the minimum number of lanes, and a bar
 *   that started in an earlier row keeps a stable relative order across rows.
 * - continuesBefore/After flag bars that extend past the row's first/last day.
 * - Single-day occurrences on a row day → singles[date], sorted by compareInDay. Every row day has
 *   an entry (possibly empty). Occurrences not touching the row are ignored.
 */
export function layoutWeek(days: ISODate[], occurrences: Occurrence[]): WeekLayout {
  const singles: Record<ISODate, Occurrence[]> = {};
  for (const d of days) singles[d] = [];
  if (days.length === 0) return { days, bars: [], laneCount: 0, singles };

  const first = days[0] as ISODate;
  const last = days[days.length - 1] as ISODate;
  const firstE = toEpochDay(first);
  const lastCol = days.length - 1;

  const multi: Occurrence[] = [];
  for (const occ of occurrences) {
    if (occ.date == null) continue;
    const end = occ.endDate != null && occ.endDate > occ.date ? occ.endDate : occ.date;
    if (end > occ.date) {
      if (occ.date <= last && end >= first) multi.push(occ);
    } else {
      const bucket = singles[occ.date];
      if (bucket) bucket.push(occ);
    }
  }
  for (const d of days) singles[d]?.sort(compareInDay);

  multi.sort(byBarOrder);
  const laneEnds: number[] = []; // last occupied column per lane
  const bars: WeekBar[] = [];
  for (const occ of multi) {
    const start = occ.date as ISODate;
    const end = occ.endDate as ISODate;
    const startCol = Math.max(0, toEpochDay(start) - firstE);
    const endCol = Math.min(lastCol, toEpochDay(end) - firstE);
    let lane = laneEnds.findIndex((e) => e < startCol);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(endCol);
    } else {
      laneEnds[lane] = endCol;
    }
    bars.push({
      occ,
      startCol,
      endCol,
      lane,
      continuesBefore: start < first,
      continuesAfter: end > last,
    });
  }
  return { days, bars, laneCount: laneEnds.length, singles };
}

/**
 * Week-start dates of the rows around `anchor`: weeksBefore rows above the anchor's week, the
 * anchor's week, and weeksAfter rows below (negative counts are treated as 0).
 */
export function computeWeekRows(anchor: ISODate, weeksBefore: number, weeksAfter: number, weekStart: 0 | 1): ISODate[] {
  const before = Number.isFinite(weeksBefore) ? Math.max(0, Math.floor(weeksBefore)) : 0;
  const after = Number.isFinite(weeksAfter) ? Math.max(0, Math.floor(weeksAfter)) : 0;
  const base = toEpochDay(startOfWeek(anchor, weekStart));
  const out: ISODate[] = [];
  for (let i = -before; i <= after; i++) out.push(fromEpochDay(base + i * 7));
  return out;
}

