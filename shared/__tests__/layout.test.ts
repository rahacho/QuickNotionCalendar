import { describe, expect, it } from 'vitest';
import { computeWeekRows, layoutWeek } from '../layout';
import { occurrencesInRange } from '../occurrences';
import { weekDates } from '../dates';
import type { Task, WeekBar } from '../types';
import { mkTask, randInt, refAddDays, rng, rule } from './helpers';

const WEEK = weekDates('2026-11-16'); // Mon 16 … Sun 22

function layoutFor(tasks: Task[], days = WEEK) {
  return layoutWeek(days, occurrencesInRange(tasks, days[0]!, days[6]!));
}

describe('layoutWeek — singles', () => {
  it('buckets single-day occurrences per day, sorted by compareInDay, with an entry for every day', () => {
    const l = layoutFor([
      mkTask({ id: 't', date: '2026-11-19', time: '10:00' }),
      mkTask({ id: 'u2', date: '2026-11-19', order: 'a2' }),
      mkTask({ id: 'u1', date: '2026-11-19', order: 'a1' }),
      mkTask({ id: 'sun', date: '2026-11-22' }),
      mkTask({ id: 'r', date: '2026-11-16', recurrence: rule('weekly', { byWeekday: [1, 3] }) }),
    ]);
    expect(Object.keys(l.singles)).toEqual(WEEK);
    expect(l.singles['2026-11-19']!.map((o) => o.key)).toEqual(['u1', 'u2', 't']);
    expect(l.singles['2026-11-22']!.map((o) => o.key)).toEqual(['sun']);
    expect(l.singles['2026-11-16']!.map((o) => o.key)).toEqual(['r@2026-11-16']);
    expect(l.singles['2026-11-18']!.map((o) => o.key)).toEqual(['r@2026-11-18']);
    expect(l.singles['2026-11-17']).toEqual([]);
    expect(l.bars).toEqual([]);
    expect(l.laneCount).toBe(0);
    expect(l.days).toBe(WEEK);
  });

  it('ignores occurrences outside the row and Inbox occurrences', () => {
    const occs = occurrencesInRange([mkTask({ id: 'x', date: '2026-11-30' })], '2026-11-01', '2026-12-31');
    const l = layoutWeek(WEEK, occs);
    expect(Object.values(l.singles).flat()).toEqual([]);
    expect(layoutWeek([], occs)).toEqual({ days: [], bars: [], laneCount: 0, singles: {} });
  });
});

describe('layoutWeek — bars', () => {
  it('computes columns and continuation flags across week boundaries', () => {
    const tasks = [
      mkTask({ id: 'inside', date: '2026-11-17', endDate: '2026-11-19' }),
      mkTask({ id: 'before', date: '2026-11-12', endDate: '2026-11-16' }),
      mkTask({ id: 'after', date: '2026-11-21', endDate: '2026-11-25' }),
      mkTask({ id: 'span', date: '2026-11-01', endDate: '2026-12-01' }),
    ];
    const l = layoutFor(tasks);
    const by = Object.fromEntries(l.bars.map((b) => [b.occ.key, b]));
    expect(by.inside).toMatchObject({ startCol: 1, endCol: 3, continuesBefore: false, continuesAfter: false });
    expect(by.before).toMatchObject({ startCol: 0, endCol: 0, continuesBefore: true, continuesAfter: false });
    expect(by.after).toMatchObject({ startCol: 5, endCol: 6, continuesBefore: false, continuesAfter: true });
    expect(by.span).toMatchObject({ startCol: 0, endCol: 6, continuesBefore: true, continuesAfter: true });
    // multi-day ones never appear as singles
    expect(Object.values(l.singles).flat()).toEqual([]);
  });

  it('packs greedily: start asc, longer first; non-overlapping bars share a lane', () => {
    const tasks = [
      mkTask({ id: 'A', date: '2026-11-16', endDate: '2026-11-17' }), // cols 0-1
      mkTask({ id: 'B', date: '2026-11-16', endDate: '2026-11-19' }), // cols 0-3 (longer → lane 0)
      mkTask({ id: 'C', date: '2026-11-18', endDate: '2026-11-20' }), // cols 2-4 → lane 1 (A ended)
      mkTask({ id: 'D', date: '2026-11-20', endDate: '2026-11-22' }), // cols 4-6 → lane 0 (B ended)
      mkTask({ id: 'E', date: '2026-11-21', endDate: '2026-11-22' }), // cols 5-6 → lane 1
    ];
    const l = layoutFor(tasks);
    expect(l.bars.map((b) => [b.occ.key, b.lane])).toEqual([
      ['B', 0],
      ['A', 1],
      ['C', 1],
      ['D', 0],
      ['E', 1],
    ]);
    expect(l.laneCount).toBe(2);
  });

  it('a bar that started in an earlier week takes the first lane (stable across rows)', () => {
    const tasks = [
      mkTask({ id: 'early', date: '2026-11-13', endDate: '2026-11-18' }),
      mkTask({ id: 'late', date: '2026-11-16', endDate: '2026-11-25' }),
    ];
    const w1 = layoutFor(tasks);
    expect(w1.bars.map((b) => [b.occ.key, b.lane])).toEqual([
      ['early', 0],
      ['late', 1],
    ]);
    const w2 = layoutFor(tasks, weekDates('2026-11-23'));
    expect(w2.bars.map((b) => [b.occ.key, b.lane, b.continuesBefore])).toEqual([['late', 0, true]]);
  });

  it('ties fall back to compareInDay (order, then key)', () => {
    const tasks = [
      mkTask({ id: 'y', date: '2026-11-17', endDate: '2026-11-18', order: 'a1' }),
      mkTask({ id: 'x', date: '2026-11-17', endDate: '2026-11-18', order: 'a2' }),
      mkTask({ id: 'w', date: '2026-11-17', endDate: '2026-11-18', order: 'a1' }),
    ];
    expect(layoutFor(tasks).bars.map((b) => b.occ.key)).toEqual(['w', 'y', 'x']);
  });

  it('works with Sunday-start rows', () => {
    const days = weekDates('2026-11-15');
    const l = layoutWeek(days, occurrencesInRange([mkTask({ id: 'm', date: '2026-11-21', endDate: '2026-11-22' })], days[0]!, days[6]!));
    expect(l.bars[0]).toMatchObject({ startCol: 6, endCol: 6, continuesAfter: true, continuesBefore: false });
  });
});

describe('layoutWeek — properties', () => {
  function overlaps(a: WeekBar, b: WeekBar): boolean {
    return a.startCol <= b.endCol && b.startCol <= a.endCol;
  }

  it('lanes never overlap, every overlapping occurrence is laid out once, lane count is minimal', () => {
    const r = rng(31);
    for (let trial = 0; trial < 200; trial++) {
      const tasks: Task[] = [];
      const n = randInt(r, 0, 25);
      for (let i = 0; i < n; i++) {
        const start = refAddDays('2026-11-16', randInt(r, -10, 8));
        tasks.push(mkTask({ id: `b${i}`, date: start, endDate: refAddDays(start, randInt(r, 1, 12)), order: `a${randInt(r, 0, 9)}` }));
      }
      for (let i = 0; i < 10; i++) tasks.push(mkTask({ id: `s${i}`, date: refAddDays('2026-11-16', randInt(r, -3, 9)) }));
      const occs = occurrencesInRange(tasks, '2026-11-16', '2026-11-22');
      const l = layoutWeek(WEEK, occs);

      for (let i = 0; i < l.bars.length; i++) {
        const a = l.bars[i]!;
        expect(a.startCol).toBeGreaterThanOrEqual(0);
        expect(a.endCol).toBeLessThanOrEqual(6);
        expect(a.startCol).toBeLessThanOrEqual(a.endCol);
        expect(a.lane).toBeLessThan(l.laneCount);
        for (let j = i + 1; j < l.bars.length; j++) {
          const b = l.bars[j]!;
          if (a.lane === b.lane) expect(overlaps(a, b)).toBe(false);
        }
      }
      const multi = occs.filter((o) => o.multiDay).map((o) => o.key).sort();
      expect(l.bars.map((b) => b.occ.key).sort()).toEqual(multi);
      const singles = occs.filter((o) => !o.multiDay).map((o) => o.key).sort();
      expect(Object.values(l.singles).flat().map((o) => o.key).sort()).toEqual(singles);
      // minimal: lane count equals the max number of bars covering one column
      let maxCover = 0;
      for (let c = 0; c < 7; c++) maxCover = Math.max(maxCover, l.bars.filter((b) => b.startCol <= c && c <= b.endCol).length);
      expect(l.laneCount).toBe(maxCover);
    }
  });
});

describe('computeWeekRows', () => {
  it('returns week starts around the anchor', () => {
    expect(computeWeekRows('2026-11-19', 1, 2, 1)).toEqual(['2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30']);
    expect(computeWeekRows('2026-11-19', 0, 0, 0)).toEqual(['2026-11-15']);
    expect(computeWeekRows('2026-11-22', 0, 0, 1)).toEqual(['2026-11-16']);
    expect(computeWeekRows('2026-11-22', 0, 0, 0)).toEqual(['2026-11-22']);
    expect(computeWeekRows('2026-11-19', -3, -1, 1)).toEqual(['2026-11-16']);
  });

  it('spans year boundaries and has the right length', () => {
    const rows = computeWeekRows('2026-12-31', 10, 10, 1);
    expect(rows).toHaveLength(21);
    expect(rows[10]).toBe('2026-12-28');
    expect(rows[11]).toBe('2027-01-04');
    for (let i = 1; i < rows.length; i++) expect(refAddDays(rows[i - 1]!, 7)).toBe(rows[i]);
  });
});
